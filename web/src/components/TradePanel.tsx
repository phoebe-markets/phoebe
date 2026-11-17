import { useEffect, useState } from "react";
import type { MarketView, Snapshot } from "../store";
import { cents, lev, pct, usd } from "../format";

type Props = {
  m: MarketView;
  snap: Snapshot;
  side: "YES" | "NO";
  setSide: (s: "YES" | "NO") => void;
  onOpen: (tokenId: bigint, margin: number, borrow: number) => Promise<void>;
};

const SPREAD = 0.005; // MockVenue half-spread; with a real venue this comes from the order book

export function TradePanel({ m, snap, side, setSide, onOpen }: Props) {
  const s = side === "YES" ? m.yes : m.no;
  const maxLev = s.openAllowed ? 1 / (1 - s.maxLtv) : 1;
  const [margin, setMargin] = useState(1000);
  const [levX, setLevX] = useState(2);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  // keep the slider inside what the risk engine allows right now (it moves with price, time and volatility)
  const ceiling = Math.max(1, Math.floor(maxLev * 0.98 * 100) / 100);
  useEffect(() => {
    if (levX > ceiling) setLevX(ceiling);
  }, [ceiling, levX]);

  let borrow = margin * (levX - 1);
  const capped = s.maxPositionBorrow > 0 && borrow > s.maxPositionBorrow;
  if (capped) borrow = s.maxPositionBorrow;
  const notional = margin + borrow;
  const fill = s.price * (1 + SPREAD);
  const shares = fill > 0 ? notional / fill : 0;
  const fee = (borrow * snap.fees.openFeeBps) / 10_000;
  const ltv = shares > 0 ? borrow / (shares * s.price) : 0;
  // liquidation price at today's limit: debt = shares * p * liqLtv (ignores the limit moving with price)
  const liqPrice = shares > 0 && s.liqLtv > 0 ? borrow / (shares * s.liqLtv) : NaN;
  const canOpen = s.openAllowed && margin > 0 && margin + fee <= snap.account.usdc && ltv <= s.maxLtv;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await onOpen(s.id, margin, borrow);
      setMsg({ text: `Opened ${lev(notional / margin)} long ${side}` });
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Open a position">
      <h2>Trade</h2>
      <div className="seg" role="group" aria-label="Side">
        <button aria-pressed={side === "YES"} onClick={() => setSide("YES")}>
          <i className="key" style={{ background: "var(--series-yes)" }} />
          Long YES {cents(m.yes.price)}
        </button>
        <button aria-pressed={side === "NO"} onClick={() => setSide("NO")}>
          <i className="key" style={{ background: "var(--series-no)" }} />
          Long NO {cents(m.no.price)}
        </button>
      </div>

      <div className="field">
        <label htmlFor="margin">
          <span>Margin (USDC)</span>
          <span>Balance {usd(snap.account.usdc)}</span>
        </label>
        <input id="margin" type="number" min={0} step={100} value={margin} onChange={(e) => setMargin(Math.max(0, Number(e.target.value)))} />
      </div>

      <div className="field">
        <label htmlFor="lev">
          <span>Leverage {lev(levX)}</span>
          <span>max {lev(maxLev)} now</span>
        </label>
        <input id="lev" type="range" min={1} max={Math.max(1.01, ceiling)} step={0.01} value={Math.min(levX, ceiling)} disabled={ceiling <= 1}
          onChange={(e) => setLevX(Number(e.target.value))} />
      </div>

      <div className="summary">
        <div className="row"><span>Borrowed from pool</span><span>{usd(borrow)}</span></div>
        <div className="row"><span>Position size</span><span>{usd(notional)} · {shares.toLocaleString("en-US", { maximumFractionDigits: 0 })} shares</span></div>
        <div className="row"><span>Est. fill</span><span>{cents(fill)}</span></div>
        <div className="row"><span>LTV at open</span><span>{pct(ltv)} (max {pct(s.maxLtv)})</span></div>
        <div className="row"><span>Liquidation price today</span><span>{Number.isFinite(liqPrice) && borrow > 0 ? cents(liqPrice) : "—"}</span></div>
        <div className="row"><span>Opening fee ({snap.fees.openFeeBps / 100}% of borrow)</span><span>{usd(fee, 2)}</span></div>
      </div>
      {capped && <div className="msg">Capped at this market's per-position borrow limit ({usd(s.maxPositionBorrow)}).</div>}
      <div className="sub" style={{ marginBottom: 10 }}>
        The liquidation line moves with volatility and as resolution nears. Liquidation costs a {snap.fees.bonusBps / 100}% bonus
        (rising {snap.fees.rampPerHour / 100}%/h if nobody takes it) plus a {snap.fees.liqFeeBps / 100}% fee.
      </div>
      <button className="btn" disabled={!canOpen || busy} onClick={submit}>
        {busy ? "Opening…" : !s.openAllowed ? "Market closed to new positions" : `Open ${lev(levX)} long ${side}`}
      </button>
      {msg && <div className={`msg${msg.err ? " err" : ""}`}>{msg.text}</div>}
    </section>
  );
}
