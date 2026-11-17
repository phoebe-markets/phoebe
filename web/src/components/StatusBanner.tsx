import type { Snapshot } from "../store";
import { CFG } from "../chain";
import { usd } from "../format";

/** Mainnet risk notice plus the protocol's live guard states (pause, market maker offline, resolved markets). */
export function StatusBanner({ snap }: { snap: Snapshot }) {
  const st = snap.status;
  const caps = st.depositRoom.every(Number.isFinite)
    ? ` Deposit room left: senior ${usd(st.depositRoom[0])}, junior ${usd(st.depositRoom[1])}.`
    : "";
  const resolved = snap.markets.filter((m) => st.resolved[m.index]).map((m) => m.name);
  return (
    <>
      {CFG.mainnet && (
        <div className="banner" role="note">
          <strong>Real money, unaudited contracts.</strong> A small live beta on Polygon with hard caps: leveraged positions can
          be liquidated and LP deposits can take losses.{caps}
        </div>
      )}
      {st.pmPaused && <div className="banner" role="status">New positions are paused by the guardian. Closing, adding margin and settling still work.</div>}
      {st.depositsPaused && <div className="banner" role="status">LP deposits are paused. Withdrawals still work, within the junior-coverage rule.</div>}
      {!st.venueActive && (
        <div className="banner" role="status">
          The market maker is offline (it steps back when it can't reach Polymarket or its exposure is over the limit), so
          opening and closing are unavailable for now. Liquidations and settlement don't depend on it.
        </div>
      )}
      {resolved.length > 0 && (
        <div className="banner" role="status">Resolved: {resolved.join("; ")}. Positions there are settled at the outcome; use Settle if yours is still open.</div>
      )}
    </>
  );
}
