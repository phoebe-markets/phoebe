import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CFG,
  DEMO_ACCOUNTS,
  NET,
  NETWORKS,
  connectInjected,
  demoWallet,
  hasInjectedWallet,
  loadProtocol,
  onInjectedChange,
  switchNet,
  type Abis,
  type Deployment,
  type Net,
  type Wallet,
} from "./chain";
import { useProtocol } from "./store";
import { addMargin, closePosition, deposit, explain, mintTestUsdc, openPosition, withdraw } from "./actions";
import { MarketPanel } from "./components/MarketPanel";
import { TradePanel } from "./components/TradePanel";
import { Positions } from "./components/Positions";
import { LpPanel } from "./components/LpPanel";
import { ActivityFeed } from "./components/Activity";
import { shortAddr, usd, when } from "./format";

type Theme = "system" | "dark" | "light";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("phoebe-theme") as Theme) ?? "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("phoebe-theme", theme);
    } catch {
      /* private mode: theme just won't persist */
    }
  }, [theme]);
  return [theme, setTheme];
}

/** Local: pick an Anvil demo account. Testnet: a connected browser wallet (null until connected). */
function useWallet() {
  const [demoIdx, setDemoIdx] = useState(0);
  const [injected, setInjected] = useState<Wallet | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const demo = useMemo(() => (CFG.wallet === "demo" ? demoWallet(DEMO_ACCOUNTS[demoIdx].pk) : null), [demoIdx]);

  const connect = useCallback(async () => {
    setWalletErr(null);
    try {
      setInjected(await connectInjected());
    } catch (e) {
      setWalletErr((e as Error).message.split("\n")[0]);
    }
  }, []);

  useEffect(() => {
    if (CFG.wallet !== "injected" || !hasInjectedWallet()) return;
    // reconnect silently if this site is already authorized
    const eth = (window as unknown as { ethereum: { request(a: { method: string }): Promise<unknown> } }).ethereum;
    eth.request({ method: "eth_accounts" }).then(
      (a) => {
        if ((a as string[]).length) void connect();
      },
      () => {},
    );
    return onInjectedChange(() => {
      eth.request({ method: "eth_accounts" }).then((a) => ((a as string[]).length ? connect() : setInjected(null)), () => {});
    });
  }, [connect]);

  return { wallet: demo ?? injected, demoIdx, setDemoIdx, connect, walletErr };
}

export function App() {
  const [proto, setProto] = useState<{ d: Deployment; abi: Abis } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const { wallet, demoIdx, setDemoIdx, connect, walletErr } = useWallet();
  const [marketIdx, setMarketIdx] = useState(0);
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    loadProtocol().then(setProto, (e) => setLoadErr((e as Error).message));
  }, []);

  const address = wallet?.account.address ?? null;
  const { snap, error, refreshNow } = useProtocol(proto?.d ?? null, proto?.abi ?? null, address);

  if (loadErr) {
    return (
      <div className="app">
        <div className="banner">
          Couldn't load the protocol on {CFG.label}: {loadErr}.{" "}
          {NET === "local" ? (
            <>Start a local chain with <code>demo/replay.sh</code>, then reload, or <a href="?net=amoy">open the Amoy testnet</a>.</>
          ) : (
            <>Check the RPC, or <a href="?net=local">open a local replay</a>.</>
          )}
        </div>
      </div>
    );
  }
  if (!proto || !snap) {
    return (
      <div className="app">
        <div className="empty">{error ? `Waiting for the chain: ${error}` : "Loading…"}</div>
      </div>
    );
  }

  const { d, abi } = proto;
  // wrap actions: need a wallet; friendly revert reasons; refresh immediately instead of waiting for the poll
  const act = <A extends unknown[]>(f: (w: Wallet, ...a: A) => Promise<unknown>) => async (...a: A) => {
    if (!wallet) throw new Error("Connect a wallet first");
    try {
      await f(wallet, ...a);
    } catch (e) {
      throw new Error(explain(e));
    } finally {
      refreshNow();
    }
  };
  const m = snap.markets[Math.min(marketIdx, snap.markets.length - 1)];

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          Phoebe<small>leverage on prediction markets</small>
        </div>
        {snap.markets.length > 1 && (
          <select aria-label="Market" value={marketIdx} onChange={(e) => setMarketIdx(Number(e.target.value))} style={{ width: "auto" }}>
            {snap.markets.map((mk) => (
              <option key={mk.index} value={mk.index}>{mk.name}</option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <select aria-label="Network" value={NET} onChange={(e) => switchNet(e.target.value as Net)} style={{ width: "auto" }}>
          {(Object.keys(NETWORKS) as Net[]).map((n) => (
            <option key={n} value={n}>{NETWORKS[n].label}</option>
          ))}
        </select>
        <span className="chip" title="Chain time (replays run on historical time)">⏱ {when(snap.chainTime)} UTC</span>
        <span className="chip">block {String(snap.block)}</span>
        {CFG.wallet === "demo" ? (
          <select aria-label="Account" value={demoIdx} onChange={(e) => setDemoIdx(Number(e.target.value))} style={{ width: "auto" }}>
            {DEMO_ACCOUNTS.map((a, i) => (
              <option key={a.label} value={i}>{a.label} · {shortAddr(demoWallet(a.pk).account.address)}</option>
            ))}
          </select>
        ) : address ? (
          <a className="chip" href={`${CFG.explorer}/address/${address}`} target="_blank" rel="noreferrer">{shortAddr(address)}</a>
        ) : (
          <button className="btn" style={{ width: "auto", padding: "6px 14px" }} onClick={connect}>Connect wallet</button>
        )}
        {address && <span className="chip">{usd(snap.account.usdc)} USDC</span>}
        {CFG.wallet === "injected" && address && (
          <button className="btn ghost" title="The testnet USDC is a freely mintable mock"
            onClick={() => {
              setFaucetMsg("Minting…");
              act((w: Wallet) => mintTestUsdc(w, d, abi))().then(
                () => setFaucetMsg(null),
                (e) => setFaucetMsg((e as Error).message),
              );
            }}>
            Get 10k test USDC
          </button>
        )}
        <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)} style={{ width: "auto" }}>
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </header>

      {error && <div className="banner">Chain read failed, showing the last good state: {error}</div>}
      {walletErr && <div className="banner">{walletErr}</div>}
      {faucetMsg && <div className="banner">{faucetMsg}</div>}
      {NET === "amoy" && (
        <div className="sub">
          Live on Polygon Amoy: prices stream from Polymarket via the keeper; fills come from the keeper's inventory at oracle ±0.5%.
          Testnet funds only. Need gas? Get Amoy POL from a faucet.
        </div>
      )}

      <div className="grid-main">
        <MarketPanel m={m} history={snap.history[m.index] ?? []} side={side} chainTime={snap.chainTime} />
        <TradePanel key={`trade-${address}`} m={m} snap={snap} side={side} setSide={setSide}
          onOpen={act((w: Wallet, tokenId: bigint, margin: number, borrow: number) => openPosition(w, d, abi, tokenId, margin, borrow))} />
      </div>

      <Positions key={`pos-${address}`} snap={snap}
        onClose={act((w: Wallet, id: bigint) => closePosition(w, d, abi, id))}
        onAddMargin={act((w: Wallet, id: bigint, amount: number) => addMargin(w, d, abi, id, amount))} />

      <div className="grid-2">
        <LpPanel key={`lp-${address}`} snap={snap}
          onDeposit={act((w: Wallet, t: "senior" | "junior", amount: number) => deposit(w, d, abi, t, amount))}
          onWithdraw={act((w: Wallet, t: "senior" | "junior", amount: number) => withdraw(w, d, abi, t, amount))} />
        <ActivityFeed items={snap.activity} />
      </div>
    </div>
  );
}
