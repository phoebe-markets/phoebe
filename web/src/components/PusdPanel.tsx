import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { Snapshot } from "../store";
import { onrampPaused, usdceBalance, USDCE } from "../actions";
import { usd } from "../format";

const NATIVE_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const SWAP_URL = `https://app.uniswap.org/swap?chain=polygon&inputCurrency=${NATIVE_USDC}&outputCurrency=${USDCE}`;

/**
 * pUSD is Polymarket's collateral and the pool asset on mainnet. Polymarket's on-ramp wraps USDC.e 1:1 (native USDC
 * wrapping is paused on their side), so this card shows both balances and wraps USDC.e into pUSD.
 */
export function PusdPanel({ snap, address, onWrap }: { snap: Snapshot; address: Address; onWrap: (amount: number) => Promise<void> }) {
  const [usdce, setUsdce] = useState<number | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [amount, setAmount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      usdceBalance(address).then((b) => alive && setUsdce(b), () => {});
      onrampPaused().then((p) => alive && setPaused(p as boolean), () => {});
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [address, snap.block]);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await onWrap(amount);
      setMsg({ text: `Wrapped ${usd(amount)} USDC.e into pUSD` });
      setUsdce(await usdceBalance(address));
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  };

  const max = usdce ?? 0;
  return (
    <section className="card" aria-label="Get pUSD">
      <h2>Get pUSD</h2>
      <div className="summary">
        <div className="row"><span>pUSD (trade and LP with this)</span><span>{usd(snap.account.usdc)}</span></div>
        <div className="row"><span>USDC.e (wraps 1:1 into pUSD)</span><span>{usdce === null ? "…" : usd(usdce)}</span></div>
      </div>
      <div className="field">
        <label htmlFor="wrap-amt">
          <span>Wrap USDC.e</span>
          <span>{paused ? "Polymarket has paused USDC.e wrapping" : "via Polymarket's on-ramp"}</span>
        </label>
        <div className="input-max">
          <input id="wrap-amt" type="number" min={0} step={1} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))} />
          <button type="button" onClick={() => setAmount(Math.floor(max * 100) / 100)} disabled={max <= 0}>Max</button>
        </div>
      </div>
      <button className="btn" disabled={busy || paused === true || amount <= 0 || amount > max + 1e-6} onClick={submit}>
        {busy ? "Wrapping…" : amount > max + 1e-6 ? "Not enough USDC.e" : `Wrap ${usd(amount)} into pUSD`}
      </button>
      <div className="sub" style={{ marginTop: 10 }}>
        Polymarket currently only wraps bridged USDC.e. Holding native USDC?{" "}
        <a href={SWAP_URL} target="_blank" rel="noreferrer">Swap it to USDC.e on Uniswap ↗</a> (stable pair, ~0.01% fee), then wrap here.
      </div>
      {msg && <div className={`msg${msg.err ? " err" : ""}`}>{msg.text}</div>}
    </section>
  );
}
