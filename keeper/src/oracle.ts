import { readFileSync } from "node:fs";
import { ABI, type Clients, type Deployment, WAD, fees, log, noId, yesId } from "./config";

/** Next prices, plus the chain timestamp they should land at (replay) or undefined (live: now). */
export type Step = { prices: (bigint | undefined)[]; timestamp?: bigint };

/** A source of YES prices (WAD) for each listed market, one step at a time. */
export interface PriceFeed {
  next(): Promise<Step | null>;
}

/**
 * Replays sim/data/<name>.json files (from sim/fetch.ts). Market i = file i. Run Anvil with
 * `--timestamp <first tick>` so chain time is the historical time and resolution dates line up.
 */
export class ReplayFeed implements PriceFeed {
  private series: { t: number[]; p: number[] }[];
  private times: number[];
  private i = 0;

  constructor(files: string[]) {
    this.series = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
    this.times = [...new Set(this.series.flatMap((s) => s.t.map((t) => t - (t % 600))))].sort((a, b) => a - b);
  }

  get length() {
    return this.times.length;
  }

  async next(): Promise<Step | null> {
    if (this.i >= this.times.length) return null;
    const bucket = this.times[this.i++];
    const prices = this.series.map((s) => {
      const k = s.t.findIndex((t) => t - (t % 600) === bucket);
      return k < 0 ? undefined : (BigInt(Math.min(s.p[k], 1_000_000)) * WAD) / 1_000_000n;
    });
    return { prices, timestamp: BigInt(bucket) };
  }
}

/** Live Polymarket CLOB midpoints. `tokenIds[i]` is the Polymarket YES token for market i. */
export class PolymarketFeed implements PriceFeed {
  constructor(private tokenIds: string[]) {}

  async next(): Promise<Step | null> {
    const prices = await Promise.all(
      this.tokenIds.map(async (id) => {
        try {
          const res = await fetch(`https://clob.polymarket.com/midpoint?token_id=${id}`);
          if (!res.ok) return undefined;
          const { mid } = (await res.json()) as { mid?: string };
          if (mid === undefined) return undefined;
          return (BigInt(Math.round(Number(mid) * 1e6)) * WAD) / 1_000_000n;
        } catch {
          return undefined; // skip this market this round; staleness checks in the contracts handle outages
        }
      }),
    );
    return { prices };
  }
}

/** Push one step of prices (YES and complementary NO) in a single tx. */
export async function pushPrices(c: Clients, d: Deployment, prices: (bigint | undefined)[], timestamp?: bigint) {
  const ids: bigint[] = [];
  const px: bigint[] = [];
  prices.forEach((p, i) => {
    if (p === undefined) return;
    ids.push(yesId(d, i));
    px.push(p);
    if (!d.complementNo) {
      ids.push(noId(d, i));
      px.push(WAD - p);
    }
  });
  if (ids.length === 0) return;

  if (timestamp !== undefined) {
    const block = await c.pub.getBlock();
    await c.test.setNextBlockTimestamp({ timestamp: timestamp > block.timestamp ? timestamp : block.timestamp + 1n });
  }
  const hash = await c.wallet.writeContract({
    address: d.oracle,
    abi: ABI.oracle,
    functionName: "setPrices",
    args: [ids, px],
    ...(await fees(c)),
  });
  await c.pub.waitForTransactionReceipt({ hash });
}

export function describe(prices: (bigint | undefined)[]) {
  return prices.map((p, i) => `m${i}=${p === undefined ? "-" : (Number(p) / 1e18).toFixed(3)}`).join(" ");
}

export { log };
