export const usd = (x: number, dp = 0) =>
  `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

/** Compact money for tiles: $1.28M, $412K, $950 */
export const usdCompact = (x: number) => {
  const a = Math.abs(x);
  const s = x < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
};

export const pct = (x: number, dp = 1) => `${(x * 100).toFixed(dp)}%`;
export const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;
export const lev = (x: number) => (Number.isFinite(x) ? `${x.toFixed(2)}x` : "—");

export const when = (t: number) =>
  new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
