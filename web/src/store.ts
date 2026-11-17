import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { CFG, pub, yesId, noId, marketOf, type Abis, type Deployment } from "./chain";
import { breakdown, type MarketParams, type RiskBreakdown, type RiskParams } from "./risk";

const WAD = 1e18;
const USD = 1e6;
const n18 = (x: bigint) => Number(x) / WAD;
const n6 = (x: bigint) => Number(x) / USD;

export type SideView = {
  id: bigint;
  price: number;
  sigma1d: number;
  maxLtv: number; // from the contract
  liqLtv: number;
  openAllowed: boolean;
  maxPositionBorrow: number; // USD, 0 = none
  why: RiskBreakdown; // TS mirror, for the explanation
};

export type MarketView = { index: number; name: string; resolutionTime: number; yes: SideView; no: SideView };

export type PositionView = {
  id: bigint;
  market: number;
  side: "YES" | "NO";
  tokenId: bigint;
  shares: number;
  margin: number; // initial margin + margin added later
  entry: number;
  price: number;
  value: number;
  debt: number;
  ltv: number;
  liqLtv: number;
  maxLtv: number;
  liquidatable: boolean;
  flaggedSince: number; // 0 = not flagged
  bonusBps: number;
  pnl: number;
};

export type Activity = {
  key: string;
  t: number;
  kind: "Opened" | "Closed" | "Liquidated" | "Absorbed" | "InventorySold" | "Flagged" | "MarginAdded";
  id?: bigint;
  text: string;
};

export type HistoryPoint = { t: number; yes: number; yesLev: number; noLev: number };

export type Snapshot = {
  block: bigint;
  chainTime: number;
  markets: MarketView[];
  pool: {
    senior: number;
    junior: number;
    cash: number;
    debt: number;
    utilization: number;
    borrowRate: number;
    maxWithdrawSenior: number;
    maxWithdrawJunior: number;
    capacity: number;
    inventoryValue: number;
    seniorSharePrice: number; // USDC per vault share
    juniorSharePrice: number;
    seniorApr: number; // from interest only (fees come on top for junior)
    juniorApr: number;
  };
  fees: { openFeeBps: number; liqFeeBps: number; bonusBps: number; rampPerHour: number; maxBonusBps: number };
  account: {
    address: Address | null; // null until a wallet is connected (read-only view)
    usdc: number;
    seniorShares: bigint;
    juniorShares: bigint;
    seniorAssets: number;
    juniorAssets: number;
    positions: PositionView[];
  };
  activity: Activity[];
  history: HistoryPoint[][];
};

type Opened = { id: bigint; owner: Address; tokenId: bigint; margin: bigint; borrowed: bigint; shares: bigint };

/** Accumulates events incrementally across refreshes (never rescans from block 0). */
class EventStore {
  fromBlock = 0n;
  blockTime = new Map<bigint, number>();
  opened = new Map<bigint, Opened>();
  marginAdded = new Map<bigint, bigint>(); // fresh USDC put into a position after opening (cost basis)
  gone = new Set<bigint>();
  activity: Activity[] = [];
  // per token: [t, price, sigma1d]
  prices = new Map<bigint, [number, number, number][]>();

  constructor(
    private d: Deployment,
    private abi: Abis,
  ) {
    this.fromBlock = BigInt(d.deployBlock ?? 0); // nothing of ours exists before the deploy
  }

  private pending: Promise<void> = Promise.resolve();

  /** Serialized: overlapping refreshes (React StrictMode, slow RPC) must never process a block range twice. */
  sync(toBlock: bigint) {
    this.pending = this.pending.then(() => this.syncOnce(toBlock));
    return this.pending;
  }

  /** Catch up to `head` in chunks: public RPCs cap the eth_getLogs block range. */
  private async syncOnce(head: bigint) {
    while (this.fromBlock <= head) {
      const end = this.fromBlock + CFG.logChunk - 1n;
      await this.syncRange(end < head ? end : head);
    }
  }

  private async syncRange(toBlock: bigint) {
    const range = { fromBlock: this.fromBlock, toBlock };
    const [oracleLogs, pmLogs] = await Promise.all([
      pub.getContractEvents({ address: this.d.oracle, abi: this.abi.oracle, eventName: "PriceUpdated", ...range }),
      pub.getContractEvents({ address: this.d.positionManager, abi: this.abi.pm, ...range }),
    ]);
    const blocks = [...new Set([...oracleLogs, ...pmLogs].map((l) => l.blockNumber!))].filter((b) => !this.blockTime.has(b));
    const fetched = await Promise.all(blocks.map((b) => pub.getBlock({ blockNumber: b })));
    for (const b of fetched) this.blockTime.set(b.number!, Number(b.timestamp));

    for (const l of oracleLogs) {
      const a = (l as unknown as { args: { tokenId: bigint; priceWad: bigint; sigma1dWad: bigint } }).args;
      const arr = this.prices.get(a.tokenId) ?? [];
      arr.push([this.blockTime.get(l.blockNumber!)!, n18(a.priceWad), n18(a.sigma1dWad)]);
      this.prices.set(a.tokenId, arr);
    }
    for (const l of pmLogs) this.onPmLog(l as unknown as PmLog);
    this.activity = this.activity.slice(-200);
    this.fromBlock = toBlock + 1n;
  }

  private onPmLog(l: PmLog) {
    const a = l.args;
    const t = this.blockTime.get(l.blockNumber) ?? 0;
    const key = `${l.blockNumber}-${l.logIndex}`;
    const side = (tokenId: bigint) => marketOf(this.d, tokenId)?.side ?? "?";
    const mkt = (tokenId: bigint) => {
      const m = marketOf(this.d, tokenId)?.market;
      return m === undefined ? `token ${tokenId}` : (this.d.names[m] ?? `market ${m}`);
    };
    const push = (kind: Activity["kind"], text: string, id?: bigint) => this.activity.push({ key, t, kind, id, text });
    switch (l.eventName) {
      case "Opened": {
        const o = a as unknown as Opened;
        this.opened.set(o.id, o);
        const lev = Number(o.margin + o.borrowed) / Number(o.margin);
        push("Opened", `#${o.id} ${side(o.tokenId)} ${mkt(o.tokenId)}: $${fmt0(n6(o.margin))} at ${lev.toFixed(2)}x`, o.id);
        break;
      }
      case "Closed":
        this.gone.add(a.id);
        push("Closed", `#${a.id} closed, $${fmt0(n6(a.toOwner))} back to the trader`, a.id);
        break;
      case "Liquidated":
        this.gone.add(a.id);
        push(
          "Liquidated",
          a.badDebt > 0n
            ? `#${a.id} liquidated with $${fmt0(n6(a.badDebt))} shortfall`
            : `#${a.id} liquidated: debt $${fmt0(n6(a.debt))} repaid in full`,
          a.id,
        );
        break;
      case "Absorbed":
        this.gone.add(a.id);
        push("Absorbed", `#${a.id} absorbed: underwater, shares to backstop inventory (no fire-sale)`, a.id);
        break;
      case "InventorySold":
        push("InventorySold", `Backstop sold ${fmt0(n6(a.shares))} ${side(a.tokenId)} shares: $${fmt0(n6(a.proceeds))} to junior`);
        break;
      case "Flagged":
        if (a.since > 0n) push("Flagged", `#${a.id} flagged: liquidation auction started`, a.id);
        break;
      case "MarginAdded":
        this.marginAdded.set(a.id, (this.marginAdded.get(a.id) ?? 0n) + a.repaid);
        push("MarginAdded", `#${a.id} added margin: $${fmt0(n6(a.repaid))} of debt repaid`, a.id);
        break;
    }
  }
}

type PmLog = { eventName: string; blockNumber: bigint; logIndex: number; args: Record<string, bigint> };

/**
 * Mirrors LendingPool._previewAccrual: interest = debt * rate; senior gets seniorYieldShareBps of its pro-rata share,
 * junior the rest. Returns per-tranche APRs and share prices (vault shares carry 12 decimals: 6 + offset 6).
 */
function trancheEconomics(s: number, j: number, debt: number, rate: number, sShares: bigint, jShares: bigint, seniorShareBps: number) {
  const interest = debt * rate;
  const total = s + j;
  const seniorCut = total > 0 ? ((interest * s) / total) * (seniorShareBps / 10_000) : 0;
  const px = (assets: number, shares: bigint) => (shares > 0n ? assets / (Number(shares) / 1e12) : 1);
  return {
    seniorSharePrice: px(s, sShares),
    juniorSharePrice: px(j, jShares),
    seniorApr: s > 0 ? seniorCut / s : 0,
    juniorApr: j > 0 ? (interest - seniorCut) / j : 0,
  };
}

export const fmt0 = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

async function loadParams(d: Deployment, abi: Abis) {
  const r = (address: Address, a: keyof Abis, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi: abi[a], functionName, args }) as Promise<unknown>;
  const [bands, volK, volHorizon, jump, volOracle, mkts] = await Promise.all([
    r(d.risk, "risk", "bands") as Promise<readonly bigint[]>,
    r(d.risk, "risk", "volKBps") as Promise<number>,
    r(d.risk, "risk", "volHorizon") as Promise<number>,
    r(d.risk, "risk", "jumpWad") as Promise<bigint>,
    r(d.risk, "risk", "volOracle") as Promise<Address>,
    Promise.all(
      Array.from({ length: d.markets }, (_, i) => r(d.risk, "risk", "markets", [yesId(d, i)]) as Promise<readonly unknown[]>),
    ),
  ]);
  const riskParams: RiskParams = {
    bands: { floor: n18(bands[0]), safeLow: n18(bands[1]), safeHigh: n18(bands[2]), ceil: n18(bands[3]) },
    volK: Number(volK) / 10_000,
    volHorizon: Number(volHorizon),
    jump: n18(jump),
    hasVolOracle: volOracle !== "0x0000000000000000000000000000000000000000",
  };
  // Market struct: listed, openEnabled, liqLtvBps, openBufferBps, resolutionTime, cutoffDuration, rampDuration, borrowCap
  const marketParams: MarketParams[] = mkts.map((m) => ({
    liqLtv: Number(m[2]) / 10_000,
    openBuffer: Number(m[3]) / 10_000,
    resolutionTime: Number(m[4]),
    cutoffDuration: Number(m[5]),
    rampDuration: Number(m[6]),
  }));
  return { riskParams, marketParams };
}

export function useProtocol(d: Deployment | null, abi: Abis | null, account: Address | null, pollMs = CFG.pollMs) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef<EventStore | null>(null);
  const paramsRef = useRef<Awaited<ReturnType<typeof loadParams>> | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!d || !abi) return;
    let alive = true;
    let busy = false;
    storeRef.current ??= new EventStore(d, abi);

    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        paramsRef.current ??= await loadParams(d, abi);
        const s = await read(d, abi, account, storeRef.current!, paramsRef.current);
        if (alive) {
          setSnap(s);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message.split("\n")[0]);
      } finally {
        busy = false;
      }
    };
    refresh();
    const h = setInterval(refresh, pollMs);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [d, abi, account, pollMs, tick]);

  return { snap, error, refreshNow: () => setTick((x) => x + 1) };
}

async function read(
  d: Deployment,
  abi: Abis,
  account: Address | null,
  store: EventStore,
  params: Awaited<ReturnType<typeof loadParams>>,
): Promise<Snapshot> {
  const block = await pub.getBlock();
  await store.sync(block.number!);
  const now = Number(block.timestamp);

  const r = <T,>(address: Address, a: keyof Abis, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi: abi[a], functionName, args }) as Promise<T>;

  const sideView = async (i: number, tokenId: bigint): Promise<SideView> => {
    const [[price], sigma, openAllowed, maxPos] = await Promise.all([
      r<readonly [bigint, bigint]>(d.oracle, "oracle", "getPrice", [tokenId]),
      r<bigint>(d.oracle, "oracle", "sigmaWad", [tokenId, 86_400n]),
      r<boolean>(d.risk, "risk", "isOpenAllowed", [tokenId]),
      r<bigint>(d.risk, "risk", "maxPositionBorrow", [tokenId]),
    ]);
    // limits at the current price (second round: they take the price as an argument)
    const [maxLtvBps, liqLtvBps] = await Promise.all([
      r<bigint>(d.risk, "risk", "maxLtvBps", [tokenId, price]),
      r<bigint>(d.risk, "risk", "liqLtvBps", [tokenId, price]),
    ]);
    const p = n18(price);
    const s = n18(sigma);
    return {
      id: tokenId,
      price: p,
      sigma1d: s,
      maxLtv: Number(maxLtvBps) / 10_000,
      liqLtv: Number(liqLtvBps) / 10_000,
      openAllowed,
      maxPositionBorrow: n6(maxPos),
      why: breakdown(p, s, now, params.riskParams, params.marketParams[i]),
    };
  };

  const marketsP = Promise.all(
    Array.from({ length: d.markets }, async (_, i) => {
      const [yes, no] = await Promise.all([sideView(i, yesId(d, i)), sideView(i, noId(d, i))]);
      return { index: i, name: d.names?.[i] ?? `market ${i}`, resolutionTime: params.marketParams[i].resolutionTime, yes, no };
    }),
  );

  const poolP = Promise.all([
    r<bigint>(d.pool, "pool", "trancheAssets", [0]),
    r<bigint>(d.pool, "pool", "trancheAssets", [1]),
    r<bigint>(d.pool, "pool", "cash"),
    r<bigint>(d.pool, "pool", "totalDebt"),
    r<bigint>(d.pool, "pool", "utilization"),
    r<bigint>(d.pool, "pool", "borrowRate"),
    r<bigint>(d.pool, "pool", "maxWithdrawable", [0]),
    r<bigint>(d.pool, "pool", "maxWithdrawable", [1]),
    r<bigint>(d.pool, "pool", "borrowCapacity"),
    Promise.all(
      Array.from({ length: d.markets * 2 }, (_, k) => r<bigint>(d.positionManager, "pm", "inventoryValue", [BigInt(k + 1)])),
    ),
    r<bigint>(d.senior, "vault", "totalSupply"),
    r<bigint>(d.junior, "vault", "totalSupply"),
    r<bigint>(d.pool, "pool", "seniorYieldShareBps"),
  ]);

  const feesP = Promise.all([
    r<bigint>(d.positionManager, "pm", "openFeeBps"),
    r<bigint>(d.positionManager, "pm", "liquidationFeeBps"),
    r<bigint>(d.positionManager, "pm", "liquidationBonusBps"),
    r<bigint>(d.positionManager, "pm", "bonusRampBpsPerHour"),
    r<bigint>(d.positionManager, "pm", "maxLiquidationBonusBps"),
  ]);

  const mine = account
    ? [...store.opened.values()].filter((o) => o.owner.toLowerCase() === account.toLowerCase() && !store.gone.has(o.id))
    : [];
  const positionsP = Promise.all(
    mine.map(async (o) => {
      const [h, since, bonus] = await Promise.all([
        r<{ priceWad: bigint; value: bigint; debt: bigint; ltvBps: bigint; maxLtvBps: bigint; liqLtvBps: bigint; liquidatable: boolean }>(
          d.positionManager,
          "pm",
          "health",
          [o.id],
        ),
        r<bigint>(d.positionManager, "pm", "liquidatableSince", [o.id]),
        r<bigint>(d.positionManager, "pm", "currentBonusBps", [o.id]),
      ]);
      const price = n18(h.priceWad);
      const value = n6(h.value);
      const debt = n6(h.debt);
      const margin = n6(o.margin + (store.marginAdded.get(o.id) ?? 0n)); // all USDC the trader put in
      return {
        id: o.id,
        market: marketOf(d, o.tokenId)?.market ?? -1,
        side: marketOf(d, o.tokenId)?.side ?? "YES",
        tokenId: o.tokenId,
        shares: n6(o.shares),
        margin,
        entry: n6(o.margin + o.borrowed) / n6(o.shares),
        price,
        value,
        debt,
        ltv: value === 0 ? Infinity : debt / value,
        liqLtv: Number(h.liqLtvBps) / 10_000,
        maxLtv: Number(h.maxLtvBps) / 10_000,
        liquidatable: h.liquidatable,
        flaggedSince: Number(since),
        bonusBps: Number(bonus),
        pnl: value - debt - margin,
      } satisfies PositionView;
    }),
  );

  const acctP = account
    ? Promise.all([
        r<bigint>(d.usdc, "usdc", "balanceOf", [account]),
        r<bigint>(d.senior, "vault", "balanceOf", [account]),
        r<bigint>(d.junior, "vault", "balanceOf", [account]),
      ])
    : Promise.resolve([0n, 0n, 0n] as const);

  const [markets, pool, fees, positions, [usdc, srShares, jrShares]] = await Promise.all([marketsP, poolP, feesP, positionsP, acctP]);
  const [srAssets, jrAssets] = account
    ? await Promise.all([
        r<bigint>(d.senior, "vault", "convertToAssets", [srShares]),
        r<bigint>(d.junior, "vault", "convertToAssets", [jrShares]),
      ])
    : [0n, 0n];

  // History: rebuild each market's leverage limit at every oracle update from (price, sigma, time).
  const history = Array.from({ length: d.markets }, (_, i) => {
    const ys = store.prices.get(yesId(d, i)) ?? [];
    const ns = store.prices.get(noId(d, i)) ?? [];
    const mp = params.marketParams[i];
    return ys.map(([t, p, s], k) => {
      const nsK = ns[k] ?? [t, 1 - p, s];
      return {
        t,
        yes: p,
        yesLev: breakdown(p, s, t, params.riskParams, mp).maxLeverage,
        noLev: breakdown(nsK[1], nsK[2], t, params.riskParams, mp).maxLeverage,
      };
    });
  });

  return {
    block: block.number!,
    chainTime: now,
    markets,
    pool: {
      senior: n6(pool[0]),
      junior: n6(pool[1]),
      cash: n6(pool[2]),
      debt: n6(pool[3]),
      utilization: n18(pool[4]),
      borrowRate: n18(pool[5]),
      maxWithdrawSenior: n6(pool[6]),
      maxWithdrawJunior: n6(pool[7]),
      capacity: n6(pool[8]),
      inventoryValue: pool[9].reduce((a, b) => a + n6(b), 0),
      ...trancheEconomics(n6(pool[0]), n6(pool[1]), n6(pool[3]), n18(pool[5]), pool[10], pool[11], Number(pool[12])),
    },
    fees: {
      openFeeBps: Number(fees[0]),
      liqFeeBps: Number(fees[1]),
      bonusBps: Number(fees[2]),
      rampPerHour: Number(fees[3]),
      maxBonusBps: Number(fees[4]),
    },
    account: {
      address: account,
      usdc: n6(usdc),
      seniorShares: srShares,
      juniorShares: jrShares,
      seniorAssets: n6(srAssets),
      juniorAssets: n6(jrAssets),
      positions,
    },
    activity: [...store.activity].reverse().slice(0, 40),
    history,
  };
}
