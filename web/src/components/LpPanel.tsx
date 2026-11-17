import { useState } from "react";
import type { Snapshot } from "../store";
import { pct, usd, usdCompact } from "../format";

type Props = {
  snap: Snapshot;
  onDeposit: (t: "senior" | "junior", amount: number) => Promise<void>;
  onWithdraw: (t: "senior" | "junior", amount: number) => Promise<void>;
};

export function LpPanel({ snap, onDeposit, onWithdraw }: Props) {
  const p = snap.pool;
  const [tranche, setTranche] = useState<"senior" | "junior">("junior");
  const [amount, setAmount] = useState(10_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const total = p.senior + p.junior;
  const coverage = p.debt > 0 ? p.junior / p.debt : Infinity;
  const mine = tranche === "senior" ? snap.account.seniorAssets : snap.account.juniorAssets;
  const maxOut = Math.min(mine, tranche === "senior" ? p.maxWithdrawSenior : p.maxWithdrawJunior);

  const run = async (f: () => Promise<void>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await f();
      setMsg({ text: ok });
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Liquidity pool">
      <h2>Liquidity pool</h2>
      <div className="tiles">
        <div className="tile">
          <div className="label">Senior tranche</div>
          <div className="value">{usdCompact(p.senior)}</div>
          <div className="sub">steady yield, protected</div>
        </div>
        <div className="tile">
          <div className="label">Junior tranche</div>
          <div className="value">{usdCompact(p.junior)}</div>
          <div className="sub">first loss, boosted yield + all fees</div>
        </div>
        <div className="tile">
          <div className="label">Utilization</div>
          <div className="value">{pct(p.utilization)}</div>
          <div className="sub">borrow rate {pct(p.borrowRate)} APR</div>
        </div>
        <div className="tile">
          <div className="label">Junior coverage</div>
          <div className="value">{Number.isFinite(coverage) ? `${coverage.toFixed(1)}x` : "—"}</div>
          <div className="sub">of debt (min 0.2x)</div>
        </div>
      </div>

      <div className="summary">
        <div className="row"><span>Total LP assets</span><span>{usd(total)}</span></div>
        <div className="row"><span>Outstanding debt</span><span>{usd(p.debt)}</span></div>
        <div className="row"><span>Borrow capacity left</span><span>{usd(p.capacity)}</span></div>
        <div className="row"><span>Backstop inventory (marked, off-book)</span><span>{usd(p.inventoryValue)}</span></div>
      </div>

      <div className="seg" role="group" aria-label="Tranche">
        <button aria-pressed={tranche === "senior"} onClick={() => setTranche("senior")}>Senior</button>
        <button aria-pressed={tranche === "junior"} onClick={() => setTranche("junior")}>Junior</button>
      </div>
      <div className="field">
        <label htmlFor="lp-amt">
          <span>Amount (USDC)</span>
          <span>Your {tranche}: {usd(mine)} · withdrawable {usd(maxOut)}</span>
        </label>
        <input id="lp-amt" type="number" min={0} step={1000} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" disabled={busy || amount <= 0 || amount > snap.account.usdc} onClick={() => run(() => onDeposit(tranche, amount), `Deposited ${usd(amount)}`)}>
          Deposit
        </button>
        <button className="btn ghost" style={{ width: "100%" }} disabled={busy || amount <= 0 || amount > maxOut + 0.01}
          onClick={() => run(() => onWithdraw(tranche, amount), `Withdrew ${usd(amount)}`)}>
          Withdraw
        </button>
      </div>
      {tranche === "junior" && (
        <div className="sub" style={{ marginTop: 8 }}>
          Junior withdrawals can't push coverage below 20% of outstanding debt, so first-loss capital can't flee ahead of a jump.
        </div>
      )}
      {msg && <div className={`msg${msg.err ? " err" : ""}`}>{msg.text}</div>}
    </section>
  );
}
