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
 * Live mode. Polymarket CLOB midpoints, one Polymarket YES token id per listed market:
 *   bun keeper/src/main.ts live <polymarketTokenId> [...] [--interval 30]
 *
 * Env: RPC_URL (default http://127.0.0.1:8545), KEEPER_PK (default Anvil account #1), COOL_OFF_SECONDS (21600)
 */
import { clients, loadDeployment, log } from "./config";
import { PolymarketFeed, ReplayFeed, describe, pushPrices } from "./oracle";
import { RiskKeeper } from "./risk";
import { DemoTraders } from "./traders";

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const positional: string[] = [];
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith("--")) i++; // skip the flag's value
  else positional.push(args[i]);
}

if (mode !== "replay" && mode !== "live") {
  console.error("usage: main.ts replay <file.json ...> [--speed ticksPerSec] | live <tokenId ...> [--interval sec]");
  process.exit(1);
}

const d = loadDeployment();
const c = clients();
if (positional.length !== d.markets) {
  console.error(`deployment lists ${d.markets} market(s) but ${positional.length} feed(s) were given`);
  process.exit(1);
}

const keeper = new RiskKeeper(c, d, {
  coolOff: BigInt(process.env.COOL_OFF_SECONDS ?? 6 * 3600),
  slipBufferBps: 100n,
  recycle: true,
});

const feed = mode === "replay" ? new ReplayFeed(positional) : new PolymarketFeed(positional);
const delayMs = mode === "replay" ? 1000 / flag("speed", 20) : flag("interval", 30) * 1000;
log(`keeper up: ${mode}, ${d.markets} market(s), keeper ${c.account.address}`);

const traderEvery = flag("traders", 0);
const traders = traderEvery > 0 ? new DemoTraders(c, d) : undefined;

let n = 0;
for (;;) {
  const step = await feed.next();
  if (!step) break;
  await pushPrices(c, d, step.prices, step.timestamp);
  await keeper.sweep();
  if (traders && n % traderEvery === 0) await traders.step(n);
  if (++n % 50 === 0 || mode === "live") {
    const when = step.timestamp ? new Date(Number(step.timestamp) * 1000).toISOString().slice(0, 16) : "now";
    log(`${when} ${describe(step.prices)} | open ${keeper.openCount} | inventory lots ${keeper.inventoryLots} | ${JSON.stringify(keeper.stats)}`);
  }
  await Bun.sleep(delayMs);
}
log("replay finished", keeper.stats);
