import type { MarketView, SideView } from "../store";
import { cents, lev, pct, when } from "../format";
import { MarketCharts } from "./Charts";
import type { HistoryPoint } from "../store";

function Factor({ name, value, display, binding, hint }: { name: string; value: number; display: string; binding: boolean; hint: string }) {
  return (
    <div className={`factor${binding ? " binding" : ""}`} title={hint}>
      <span className="name">{name}</span>
      <div className="meter" role="meter" aria-label={name} aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </div>
      <span className="num">{display}</span>
    </div>
  );
}

/** Explains the current limit: each factor, which one binds, and the contract's own figure as a cross-check. */
function Why({ s, label }: { s: SideView; label: string }) {
  const w = s.why;
  const drift = Math.abs(w.maxLtv - s.maxLtv) > 0.002; // TS mirror vs contract
  return (
    <div className="why-block">
      <div className="why-head">
        <h3>
          Long {label} is capped at <b>{lev(1 / (1 - s.maxLtv))}</b>
        </h3>
        {!s.openAllowed && <span className="badge critical">✕ new positions closed</span>}
      </div>
      <div className="sub">
        Liquidation LTV = min(base × price band × time ramp, volatility cap). Max opening LTV sits 10 points below it.
      </div>
      <div className="why">
        <Factor name="Price band" value={w.priceFactor} display={pct(w.priceFactor, 0)} binding={w.binding === "price band"}
          hint="Full leverage between 15¢ and 85¢, falling to zero at 3¢ / 97¢: near-certain shares can only jump against you" />
        <Factor name="Time ramp" value={w.timeFactor} display={pct(w.timeFactor, 0)} binding={w.binding === "time ramp"}
          hint="Ramps to zero over the 3 days before a cutoff 24h ahead of scheduled resolution, so nothing levered meets the 0/1 jump" />
        <Factor name="Volatility + jump cap" value={w.volCap} display={pct(w.volCap, 0)} binding={w.binding === "volatility"}
          hint="Collateral cushion must cover 2σ of a day's move plus a 10¢ jump: 1 − (2σ + 0.10) / price" />
        <Factor name="Liquidation LTV" value={s.liqLtv} display={pct(s.liqLtv, 1)} binding={false} hint="Positions above this LTV can be liquidated" />
      </div>
      {drift && <div className="msg err">UI risk mirror differs from the contract ({pct(w.maxLtv)} vs {pct(s.maxLtv)}); trust the contract.</div>}
    </div>
  );
}

type BarProps = {
  m: MarketView;
  markets: { index: number; name: string }[];
  onPick: (i: number) => void;
  chainTime: number;
};

/** The market header: which market, when it resolves, and its key numbers. */
export function MarketBar({ m, markets, onPick, chainTime }: BarProps) {
  const hoursLeft = (m.resolutionTime - chainTime) / 3600;
  const left = hoursLeft > 48 ? `${Math.round(hoursLeft / 24)} days` : `${Math.max(0, Math.round(hoursLeft))} h`;
  return (
    <section className="marketbar" aria-label="Market">
      <div className="mb-title">
        <span className="kicker">Market</span>
        {markets.length > 1 ? (
          <select className="market-select" aria-label="Market" value={m.index} onChange={(e) => onPick(Number(e.target.value))}>
            {markets.map((mk) => (
              <option key={mk.index} value={mk.index}>{mk.name}</option>
            ))}
          </select>
        ) : (
          <h1 className="market-name">{m.name}</h1>
        )}
        <span className="sub">Resolves {when(m.resolutionTime)} UTC · {left} left</span>
      </div>
      <dl className="mb-stats">
        <div>
          <dt><i className="key" style={{ background: "var(--series-yes)" }} />YES</dt>
          <dd>{cents(m.yes.price)}</dd>
        </div>
        <div>
          <dt><i className="key" style={{ background: "var(--series-no)" }} />NO</dt>
          <dd>{cents(m.no.price)}</dd>
        </div>
        <div>
          <dt>1-day σ</dt>
          <dd>{cents(m.yes.sigma1d)}</dd>
        </div>
        <div className="hl">
          <dt>Max leverage YES / NO</dt>
          <dd>{lev(1 / (1 - m.yes.maxLtv))} <span>/</span> {lev(1 / (1 - m.no.maxLtv))}</dd>
        </div>
      </dl>
    </section>
  );
}

export function MarketPanel({ m, history, side }: { m: MarketView; history: HistoryPoint[]; side: "YES" | "NO" }) {
  const s = side === "YES" ? m.yes : m.no;
  return (
    <section className="card" aria-label={`Market ${m.name}`}>
      <h2>Price and leverage</h2>
      <MarketCharts history={history} />
      <Why s={s} label={side} />
    </section>
  );
}
