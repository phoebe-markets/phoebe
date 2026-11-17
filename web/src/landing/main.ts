import "../brand/tokens.css";
import "./landing.css";
import { logoSvg } from "../brand/logo";
import { mountStars } from "../brand/stars";
import { breakdown, type MarketParams, type RiskParams } from "../risk";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;

// ------------------------------------------------------------------ brand mark
document.querySelectorAll<HTMLElement>("[data-logo]").forEach((el) => {
  el.innerHTML = logoSvg(el.dataset.logo ?? "x");
});

// ------------------------------------------------------------------ star field
mountStars($<HTMLCanvasElement>("canvas.stars"));

// ------------------------------------------------------------------ hero parallax (scroll only)
if (!reduceMotion) {
  const art = $(".hero-art");
  let queued = false;
  const update = () => {
    queued = false;
    art.style.setProperty("--py", `${(scrollY * 0.12).toFixed(1)}px`);
  };
  addEventListener(
    "scroll",
    () => {
      if (!queued) (queued = true), requestAnimationFrame(update);
    },
    { passive: true },
  );
}

// ------------------------------------------------------------------ reveal on scroll
const io = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
  { threshold: 0.12 },
);
document.querySelectorAll(".section-head, .facet, .phases, .tranche, .waterfall, .versus, .ladder, .facts, .finale, .myth").forEach((el) => {
  el.classList.add("reveal");
  io.observe(el);
});

// ------------------------------------------------------------------ phases widget
// The deploy config (contracts/script/Deploy.s.sol) and the recommended strategy from sim/RESULTS.md
const RISK: RiskParams = {
  bands: { floor: 0.03, safeLow: 0.15, safeHigh: 0.85, ceil: 0.97 },
  volK: 2,
  volHorizon: 86_400,
  jump: 0.1,
  hasVolOracle: true,
};
const DAY = 86_400;
const market = (days: number): MarketParams => ({
  liqLtv: 0.85,
  openBuffer: 0.1,
  resolutionTime: days * DAY,
  cutoffDuration: DAY,
  rampDuration: 3 * DAY,
});

/** Lit part of a moon of radius r with illuminated fraction f, waxing from the right. */
function phasePath(f: number, r = 50) {
  if (f <= 0.001) return "";
  const k = (r * Math.abs(1 - 2 * f)).toFixed(2);
  const sweep = f > 0.5 ? 1 : 0;
  return `M0 ${-r} A${r} ${r} 0 0 1 0 ${r} A${k} ${r} 0 0 ${sweep} 0 ${-r}Z`;
}

function phases() {
  const inP = $<HTMLInputElement>("#in-p");
  const inS = $<HTMLInputElement>("#in-s");
  const inT = $<HTMLInputElement>("#in-t");
  const chart = $<SVGSVGElement>("#lev-chart");
  const W = 400;
  const H = 200;
  const pad = { l: 34, r: 10, t: 12, b: 26 };
  const X = (p: number) => pad.l + p * (W - pad.l - pad.r);
  const Y = (lev: number) => pad.t + (1 - (lev - 1) / 3) * (H - pad.t - pad.b); // 1x..4x

  const render = () => {
    const p = Number(inP.value);
    const s = Number(inS.value);
    const days = Number(inT.value);
    const m = market(days);
    const b = breakdown(p, s, 0, RISK, m);

    $("#moon-phase").setAttribute("d", phasePath(p));
    $("#out-p").textContent = `${Math.round(p * 100)}¢`;
    $("#lab-p").textContent = p.toFixed(2);
    $("#lab-s").textContent = `${(s * 100).toFixed(1)}¢`;
    $("#lab-t").textContent = days >= 30 ? "30+" : days.toFixed(days % 1 ? 2 : 0);
    $("#out-lev").textContent = b.maxLtv <= 0 ? "none" : `${b.maxLeverage.toFixed(2)}×`;
    $("#out-bind").textContent = b.maxLtv <= 0 && b.timeFactor === 0 ? "resolution cutoff" : b.binding === "base" ? "base LTV" : b.binding;

    // curve across all prices at the current sigma and time
    const pts: string[] = [];
    for (let i = 0; i <= 200; i++) {
      const q = i / 200;
      const r = breakdown(q, s, 0, RISK, m);
      pts.push(`${X(q).toFixed(1)},${Y(Math.min(4, r.maxLtv > 0 ? r.maxLeverage : 1)).toFixed(1)}`);
    }
    const line = `M${pts.join("L")}`;
    const area = `${line}L${X(1)},${Y(1)}L${X(0)},${Y(1)}Z`;
    const cur = Math.min(4, b.maxLtv > 0 ? b.maxLeverage : 1);
    const grid = [1, 2, 3, 4]
      .map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${pad.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v}×</text>`)
      .join("");
    const xt = [0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${X(v)}" y="${H - 6}" text-anchor="middle">${v === 0 ? "0" : v === 1 ? "1" : v.toFixed(2).slice(1)}</text>`).join("");
    chart.innerHTML = `
      <defs>
        <linearGradient id="lev-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9b8cff" stop-opacity=".45"/><stop offset="1" stop-color="#6cb6ff" stop-opacity="0"/></linearGradient>
        <linearGradient id="lev-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6cb6ff"/><stop offset=".5" stop-color="#f4f6fb"/><stop offset="1" stop-color="#9b8cff"/></linearGradient>
      </defs>
      ${grid}${xt}
      <path d="${area}" fill="url(#lev-fill)"/>
      <path d="${line}" fill="none" stroke="url(#lev-line)" stroke-width="2" stroke-linejoin="round"/>
      <line x1="${X(p)}" x2="${X(p)}" y1="${pad.t}" y2="${Y(1)}" class="cursor"/>
      <circle cx="${X(p)}" cy="${Y(cur)}" r="9" class="halo"/><circle cx="${X(p)}" cy="${Y(cur)}" r="4" class="dot"/>`;

    // the three limits, as liquidation-LTV caps
    const rows: [string, number, boolean][] = [
      ["Price band", m.liqLtv * b.priceFactor, b.binding === "price band"],
      ["Time ramp", m.liqLtv * b.timeFactor, b.binding === "time ramp"],
      ["Volatility + jump", b.volCap, b.binding === "volatility"],
    ];
    $("#factors").innerHTML = rows
      .map(
        ([n, v, on]) =>
          `<div class="frow${on ? " on" : ""}"><span>${n}</span><span class="fbar"><i style="width:${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%"></i></span><b>${(Math.max(0, v) * 100).toFixed(0)}%</b></div>`,
      )
      .join("");
  };
  [inP, inS, inT].forEach((i) => i.addEventListener("input", render));
  render();
}
phases();

// ------------------------------------------------------------------ faceted moon
function facetMoon() {
  const svg = $<SVGSVGElement>("#facet-moon");
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const R = 92;
  const rings: [number, number][][] = [[[0, 0]]];
  const counts = [7, 13, 19, 26];
  counts.forEach((n, i) => {
    const r = (R * (i + 1)) / counts.length;
    const off = rnd() * Math.PI;
    const last = i === counts.length - 1;
    rings.push(
      Array.from({ length: n }, (_, k) => {
        const a = off + (k / n) * Math.PI * 2 + (last ? 0 : (rnd() - 0.5) * 0.25);
        const rr = last ? r : r * (0.9 + rnd() * 0.18);
        return [Math.cos(a) * rr, Math.sin(a) * rr] as [number, number];
      }).sort((p, q) => Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0])),
    );
  });
  const ang = (p: [number, number]) => (Math.atan2(p[1], p[0]) + Math.PI * 2) % (Math.PI * 2);
  const tris: [number, number][][] = [];
  // fan for the centre ring
  rings[1].forEach((p, k) => tris.push([[0, 0], p, rings[1][(k + 1) % rings[1].length]]));
  // zip consecutive rings by angle
  for (let i = 1; i < rings.length - 1; i++) {
    const A = [...rings[i]].sort((p, q) => ang(p) - ang(q));
    const B = [...rings[i + 1]].sort((p, q) => ang(p) - ang(q));
    let a = 0;
    let b = 0;
    while (a < A.length || b < B.length) {
      const a0 = A[a % A.length];
      const b0 = B[b % B.length];
      const a1 = A[(a + 1) % A.length];
      const b1 = B[(b + 1) % B.length];
      const na = a < A.length ? ang(a1) + (a + 1 >= A.length ? Math.PI * 2 : 0) : Infinity;
      const nb = b < B.length ? ang(b1) + (b + 1 >= B.length ? Math.PI * 2 : 0) : Infinity;
      if (na < nb) {
        tris.push([a0, a1, b0]);
        a++;
      } else {
        tris.push([a0, b1, b0]);
        b++;
      }
    }
  }
  // light from the upper left, as from the hero's lantern
  const L = [-0.55, -0.6, 0.58];
  const ln = Math.hypot(...L);
  const shade = (t: [number, number][]) => {
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3 / R;
    const cy = (t[0][1] + t[1][1] + t[2][1]) / 3 / R;
    const cz = Math.sqrt(Math.max(0, 1 - cx * cx - cy * cy));
    const d = Math.max(0, (cx * L[0] + cy * L[1] + cz * L[2]) / ln);
    return 0.28 + 0.72 * d * (0.85 + rnd() * 0.3);
  };
  const mix = (d: number) => {
    // deep violet → silver → white
    const stops = [
      [0, [23, 20, 52]],
      [0.35, [108, 92, 231]],
      [0.7, [201, 194, 255]],
      [1, [246, 248, 255]],
    ] as const;
    let i = 0;
    while (i < stops.length - 2 && d > stops[i + 1][0]) i++;
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    const u = Math.min(1, Math.max(0, (d - p0) / (p1 - p0)));
    return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * u)).join(",")})`;
  };
  svg.innerHTML = tris
    .map((t) => `<polygon points="${t.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="${mix(shade(t))}"/>`)
    .join("");
}
facetMoon();
