import { expect, test } from "bun:test";
import type { OrderBookSummary } from "@polymarket/clob-client-v2";
import { planHedge } from "./hedger";

const sh = (x: number) => BigInt(Math.round(x * 1e6));
const book = (bids: [number, number][], asks: [number, number][]) =>
  ({
    bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })),
    asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })),
    tick_size: "0.01",
    min_order_size: "5",
    neg_risk: false,
  }) as unknown as OrderBookSummary;

// YES 0.44/0.46, NO 0.54/0.56 (mirrored books), plenty of depth
const yesBook = book([[0.43, 500], [0.44, 300]], [[0.47, 500], [0.46, 300]]);
const noBook = book([[0.53, 500], [0.54, 300]], [[0.57, 500], [0.56, 300]]);
const cfg = { bandShares: 5, slippage: 0.02, maxOrderUsd: 25 };

test("inside the band: nothing", () => {
  expect(planHedge({ i: 0, Y: sh(60), N: sh(56), yesBook, noBook }, 100, 200, cfg)).toBeUndefined();
});

test("short YES (protocol bought YES): buy YES back, limit = ask + slippage", () => {
  const p = planHedge({ i: 0, Y: sh(40), N: sh(60), yesBook, noBook }, 100, 200, cfg)!;
  expect(p.side).toBe("BUY");
  expect(p.token).toBe("YES");
  expect(p.limit).toBeCloseTo(0.48, 9);
  expect(p.shares).toBe(20);
  expect(p.usd).toBeCloseTo(9.6, 9);
});

test("short NO: buy NO", () => {
  const p = planHedge({ i: 1, Y: sh(70), N: sh(50), yesBook, noBook }, 100, 200, cfg)!;
  expect([p.side, p.token, p.market]).toEqual(["BUY", "NO", 1]);
  expect(p.limit).toBeCloseTo(0.58, 9);
});

test("no free pUSD: sell the long side instead, limit = bid - slippage", () => {
  const p = planHedge({ i: 0, Y: sh(40), N: sh(60), yesBook, noBook }, 0, 200, cfg)!;
  expect([p.side, p.token]).toEqual(["SELL", "NO"]);
  expect(p.limit).toBeCloseTo(0.52, 9);
  expect(p.shares).toBe(20);
});

test("per-order cap limits size", () => {
  const p = planHedge({ i: 0, Y: sh(0), N: sh(200), yesBook, noBook }, 1000, 1000, cfg)!;
  expect(p.usd).toBeLessThanOrEqual(25 + 1e-9);
  expect(p.shares).toBeCloseTo(52.08, 2); // 25 / 0.48, floored to cents
});

test("daily notional cap applies to buys and sells", () => {
  expect(planHedge({ i: 0, Y: sh(40), N: sh(60), yesBook, noBook }, 100, 1, cfg)).toBeUndefined();
  const p = planHedge({ i: 0, Y: sh(40), N: sh(60), yesBook, noBook }, 0, 5, cfg)!; // no pUSD: sell, $5 left
  expect(p.side).toBe("SELL");
  expect(p.usd).toBeLessThanOrEqual(5 + 1e-9);
});

test("never crosses more depth than the book shows within the limit", () => {
  const shallow = book([[0.44, 300]], [[0.46, 8]]); // 8 shares at/below 0.48
  const p = planHedge({ i: 0, Y: sh(40), N: sh(60), yesBook: shallow, noBook }, 100, 200, cfg)!;
  expect([p.side, p.token, p.shares]).toEqual(["BUY", "YES", 8]);
});
