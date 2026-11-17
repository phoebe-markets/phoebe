#!/usr/bin/env bun
/**
 * Fetch a Polymarket outcome token's price history into a replay file for the Forge replay.
 *
 *   bun sim/fetch.ts <tokenId> <startISO> <endISO> <outName> [fidelityMinutes=10] [resolvesTo] [scheduledResolutionISO]
 *
 * e.g. Biden "win the 2024 Dem nomination" YES, debate night through dropout, then resolution to 0:
 *   bun sim/fetch.ts 2977151531...825505 2024-06-01 2024-07-23 biden-nominee 10 0
 *
 * Output: sim/data/<outName>.json  { name, tokenId, t: number[], p: number[] (price * 1e6) }
 * If `resolvesTo` (0 or 1) is given, a final tick at that price is appended one fidelity step after the last.
 * `scheduledResolutionISO` is when the market was *expected* to resolve (drives the RiskEngine time ramp).
 * If it's omitted, the replay uses last tick + 14 days.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tokenId, startIso, endIso, outName, fidelityArg, resolvesArg, scheduledIso] = process.argv.slice(2);
if (!tokenId || !startIso || !endIso || !outName) {
  console.error("usage: bun sim/fetch.ts <tokenId> <startISO> <endISO> <outName> [fidelityMinutes] [resolvesTo]");
  process.exit(1);
}

const fidelity = Number(fidelityArg ?? 10);
const start = Math.floor(Date.parse(startIso) / 1000);
const end = Math.floor(Date.parse(endIso) / 1000);
const CHUNK = 7 * 24 * 3600; // the API rejects long windows

type Pt = { t: number; p: number };
const points = new Map<number, number>();

for (let from = start; from < end; from += CHUNK) {
  const to = Math.min(from + CHUNK, end);
  const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${from}&endTs=${to}&fidelity=${fidelity}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { history?: Pt[]; error?: string };
  if (body.error) throw new Error(body.error);
  for (const { t, p } of body.history ?? []) points.set(t, p);
}

const sorted = [...points.entries()].sort((a, b) => a[0] - b[0]);
if (sorted.length === 0) throw new Error("no data returned");

const t = sorted.map(([ts]) => ts);
const p = sorted.map(([, px]) => Math.round(px * 1e6));

if (resolvesArg !== undefined && resolvesArg !== "") {
  t.push(t[t.length - 1] + fidelity * 60);
  p.push(Number(resolvesArg) * 1e6);
}

const dir = join(import.meta.dir, "data");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${outName}.json`);
const resolutionTime = scheduledIso ? Math.floor(Date.parse(scheduledIso) / 1000) : undefined;
writeFileSync(out, JSON.stringify({ name: outName, tokenId, t, p, ...(resolutionTime ? { resolutionTime } : {}) }));

let maxDrop = 0;
for (let i = 1; i < p.length; i++) maxDrop = Math.max(maxDrop, p[i - 1] - p[i]);
console.log(
  `${out}: ${t.length} ticks, ${new Date(t[0] * 1000).toISOString()} -> ${new Date(t[t.length - 1] * 1000).toISOString()}, ` +
    `px ${p[0] / 1e6} -> ${p[p.length - 1] / 1e6}, max single-tick drop ${(maxDrop / 1e6).toFixed(3)}`,
);
