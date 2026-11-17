import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { Snapshot } from "../store";
import { offrampPaused, pusdBalance, USDCE } from "../actions";
import { usd } from "../format";

const NATIVE_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const SWAP_URL = `https://app.uniswap.org/swap?chain=polygon&inputCurrency=${NATIVE_USDC}&outputCurrency=${USDCE}`;

/**
 * USDC.e (bridged USDC) is the pool asset on mainnet: it's what Polymarket's outcome tokens are redeemed for. Polymarket
 * users hold pUSD, which their off-ramp unwraps 1:1 into USDC.e; anyone holding native USDC swaps it on Uniswap.
 */
export function UsdcePanel({ snap, address, onUnwrap }: { snap: Snapshot; address: Address; onUnwrap: (amount: number) => Promise<void> }) {
  const [pusd, setPusd] = useState<number | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [amount, setAmount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      pusdBalance(address).then((b) => alive && setPusd(b), () => {});
      offrampPaused().then((p) => alive && setPaused(p as boolean), () => {});
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
      await onUnwrap(amount);
      setMsg({ text: `Unwrapped ${usd(amount)} pUSD into USDC.e` });
      setPusd(await pusdBalance(address));
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  };

  const max = pusd ?? 0;
  return (
    <section className="card" aria-label="Get USDC.e">
      <h2>Get USDC.e</h2>
      <div className="summary">
        <div className="row"><span>USDC.e (trade and LP with this)</span><span>{usd(snap.account.usdc)}</span></div>
        <div className="row"><span>pUSD (Polymarket balance)</span><span>{pusd === null ? "…" : usd(pusd)}</span></div>
      </div>
      {max > 0 && (
        <>
          <div className="field">
            <label htmlFor="unwrap-amt">
              <span>Unwrap pUSD</span>
              <span>{paused ? "Polymarket has paused unwrapping" : "via Polymarket's off-ramp, 1:1"}</span>
            </label>
            <div className="input-max">
              <input id="unwrap-amt" type="number" min={0} step={1} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))} />
              <button type="button" onClick={() => setAmount(Math.floor(max * 100) / 100)}>Max</button>
            </div>
          </div>
          <button className="btn" disabled={busy || paused === true || amount <= 0 || amount > max + 1e-6} onClick={submit}>
            {busy ? "Unwrapping…" : amount > max + 1e-6 ? "Not enough pUSD" : `Unwrap ${usd(amount)} into USDC.e`}
          </button>
        </>
      )}
      <div className="sub" style={{ marginTop: 10 }}>
        Phoebe settles in bridged USDC.e, the token Polymarket's outcome shares pay out in. Holding native USDC?{" "}
        <a href={SWAP_URL} target="_blank" rel="noreferrer">Swap it to USDC.e on Uniswap ↗</a> (stable pair, ~0.01% fee).
      </div>
      {msg && <div className={`msg${msg.err ? " err" : ""}`}>{msg.text}</div>}
    </section>
  );
}
