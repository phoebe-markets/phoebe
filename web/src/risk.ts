/**
 * TypeScript mirror of RiskEngine.liqLtvBps / maxLtvBps, so the UI can rebuild the leverage limit at every
 * historical oracle update (PriceUpdated carries price + 1-day sigma) and explain which factor binds.
 * Any change to RiskEngine.sol must be mirrored here. The live view cross-checks against the contract.
 */
export type RiskParams = {
  bands: { floor: number; safeLow: number; safeHigh: number; ceil: number }; // prices in [0, 1]
  volK: number; // k (e.g. 2.0)
  volHorizon: number; // seconds
  jump: number; // absolute price jump allowance
  hasVolOracle: boolean;
};

export type MarketParams = {
  liqLtv: number; // base, 0..1
  openBuffer: number; // 0..1
  resolutionTime: number;
  cutoffDuration: number;
  rampDuration: number;
};

export type RiskBreakdown = {
  priceFactor: number;
  timeFactor: number;
  volCap: number; // cap on liq LTV from sigma + jump
  base: number; // liqLtv * priceFactor * timeFactor
  liqLtv: number;
  maxLtv: number;
  maxLeverage: number; // 1 / (1 - maxLtv)
  binding: "price band" | "time ramp" | "volatility" | "base";
};

export function priceFactor(p: number, b: RiskParams["bands"]) {
  if (p <= b.floor || p >= b.ceil) return 0;
  if (p < b.safeLow) return (p - b.floor) / (b.safeLow - b.floor);
  if (p > b.safeHigh) return (b.ceil - p) / (b.ceil - b.safeHigh);
  return 1;
}

export function timeFactor(t: number, m: MarketParams) {
  const cutoff = m.resolutionTime > m.cutoffDuration ? m.resolutionTime - m.cutoffDuration : 0;
  if (t >= cutoff) return 0;
  const left = cutoff - t;
  return left >= m.rampDuration ? 1 : left / m.rampDuration;
}

/** @param sigma1d one-sigma absolute 1-day move (from the oracle) */
export function breakdown(p: number, sigma1d: number, t: number, r: RiskParams, m: MarketParams): RiskBreakdown {
  const pf = priceFactor(p, r.bands);
  const tf = timeFactor(t, m);
  const sigmaH = r.hasVolOracle ? sigma1d * Math.sqrt(r.volHorizon / 86_400) : 0;
  const absMove = r.jump + sigmaH * r.volK;
  const volCap = absMove === 0 ? 1 : p === 0 ? 0 : Math.max(0, 1 - absMove / p);
  const base = m.liqLtv * pf * tf;
  const liqLtv = Math.min(base, volCap);
  const maxLtv = Math.max(0, liqLtv - m.openBuffer);

  let binding: RiskBreakdown["binding"] = "base";
  if (volCap < base) binding = "volatility";
  else if (tf < 1 && tf <= pf) binding = "time ramp";
  else if (pf < 1) binding = "price band";
  return { priceFactor: pf, timeFactor: tf, volCap, base, liqLtv, maxLtv, maxLeverage: 1 / (1 - maxLtv), binding };
}
