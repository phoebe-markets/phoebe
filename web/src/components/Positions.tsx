import { useState } from "react";
import type { PositionView, Snapshot } from "../store";
import { cents, pct, usd } from "../format";
import { CFG } from "../chain";

/** Health bar: fill = current LTV, tick = liquidation LTV. Status color plus a text label, never color alone. */
function Health({ p }: { p: PositionView }) {
  const ratio = p.liqLtv > 0 ? p.ltv / p.liqLtv : Infinity;
  const status = p.liquidatable ? "critical" : ratio > 0.9 ? "warning" : "good";
  const label = p.liquidatable ? "Liquidatable" : ratio > 0.9 ? "Near limit" : "Healthy";
  const scale = Math.max(1, p.liqLtv * 1.25, Math.min(p.ltv, 1.5));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div className="health" aria-label={`LTV ${pct(p.ltv)} vs liquidation ${pct(p.liqLtv)}`}>
        <span style={{ width: `${Math.min(1, p.ltv / scale) * 100}%`, background: `var(--${status === "good" ? "good" : status === "warning" ? "warning" : "critical"})` }} />
        {p.liqLtv > 0 && <i style={{ left: `${(p.liqLtv / scale) * 100}%` }} />}
      </div>
      <span className={`badge ${status}`}>
        {status === "good" ? "●" : status === "warning" ? "▲" : "✕"} {label}
      </span>
    </div>
  );
}

type Props = {
  snap: Snapshot;
  onClose: (id: bigint) => Promise<void>;
  onAddMargin: (id: bigint, amount: number) => Promise<void>;
  /** Resolved markets: pay the position out at the resolved value. */
  onSettle?: (p: PositionView) => Promise<void>;
};

export function Positions({ snap, onClose, onAddMargin, onSettle }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ps = snap.account.positions;

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-label="Your positions">
      <h2>Your positions{ps.length > 0 && <span className="count">{ps.length}</span>}</h2>
      {ps.length === 0 ? (
        <div className="empty">No open positions for this account.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Market</th>
                <th>Side</th>
                <th className="num">Entry → now</th>
                <th className="num">Value</th>
                <th className="num">Debt</th>
                <th className="num">PnL</th>
                <th>LTV vs liquidation</th>
                <th>Auction</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ps.map((p) => (
                <tr key={String(p.id)}>
                  <td>{String(p.id)}</td>
                  <td>{snap.markets[p.market]?.name}</td>
                  <td>
                    <i className="key" style={{ background: p.side === "YES" ? "var(--series-yes)" : "var(--series-no)" }} />
                    {p.side}
                  </td>
                  <td className="num">{cents(p.entry)} → {cents(p.price)}</td>
                  <td className="num">{usd(p.value)}</td>
                  <td className="num">{usd(p.debt)}</td>
                  <td className="num">{usd(p.pnl)}</td>
                  <td><Health p={p} /></td>
                  <td>{p.flaggedSince ? <span className="badge warning">▲ bonus {p.bonusBps / 100}%</span> : <span className="sub">—</span>}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    {p.resolved ? (
                      <button className="btn" disabled={busy !== null || !onSettle} onClick={() => run(`s${p.id}`, () => onSettle!(p))}
                        title="The market resolved: repay the debt from the payout and send you the rest">
                        {busy === `s${p.id}` ? "…" : "Settle"}
                      </button>
                    ) : (<>
                    <button className="btn ghost" disabled={busy !== null} onClick={() => run(`m${p.id}`, () => onAddMargin(p.id, Math.round(p.debt * 0.25)))}
                      title={`Repay 25% of the debt with fresh ${CFG.asset}`}>
                      {busy === `m${p.id}` ? "…" : "Deleverage 25%"}
                    </button>
                    <button className="btn ghost" disabled={busy !== null} onClick={() => run(`c${p.id}`, () => onClose(p.id))}>
                      {busy === `c${p.id}` ? "…" : "Close"}
                    </button>
                    </>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {err && <div className="msg err">{err}</div>}
    </section>
  );
}
