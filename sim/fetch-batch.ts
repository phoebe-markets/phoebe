#!/usr/bin/env bun
/**
 * Build a backtest dataset from the highest-volume resolved Polymarket markets.
 *
 *   bun sim/fetch-batch.ts [count=60] [windowDays=45] [scan=600] [outDir=batch] [skipUsable=0]
 *
 * `skipUsable` skips the first N markets that pass the filters, e.g. to build a holdout set:
 *   bun sim/fetch-batch.ts 60 45 2000 holdout 60
 *
 * For each market: YES token price history at 10-min fidelity over the last `windowDays` before it closed,
 * a final tick at the resolved price (0 or 1), and the *scheduled* end date (drives the time ramp).
 * Writes sim/data/batch/<slug>.json and sim/data/batch/manifest.json.
 *
 * Filters: binary, resolved cleanly to 0/1, at least 7 days of history, not near-certain for the whole window
 * (max price - min price >= 0.05; dead markets just get skipped by the price bands and add nothing).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const count = Number(process.argv[2] ?? 60);
const windowDays = Number(process.argv[3] ?? 45);
const scan = Number(process.argv[4] ?? 600);
const outDir = process.argv[5] ?? "batch";
let skipUsable = Number(process.argv[6] ?? 0);
const FIDELITY = 10;
const CHUNK = 7 * 86400;

const dir = join(import.meta.dir, "data", outDir);
mkdirSync(dir, { recursive: true });

type GammaMarket = {
  question: string;
  slug: string;
  clobTokenIds?: string;
  outcomePrices?: string;
  outcomes?: string;
  volumeNum?: number;
  startDate?: string;
  endDate?: string;
  closedTime?: string;
  negRisk?: boolean;
  events?: { title?: string; slug?: string }[];
};

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()) as T;
    if (attempt >= 3 || res.status < 500) throw new Error(`${res.status} ${url}`);
    await Bun.sleep(1000 * (attempt + 1));
  }
}

async function history(tokenId: string, start: number, end: number) {
  const pts = new Map<number, number>();
  for (let from = start; from < end; from += CHUNK) {
    const to = Math.min(from + CHUNK, end);
    const body = await getJson<{ history?: { t: number; p: number }[] }>(
      `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${from}&endTs=${to}&fidelity=${FIDELITY}`,
    );
    for (const { t, p } of body.history ?? []) pts.set(t, p);
  }
  return [...pts.entries()].sort((a, b) => a[0] - b[0]);
}

// 1. scan the top markets by volume
const candidates: GammaMarket[] = [];
for (let offset = 0; offset < scan; offset += 100) {
  const page = await getJson<GammaMarket[]>(
    `https://gamma-api.polymarket.com/markets?closed=true&order=volumeNum&ascending=false&limit=100&offset=${offset}`,
  );
  candidates.push(...page);
  if (page.length < 100) break;
}
console.log(`scanned ${candidates.length} closed markets`);

// 2. fetch histories until we have `count` usable markets
const manifest: Record<string, unknown>[] = [];
for (const m of candidates) {
  if (manifest.length >= count) break;
  try {
    const outcomes = JSON.parse(m.outcomes ?? "[]");
    const prices = JSON.parse(m.outcomePrices ?? "[]").map(Number);
    const tokens = JSON.parse(m.clobTokenIds ?? "[]");
    if (outcomes.length !== 2 || tokens.length !== 2) continue;
    if (!((prices[0] === 1 && prices[1] === 0) || (prices[0] === 0 && prices[1] === 1))) continue;
    if (!m.closedTime || !m.endDate) continue;

    const closed = Math.floor(Date.parse(m.closedTime.replace(" ", "T").replace("+00", "Z")) / 1000);
    const startMkt = m.startDate ? Math.floor(Date.parse(m.startDate) / 1000) : 0;
    const start = Math.max(closed - windowDays * 86400, startMkt);
    if (closed - start < 7 * 86400) continue;

    const out = join(dir, `${m.slug}.json`);
    const cached = [out, join(import.meta.dir, "data", "batch", `${m.slug}.json`)].find((f) => existsSync(f));
    let t: number[], p: number[];
    if (cached) {
      ({ t, p } = JSON.parse(readFileSync(cached, "utf8")));
    } else {
      const h = await history(tokens[0], start, closed);
      if (h.length < 500) continue;
      t = h.map(([ts]) => ts);
      p = h.map(([, px]) => Math.round(px * 1e6));
      t.push(t[t.length - 1] + FIDELITY * 60);
      p.push(prices[0] * 1e6);
    }
    const lo = Math.min(...p.slice(0, -1));
    const hi = Math.max(...p.slice(0, -1));
    if (hi - lo < 50_000) continue;
    if (skipUsable > 0) {
      skipUsable--;
      continue;
    }

    const resolutionTime = Math.floor(Date.parse(m.endDate) / 1000);
    // Lifetime average daily volume (USD). The only liquidity proxy available historically; the backtest's
    // liquidators use it for price impact, and borrow caps can be sized from it.
    const lifeDays = Math.max(1, (closed - startMkt) / 86400);
    const dailyVolume = Math.round((m.volumeNum ?? 0) / lifeDays);
    writeFileSync(out, JSON.stringify({ name: m.slug, tokenId: tokens[0], t, p, resolutionTime, dailyVolume }));

    let maxJump = 0;
    for (let i = 1; i < p.length - 1; i++) maxJump = Math.max(maxJump, Math.abs(p[i] - p[i - 1]));
    const entry = {
      slug: m.slug,
      question: m.question,
      event: m.events?.[0]?.title ?? "",
      volume: Math.round(m.volumeNum ?? 0),
      dailyVolume,
      resolvedYes: prices[0] === 1,
      scheduledEnd: m.endDate,
      closedTime: m.closedTime,
      resolvedEarlyDays: Math.round((resolutionTime - closed) / 86400),
      ticks: t.length,
      minPx: lo / 1e6,
      maxPx: hi / 1e6,
      maxTickMove: maxJump / 1e6,
    };
    manifest.push(entry);
    console.log(`[${manifest.length}/${count}] ${m.slug}  ticks=${t.length}  range=${entry.minPx}-${entry.maxPx}  maxTick=${entry.maxTickMove}`);
  } catch (e) {
    console.warn(`skip ${m.slug}: ${(e as Error).message}`);
  }
}

writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`wrote ${manifest.length} markets to ${dir}`);
