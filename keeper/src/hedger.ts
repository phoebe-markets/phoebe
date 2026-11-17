#!/usr/bin/env bun
/**
 * Market maker / hedger for KeeperVenue on Polygon mainnet (Path B, NOTES.md).
 *
 * The protocol trades against this wallet's inventory at oracle +/- spread. The wallet stays roughly market-neutral:
 *   - Inventory is stocked WITHOUT trading: the CtfCollateralAdapter splits pUSD into equal YES + NO shares (and
 *     merges pairs back). Holding YES and NO in equal amounts is flat: worth exactly $1 per pair whatever happens.
 *   - When the protocol buys YES from us (a trader opens a YES long), we're left long NO. Exposure = YES - NO shares.
 *     Once |exposure| passes a band, flatten it on the Polymarket CLOB: BUY the short side (or, if pUSD is short,
 *     SELL the long side), FOK, at most `slippage` worse than the top of book.
 *   - If Polymarket is unreachable, we're geoblocked, or unhedged exposure is over the limit, the venue is switched
 *     off (KeeperVenue.setActive(false), callable by the maker) so the protocol stops trading against stale risk.
 *
 * The keeper runs `Hedger.tick()` in its live loop when the deployment uses the real CTF (one process, one key, so
 * transactions never race on nonces). This file is also a CLI for setup and manual operations:
 *
 *   DEPLOYMENT=polygon RPC_URL=... KEEPER_PK=... bun keeper/src/hedger.ts status
 *   ... hedger.ts setup --yes                # approve pUSD + CTF to the exchange and the adapter
 *   ... hedger.ts split <market> <usd> --yes # pUSD -> YES + NO inventory
 *   ... hedger.ts merge <market> <shares|all> --yes
 *   ... hedger.ts unwrap <usd> --yes         # pUSD -> USDC.e (offramp)
 *   ... hedger.ts tick [--live]              # one hedging pass; without --live it only logs what it would do
 *   ... hedger.ts geo                        # what Polymarket sees (country, blocked?)
 *   --ssh <host> / --socks <host:port> route Polymarket API traffic (see polymarket.ts)
 *
 * Limits (env, defaults for the low-dollar launch): HEDGE_BAND_SHARES 5, HEDGE_SLIPPAGE 0.02, HEDGE_MAX_ORDER_USD 25,
 * HEDGE_DAILY_CAP_USD 200, INVENTORY_TARGET_SHARES 60, INVENTORY_FLOOR_SHARES 25, PUSD_RESERVE_USD 40,
 * MAX_EXPOSURE_USD 40, HEDGE_COOLDOWN_SECONDS 120.
 */
import { formatUnits, maxUint256, parseUnits, type Address, type Hex } from "viem";
import { OrderType, Side, type ClobClient, type OrderBookSummary } from "@polymarket/clob-client-v2";
import { ABI_EXTRA, alert, clients, loadDeployment, log, noId, send, yesId, type Clients, type Deployment } from "./config";
import {
  ADAPTER_ABI,
  CTF_ABI,
  CTF_ADAPTER,
  ERC20_ABI,
  EXCHANGE_V2,
  OFFRAMP,
  PARTITION,
  RAMP_ABI,
  USDCE,
  clobClient,
  depthTo,
  geoblock,
  setupEgress,
  topOfBook,
} from "./polymarket";

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const n6 = (x: bigint) => Number(x) / 1e6;
const u6 = (x: number) => parseUnits(x.toFixed(6), 6);
const usd = (x: number) => `$${x.toFixed(2)}`;

export type HedgerConfig = {
  live: boolean;
  bandShares: number;
  slippage: number;
  maxOrderUsd: number;
  dailyCapUsd: number;
  targetShares: number;
  floorShares: number;
  reserveUsd: number;
  maxExposureUsd: number;
  cooldownMs: number;
};

export function configFromEnv(live: boolean): HedgerConfig {
  return {
    live,
    bandShares: env("HEDGE_BAND_SHARES", 5),
    slippage: env("HEDGE_SLIPPAGE", 0.02),
    maxOrderUsd: env("HEDGE_MAX_ORDER_USD", 25),
    dailyCapUsd: env("HEDGE_DAILY_CAP_USD", 200),
    targetShares: env("INVENTORY_TARGET_SHARES", 60),
    floorShares: env("INVENTORY_FLOOR_SHARES", 25),
    reserveUsd: env("PUSD_RESERVE_USD", 40),
    maxExposureUsd: env("MAX_EXPOSURE_USD", 40),
    cooldownMs: env("HEDGE_COOLDOWN_SECONDS", 120) * 1000,
  };
}

type Market = {
  i: number;
  name: string;
  yes: bigint;
  no: bigint;
  cond: Hex;
  Y: bigint; // our YES shares (6 dp)
  N: bigint; // our NO shares
  yesBook: OrderBookSummary;
  noBook: OrderBookSummary;
  mid: number; // YES mid
};

/** A planned CLOB order (size in shares). */
export type Plan = { market: number; token: "YES" | "NO"; side: "BUY" | "SELL"; shares: number; limit: number; usd: number };

/** Round a price to the book's tick, toward the worse side for us (so the limit is never better than intended). */
function toTick(p: number, tick: string, up: boolean) {
  const t = Number(tick);
  const k = up ? Math.ceil(p / t - 1e-9) : Math.floor(p / t + 1e-9);
  return Math.min(1 - t, Math.max(t, k * t));
}

/**
 * Pure decision: how to flatten one market's exposure given books, free pUSD and remaining caps. Exported for tests.
 * Returns undefined when inside the band or when the capped size is below the book's minimum.
 */
export function planHedge(
  m: Pick<Market, "i" | "Y" | "N" | "yesBook" | "noBook">,
  freeUsd: number,
  capUsd: number,
  cfg: Pick<HedgerConfig, "bandShares" | "slippage" | "maxOrderUsd">,
): Plan | undefined {
  const exposure = n6(m.Y - m.N); // < 0: short YES (long NO)
  if (Math.abs(exposure) < cfg.bandShares) return undefined;
  const short = exposure < 0 ? "YES" : "NO";
  const long = short === "YES" ? "NO" : "YES";
  const shortBook = short === "YES" ? m.yesBook : m.noBook;
  const longBook = long === "YES" ? m.yesBook : m.noBook;

  // Prefer buying the short side (keeps both inventories stocked); sell the long side if pUSD is tight.
  const st = topOfBook(shortBook);
  const buyLimit = toTick(st.ask + cfg.slippage, st.tick, true);
  let shares = Math.min(Math.abs(exposure), cfg.maxOrderUsd / buyLimit, capUsd / buyLimit, depthTo(shortBook, "BUY", buyLimit));
  if (shares * buyLimit <= freeUsd && shares >= st.minSize) {
    shares = Math.floor(shares * 100) / 100;
    return { market: m.i, token: short, side: "BUY", shares, limit: buyLimit, usd: shares * buyLimit };
  }
  const lt = topOfBook(longBook);
  const sellLimit = toTick(lt.bid - cfg.slippage, lt.tick, false);
  const px = Math.max(sellLimit, 0.01);
  shares = Math.min(Math.abs(exposure), cfg.maxOrderUsd / px, capUsd / px, depthTo(longBook, "SELL", sellLimit));
  shares = Math.floor(shares * 100) / 100;
  if (shares < lt.minSize) return undefined;
  return { market: m.i, token: long, side: "SELL", shares, limit: sellLimit, usd: shares * sellLimit };
}

export class Hedger {
  private clob?: ClobClient;
  private spent = { day: "", usd: 0 };
  private cooldownUntil = new Map<number, number>();
  private extra = ABI_EXTRA();
  private planned = new Set<number>(); // dry run: markets with a hedge we only logged
  private dryLogged = new Map<string, number>();
  readonly adapter: Address;

  constructor(
    private c: Clients,
    private d: Deployment,
    readonly cfg: HedgerConfig,
  ) {
    if (!d.tokenIds || !d.conditionIds) throw new Error("deployment has no tokenIds/conditionIds (redeploy with the current script)");
    this.adapter = d.mockCtf === false ? CTF_ADAPTER : d.ctf; // MockCTF plays the adapter on testnets
  }

  /** Dry-run log line, repeated at most every 10 minutes. */
  private dry(what: string) {
    if ((this.dryLogged.get(what) ?? 0) > Date.now() - 600_000) return;
    this.dryLogged.set(what, Date.now());
    log(`hedger [dry run] would ${what}`);
  }

  private get me() {
    return this.c.account.address;
  }

  async init() {
    // Reading books needs no credentials; posting does (derived from the key, which registers it with Polymarket).
    this.clob = await clobClient(this.c.wallet, { deriveCreds: this.cfg.live });
  }

  private spentToday() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.spent.day !== day) this.spent = { day, usd: 0 };
    return this.spent.usd;
  }

  async pusd() {
    return (await this.c.pub.readContract({ address: this.d.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [this.me] })) as bigint;
  }

  async markets(): Promise<Market[]> {
    if (!this.clob) await this.init();
    return Promise.all(
      Array.from({ length: this.d.markets }, async (_, i) => {
        const yes = yesId(this.d, i);
        const no = noId(this.d, i);
        const [Y, N, yesBook, noBook] = await Promise.all([
          this.c.pub.readContract({ address: this.d.ctf, abi: CTF_ABI, functionName: "balanceOf", args: [this.me, yes] }) as Promise<bigint>,
          this.c.pub.readContract({ address: this.d.ctf, abi: CTF_ABI, functionName: "balanceOf", args: [this.me, no] }) as Promise<bigint>,
          this.clob!.getOrderBook(yes.toString()),
          this.clob!.getOrderBook(no.toString()),
        ]);
        const t = topOfBook(yesBook);
        return { i, name: this.d.names?.[i] ?? `market ${i}`, yes, no, cond: this.d.conditionIds![i], Y, N, yesBook, noBook, mid: (t.bid + t.ask) / 2 };
      }),
    );
  }

  /** One pass: hedge each market, keep inventory stocked, and switch the venue off if risk can't be managed. */
  async tick() {
    const problems: string[] = [];
    let ms: Market[] = [];
    let free = 0;
    try {
      const g = await geoblock();
      if (g.blocked) problems.push(`Polymarket geoblocks this egress (${g.country ?? "?"})`);
      ms = await this.markets();
      free = n6(await this.pusd()) - this.cfg.reserveUsd;
    } catch (e) {
      problems.push(`Polymarket unreachable: ${(e as Error).message.split("\n")[0]}`);
    }

    if (problems.length === 0) {
      for (const m of ms) {
        const pending = (this.cooldownUntil.get(m.i) ?? 0) > Date.now();
        const spent = pending ? 0 : await this.hedge(m, free);
        free -= spent;
        // balances lag a CLOB fill until Polymarket settles it on-chain: don't restock on stale numbers
        if (!pending && spent === 0 && !this.planned.has(m.i)) free -= await this.restock(m, free);
        const exposureUsd = Math.abs(n6(m.Y - m.N)) * (m.Y < m.N ? m.mid : 1 - m.mid);
        if (exposureUsd > this.cfg.maxExposureUsd) problems.push(`market ${m.i}: unhedged exposure ${usd(exposureUsd)}`);
      }
    }
    await this.setVenue(problems.length === 0, problems);
  }

  /** Returns pUSD spent. */
  private async hedge(m: Market, free: number) {
    this.planned.delete(m.i);
    const cap = this.cfg.dailyCapUsd - this.spentToday();
    const plan = planHedge(m, Math.max(free, 0), cap, this.cfg);
    if (!plan) return 0;
    const token = plan.token === "YES" ? m.yes : m.no;
    const book = plan.token === "YES" ? m.yesBook : m.noBook;
    const what = `market ${m.i} exposure ${n6(m.Y - m.N).toFixed(2)} sh -> ${plan.side} ${plan.shares} ${plan.token} @ <= ${plan.limit} (${usd(plan.usd)})`;
    if (!this.cfg.live) {
      this.planned.add(m.i);
      this.dry(what);
      return 0;
    }
    const t = topOfBook(book);
    const res = await this.clob!.createAndPostMarketOrder(
      {
        tokenID: token.toString(),
        side: plan.side === "BUY" ? Side.BUY : Side.SELL,
        amount: plan.side === "BUY" ? Number(plan.usd.toFixed(2)) : plan.shares, // BUY: dollars, SELL: shares
        price: plan.limit,
        orderType: OrderType.FOK,
      },
      { tickSize: t.tick, negRisk: t.negRisk },
      OrderType.FOK,
    );
    this.cooldownUntil.set(m.i, Date.now() + this.cfg.cooldownMs);
    if (!res?.success) {
      log(`hedger: order failed (${what}): ${res?.errorMsg ?? JSON.stringify(res)}`);
      return 0;
    }
    this.spent.usd += plan.usd;
    log(`hedger: ${what}: ${res.status}, making ${res.makingAmount} taking ${res.takingAmount} ${res.transactionsHashes?.[0] ?? ""}`);
    return plan.side === "BUY" ? plan.usd : -plan.usd;
  }

  /** Split pUSD into pairs when either side runs low; merge when both run high. Returns pUSD spent. */
  private async restock(m: Market, free: number) {
    const low = n6(m.Y < m.N ? m.Y : m.N);
    if (low < this.cfg.floorShares) {
      const want = this.cfg.targetShares - low;
      const amt = Math.min(want, Math.max(free, 0));
      if (amt < 1) {
        log(`hedger: market ${m.i} inventory low (${low.toFixed(1)} sh/side) and no free pUSD to split; fund the maker`);
        return 0;
      }
      await this.split(m.i, amt);
      return this.cfg.live ? amt : 0;
    }
    if (low > 2 * this.cfg.targetShares) {
      const amt = low - this.cfg.targetShares;
      await this.merge(m.i, amt);
      return this.cfg.live ? -amt : 0;
    }
    return 0;
  }

  async split(i: number, amountUsd: number) {
    const what = `split ${usd(amountUsd)} pUSD into market ${i} YES + NO`;
    if (!this.cfg.live) return this.dry(what);
    await this.ensureErc20(this.d.usdc, this.adapter, "adapter");
    await send(this.c, {
      address: this.adapter,
      abi: ADAPTER_ABI,
      functionName: "splitPosition",
      args: [this.d.usdc, `0x${"0".repeat(64)}`, this.d.conditionIds![i], PARTITION, u6(amountUsd)],
    });
    log(`hedger: ${what}`);
  }

  async merge(i: number, shares: number) {
    const what = `merge ${shares.toFixed(2)} market ${i} YES + NO pairs into pUSD`;
    if (!this.cfg.live) return this.dry(what);
    await this.ensureCtfApproval(this.adapter, "adapter");
    await send(this.c, {
      address: this.adapter,
      abi: ADAPTER_ABI,
      functionName: "mergePositions",
      args: [this.d.usdc, `0x${"0".repeat(64)}`, this.d.conditionIds![i], PARTITION, u6(shares)],
    });
    log(`hedger: ${what}`);
  }

  private async setVenue(on: boolean, problems: string[]) {
    if (problems.length) await alert("hedger", `hedger: ${problems.join("; ")}`);
    const active = (await this.c.pub.readContract({
      address: this.d.venue,
      abi: this.extra.keeperVenue,
      functionName: "active",
    })) as boolean;
    if (active === on) return;
    const what = `venue.setActive(${on})`;
    if (!this.cfg.live) return this.dry(what);
    await send(this.c, { address: this.d.venue, abi: this.extra.keeperVenue, functionName: "setActive", args: [on] });
    log(`hedger: ${what}${on ? "" : " -- the protocol can't open or close until this clears"}`);
  }

  /** Approvals the CLOB (exchange) and the adapter need. */
  async setup() {
    await this.ensureErc20(this.d.usdc, EXCHANGE_V2, "exchange");
    await this.ensureCtfApproval(EXCHANGE_V2, "exchange");
    await this.ensureErc20(this.d.usdc, this.adapter, "adapter");
    await this.ensureCtfApproval(this.adapter, "adapter");
  }

  private async ensureErc20(token: Address, spender: Address, label: string) {
    const a = (await this.c.pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [this.me, spender] })) as bigint;
    if (a >= maxUint256 / 2n) return;
    if (!this.cfg.live) return this.dry(`approve pUSD to the ${label}`);
    await send(this.c, { address: token, abi: ERC20_ABI, functionName: "approve", args: [spender, maxUint256] });
    log(`hedger: approved pUSD to the ${label}`);
  }

  private async ensureCtfApproval(op: Address, label: string) {
    const ok = (await this.c.pub.readContract({ address: this.d.ctf, abi: CTF_ABI, functionName: "isApprovedForAll", args: [this.me, op] })) as boolean;
    if (ok) return;
    if (!this.cfg.live) return this.dry(`approve outcome tokens to the ${label}`);
    await send(this.c, { address: this.d.ctf, abi: CTF_ABI, functionName: "setApprovalForAll", args: [op, true] });
    log(`hedger: approved outcome tokens to the ${label}`);
  }

  async status() {
    const [ms, p, pol, active] = await Promise.all([
      this.markets(),
      this.pusd(),
      this.c.pub.getBalance({ address: this.me }),
      this.c.pub.readContract({ address: this.d.venue, abi: this.extra.keeperVenue, functionName: "active" }),
    ]);
    console.log(`maker ${this.me}: ${formatUnits(p, 6)} pUSD, ${formatUnits(pol, 18)} POL, venue ${active ? "ACTIVE" : "inactive"}`);
    for (const m of ms) {
      const y = topOfBook(m.yesBook);
      console.log(
        `  [${m.i}] YES ${n6(m.Y).toFixed(2)}  NO ${n6(m.N).toFixed(2)}  exposure ${n6(m.Y - m.N).toFixed(2)} sh  ` +
          `book ${y.bid}/${y.ask}  ${m.name}`,
      );
    }
    return ms;
  }
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(`--${f}`);
  const opt = (f: string, d: string) => (has(f) ? args[args.indexOf(`--${f}`) + 1] : d);
  const cmd = args[0];
  const d = loadDeployment();
  const c = clients(undefined, d.chainId);
  await setupEgress({ ssh: opt("ssh", ""), socks: opt("socks", process.env.CLOB_SOCKS ?? "") });

  const live = cmd === "tick" ? has("live") : has("yes");
  const h = new Hedger(c, d, configFromEnv(live));
  const pos = args.filter((a, k) => k > 0 && !a.startsWith("--") && !["--ssh", "--socks"].includes(args[k - 1]));

  switch (cmd) {
    case "status":
      await h.status();
      break;
    case "geo":
      console.log(JSON.stringify(await geoblock()));
      break;
    case "setup":
      await h.setup();
      break;
    case "split":
      await h.split(Number(pos[0]), Number(pos[1]));
      break;
    case "merge": {
      const ms = await h.markets();
      const m = ms[Number(pos[0])];
      const all = n6(m.Y < m.N ? m.Y : m.N);
      await h.merge(m.i, pos[1] === "all" ? all : Math.min(Number(pos[1]), all));
      break;
    }
    case "unwrap": {
      const amt = u6(Number(pos[0]));
      if (!live) {
        log(`[dry run] would unwrap ${pos[0]} pUSD to USDC.e (add --yes)`);
        break;
      }
      await send(c, { address: d.usdc, abi: ERC20_ABI, functionName: "approve", args: [OFFRAMP, amt] });
      await send(c, { address: OFFRAMP, abi: RAMP_ABI, functionName: "unwrap", args: [USDCE, c.account.address, amt] });
      log(`unwrapped ${pos[0]} pUSD to USDC.e`);
      break;
    }
    case "tick":
      await h.tick();
      break;
    default:
      console.log("usage: hedger.ts status | geo | setup --yes | split <m> <usd> --yes | merge <m> <shares|all> --yes | unwrap <usd> --yes | tick [--live]");
      process.exit(1);
  }
  process.exit(0);
}
