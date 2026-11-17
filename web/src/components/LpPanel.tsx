import { useState } from "react";
import type { Snapshot } from "../store";
import { CFG, type Deployment } from "../chain";
import { pct, usd, usdCompact } from "../format";

type Tranche = "senior" | "junior";

/** Pool state for liquidity providers: size, utilization, both tranches side by side, and the account's share. */
export function PoolOverview({ snap, d }: { snap: Snapshot; d: Deployment }) {
  const p = snap.pool;
  const total = p.senior + p.junior;
  const coverage = p.debt > 0 ? p.junior / p.debt : Infinity;
  const seniorShare = total > 0 ? p.senior / total : 0.8;

  return (
    <div className="lp-overview">
      <section className="card" aria-label="Liquidity pool">
        <h2>Liquidity pool</h2>
        <div className="pool-hero">
          <div>
            <div className="label">Total LP assets</div>
            <div className="value hero">{usdCompact(total)}</div>
          </div>
          <div className="pool-split" aria-label={`Senior ${pct(seniorShare, 0)}, junior ${pct(1 - seniorShare, 0)}`}>
            <span className="ps-senior" style={{ flex: seniorShare }} />
            <span className="ps-junior" style={{ flex: 1 - seniorShare }} />
          </div>
          <div className="pool-split-legend">
            <span><i className="ps-senior" />Senior {pct(seniorShare, 0)}</span>
            <span><i className="ps-junior" />Junior {pct(1 - seniorShare, 0)}</span>
          </div>
        </div>
        <div className="tiles">
          <div className="tile">
            <div className="label">Utilization</div>
            <div className="value">{pct(p.utilization)}</div>
            <div className="sub">borrow rate {pct(p.borrowRate)} APR</div>
          </div>
          <div className="tile">
            <div className="label">Outstanding debt</div>
            <div className="value">{usdCompact(p.debt)}</div>
            <div className="sub">capacity left {usdCompact(p.capacity)}</div>
          </div>
          <div className="tile">
            <div className="label">Junior coverage</div>
            <div className="value">{Number.isFinite(coverage) ? `${coverage.toFixed(1)}x` : "—"}</div>
            <div className="sub">of debt (min 0.2x)</div>
          </div>
          <div className="tile">
            <div className="label">Backstop inventory</div>
            <div className="value">{usdCompact(p.inventoryValue)}</div>
            <div className="sub">marked, off-book</div>
          </div>
        </div>
        <div className="sub">
          Live from the contracts
          {CFG.explorer && (
            <>
              {": "}
              <a href={`${CFG.explorer}/address/${d.pool}`} target="_blank" rel="noreferrer">pool</a>
              {" · "}
              <a href={`${CFG.explorer}/address/${d.senior}`} target="_blank" rel="noreferrer">senior vault</a>
              {" · "}
              <a href={`${CFG.explorer}/address/${d.junior}`} target="_blank" rel="noreferrer">junior vault</a>
            </>
          )}
          . APRs are interest only, from the pool's utilization-based rate; junior also receives opening and liquidation fees.
          {CFG.wallet === "injected" && " On testnet the tranches were seeded by the deployer with mock USDC."}
        </div>
      </section>

      <div className="tranche-cards">
        <section className="card tranche-card" aria-label="Senior tranche">
          <div className="tc-head">
            <h2>Senior</h2>
            <span className="badge">protected</span>
          </div>
          <div className="value big">{pct(p.seniorApr, 2)} <small>APR</small></div>
          <p className="sub">Paid first and impaired last: losses reach senior only after the whole junior tranche.</p>
          <div className="summary">
            <div className="row"><span>Tranche size</span><span>{usd(p.senior)}</span></div>
            <div className="row"><span>Share price</span><span>{p.seniorSharePrice.toFixed(4)}</span></div>
            <div className="row"><span>Your position</span><span>{usd(snap.account.seniorAssets)}</span></div>
          </div>
        </section>
        <section className="card tranche-card junior" aria-label="Junior tranche">
          <div className="tc-head">
            <h2>Junior</h2>
            <span className="badge first-loss">first loss</span>
          </div>
          <div className="value big">{pct(p.juniorApr, 2)} <small>APR + fees</small></div>
          <p className="sub">
            Takes bad debt first, and earns {snap.fees.openFeeBps / 100}% of every borrow plus {snap.fees.liqFeeBps / 100}% of every liquidation.
          </p>
          <div className="summary">
            <div className="row"><span>Tranche size</span><span>{usd(p.junior)}</span></div>
            <div className="row"><span>Share price</span><span>{p.juniorSharePrice.toFixed(4)}</span></div>
            <div className="row"><span>Your position</span><span>{usd(snap.account.juniorAssets)}</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}

type FormProps = {
  snap: Snapshot;
  onDeposit: (t: Tranche, amount: number) => Promise<void>;
  onWithdraw: (t: Tranche, amount: number) => Promise<void>;
};

/** Deposit into or withdraw from one tranche. */
export function LpForm({ snap, onDeposit, onWithdraw }: FormProps) {
  const p = snap.pool;
  const [tranche, setTranche] = useState<Tranche>("junior");
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState(10_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const mine = tranche === "senior" ? snap.account.seniorAssets : snap.account.juniorAssets;
  const maxOut = Math.min(mine, tranche === "senior" ? p.maxWithdrawSenior : p.maxWithdrawJunior);
  const limit = mode === "deposit" ? snap.account.usdc : maxOut;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "deposit") await onDeposit(tranche, amount);
      else await onWithdraw(tranche, amount);
      setMsg({ text: `${mode === "deposit" ? "Deposited" : "Withdrew"} ${usd(amount)} ${mode === "deposit" ? "into" : "from"} ${tranche}` });
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  };

  const label = busy
    ? mode === "deposit" ? "Depositing…" : "Withdrawing…"
    : !snap.account.address
      ? "Connect a wallet"
      : amount <= 0
        ? "Enter an amount"
        : amount > limit + 0.01
          ? mode === "deposit" ? "Not enough USDC" : "More than withdrawable"
          : `${mode === "deposit" ? "Deposit" : "Withdraw"} ${usd(amount)}`;

  return (
    <section className="card sticky" aria-label="Deposit or withdraw">
      <h2>Provide liquidity</h2>
      <div className="seg tabs-seg" role="group" aria-label="Action">
        <button aria-pressed={mode === "deposit"} onClick={() => setMode("deposit")}>Deposit</button>
        <button aria-pressed={mode === "withdraw"} onClick={() => setMode("withdraw")}>Withdraw</button>
      </div>
      <div className="seg" role="group" aria-label="Tranche">
        <button aria-pressed={tranche === "senior"} onClick={() => setTranche("senior")}>
          Senior <small>{pct(p.seniorApr, 1)}</small>
        </button>
        <button aria-pressed={tranche === "junior"} onClick={() => setTranche("junior")}>
          Junior <small>{pct(p.juniorApr, 1)} + fees</small>
        </button>
      </div>
      <div className="field">
        <label htmlFor="lp-amt">
          <span>Amount (USDC)</span>
          <span>{mode === "deposit" ? `Balance ${usd(snap.account.usdc)}` : `Withdrawable ${usd(maxOut)}`}</span>
        </label>
        <div className="input-max">
          <input id="lp-amt" type="number" min={0} step={1000} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))} />
          <button type="button" onClick={() => setAmount(Math.floor(limit))} disabled={limit <= 0}>Max</button>
        </div>
      </div>
      <div className="summary">
        <div className="row"><span>Your {tranche}</span><span>{usd(mine)}</span></div>
        <div className="row"><span>Withdrawable now</span><span>{usd(maxOut)}</span></div>
      </div>
      <button className="btn" disabled={busy || amount <= 0 || amount > limit + 0.01} onClick={submit}>{label}</button>
      {tranche === "junior" && (
        <div className="sub" style={{ marginTop: 10 }}>
          Junior withdrawals can't push coverage below 20% of outstanding debt, so first-loss capital can't leave ahead of a loss.
        </div>
      )}
      {msg && <div className={`msg${msg.err ? " err" : ""}`}>{msg.text}</div>}
    </section>
  );
}
