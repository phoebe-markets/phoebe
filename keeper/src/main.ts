#!/usr/bin/env bun
/**
 * Phoebe keeper: pushes oracle prices and runs the risk loop (liquidate / absorb / sell inventory).
 *
 * Replay mode (demo). Historical prices drive a local chain whose clock starts at the first tick:
 *   anvil --timestamp $(jq '.t[0]' sim/data/biden-nominee.json)
 *   MARKET_RESOLUTIONS=$(jq .resolutionTime ...) MARKET_PRICES=... forge script script/Deploy.s.sol --broadcast ...
 *   bun keeper/src/main.ts replay sim/data/biden-nominee.json [more.json ...] [--speed 20] [--traders 12]
 *   (--traders N: demo trader opens a position every N ticks)
 *
 * Live mode. Polymarket CLOB midpoints, one Polymarket YES token id per listed market (default: the deployment's
 * polyTokenIds). With a KeeperVenue deployment the keeper is also the market maker (approvals + inventory):
 *   DEPLOYMENT=amoy RPC_URL=... KEEPER_PK=... bun keeper/src/main.ts live [--interval 60] [--min-move 0.003] [--heartbeat 3300]
 *   Live pushes are throttled for testnet gas: a market is pushed when its price moves >= min-move, and every market
 *   at least once per heartbeat (seconds). Keep the heartbeat under KeeperVenue.maxPriceAge.
 *
 * Mainnet (deployment with the real CTF): the keeper also runs the hedger (hedger.ts) every tick. It only LOGS the
 * orders, splits and venue switches it would make unless started with --hedge-live (or HEDGE_LIVE=1).
 *   DEPLOYMENT=polygon RPC_URL=... KEEPER_PK=... bun keeper/src/main.ts live --interval 15 --min-move 0.002 --heartbeat 300
 *   --ssh <host> / --socks <host:port>: route Polymarket API traffic (hedger + geoblock check) through a proxy.
 *
 * Env: DEPLOYMENT (default local), RPC_URL (default http://127.0.0.1:8545), KEEPER_PK (default Anvil account #1),
 *      COOL_OFF_SECONDS (21600), hedger limits (see hedger.ts)
 */
import { clients, loadDeployment, log } from "./config";
import { PolymarketFeed, ReplayFeed, describe, pushPrices } from "./oracle";
import { RiskKeeper } from "./risk";
import { DemoTraders } from "./traders";
import { Maker } from "./maker";
import { Hedger, configFromEnv } from "./hedger";
import { setupEgress } from "./polymarket";

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const positional: string[] = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--hedge-live") continue; // boolean flag
  if (args[i].startsWith("--")) i++; // skip the flag's value
  else positional.push(args[i]);
}

if (mode !== "replay" && mode !== "live") {
  console.error("usage: main.ts replay <file.json ...> [--speed ticksPerSec] | live <tokenId ...> [--interval sec]");
  process.exit(1);
}

const d = loadDeployment();
const c = clients(undefined, d.chainId);
if (mode === "live" && positional.length === 0 && d.polyTokenIds?.length) positional.push(...d.polyTokenIds);
if (positional.length !== d.markets) {
  console.error(`deployment lists ${d.markets} market(s) but ${positional.length} feed(s) were given`);
  process.exit(1);
}

const keeper = new RiskKeeper(c, d, {
  coolOff: BigInt(process.env.COOL_OFF_SECONDS ?? 6 * 3600),
  slipBufferBps: 100n,
  recycle: d.venueType !== "keeper", // with KeeperVenue, seized shares simply become maker inventory
});

const feed = mode === "replay" ? new ReplayFeed(positional) : new PolymarketFeed(positional);
const delayMs = mode === "replay" ? 1000 / flag("speed", 20) : flag("interval", 30) * 1000;
log(`keeper up: ${mode}, ${d.markets} market(s), keeper ${c.account.address}`);

const maker = d.venueType === "keeper" ? new Maker(c, d) : undefined;
if (maker) await maker.setup();

// Real CTF + keeper venue: hedge the maker's inventory on Polymarket
let hedger: Hedger | undefined;
if (mode === "live" && d.venueType === "keeper" && d.mockCtf === false) {
  const opt = (f: string) => (args.includes(`--${f}`) ? args[args.indexOf(`--${f}`) + 1] : "");
  await setupEgress({ ssh: opt("ssh"), socks: opt("socks") || process.env.CLOB_SOCKS });
  const live = args.includes("--hedge-live") || process.env.HEDGE_LIVE === "1";
  hedger = new Hedger(c, d, configFromEnv(live));
  await hedger.init();
  if (live) await hedger.setup();
  log(`hedger up (${live ? "LIVE: will post Polymarket orders" : "dry run: logs only; --hedge-live to trade"})`);
}

const traderEvery = flag("traders", 0);
const traders = traderEvery > 0 ? new DemoTraders(c, d) : undefined;

const minMove = BigInt(Math.round(flag("min-move", 0.003) * 1e18));
const heartbeatMs = flag("heartbeat", 3300) * 1000;
const lastPushed: (bigint | undefined)[] = [];
let lastHeartbeat = 0;

/** Live mode: drop markets whose price hasn't moved enough, unless the heartbeat is due. */
function throttle(prices: (bigint | undefined)[]) {
  if (mode !== "live") return prices;
  const beat = Date.now() - lastHeartbeat >= heartbeatMs;
  if (beat) lastHeartbeat = Date.now();
  return prices.map((p, i) => {
    if (p === undefined) return undefined;
    const prev = lastPushed[i];
    const moved = prev === undefined || (p > prev ? p - prev : prev - p) >= minMove;
    if (!moved && !beat) return undefined;
    lastPushed[i] = p;
    return p;
  });
}

let n = 0;
for (;;) {
  const step = await feed.next();
  if (!step) break;
  try {
    await pushPrices(c, d, throttle(step.prices), step.timestamp);
    await keeper.sweep();
  } catch (e) {
    if (mode !== "live") throw e;
    log(`tick failed, retrying next interval: ${(e as Error).message.split("\n")[0]}`); // RPC/API hiccups mustn't kill a live keeper
  }
  if (traders && n % traderEvery === 0) await traders.step(n);
  if (hedger) await hedger.tick().catch((e) => log(`hedger tick failed: ${(e as Error).message.split("\n")[0]}`));
  if (maker && n % 20 === 19) await maker.restock().catch((e) => log(`maker restock failed: ${(e as Error).message.split("\n")[0]}`));
  if (++n % 50 === 0 || mode === "live") {
    const when = step.timestamp ? new Date(Number(step.timestamp) * 1000).toISOString().slice(0, 16) : "now";
    log(`${when} ${describe(step.prices)} | open ${keeper.openCount} | inventory lots ${keeper.inventoryLots} | ${JSON.stringify(keeper.stats)}`);
  }
  await Bun.sleep(delayMs);
}
log("replay finished", keeper.stats);
