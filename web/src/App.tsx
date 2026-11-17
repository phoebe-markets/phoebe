import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { getWalletClient } from "@wagmi/core";
import { polygonAmoy } from "viem/chains";
import { wagmiConfig } from "./wagmi";
import {
  CFG,
  DEMO_ACCOUNTS,
  NET,
  NETWORKS,
  demoWallet,
  loadProtocol,
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

/**
 * Local: pick an Anvil demo account. Testnet: a browser wallet via wagmi. `getWallet()` returns a wallet client that
 * is guaranteed to be on the right chain (switching / adding Amoy first if needed), or throws.
 */
function useWallet() {
  const [demoIdx, setDemoIdx] = useState(0);
  const demo = useMemo(() => (CFG.wallet === "demo" ? demoWallet(DEMO_ACCOUNTS[demoIdx].pk) : null), [demoIdx]);
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const [walletErr, setWalletErr] = useState<string | null>(null);

  const connect = useCallback(
    async (connectorId: string) => {
      setWalletErr(null);
      const c = connectors.find((x) => x.id === connectorId);
      if (!c) return;
      try {
        // ask for Amoy at connect time, so the wallet grants this site the chain as well as the account
        await connectAsync({ connector: c, chainId: polygonAmoy.id });
      } catch (e) {
        setWalletErr(explain(e));
      }
    },
    [connectors, connectAsync],
  );

  const getWallet = useCallback(async (): Promise<Wallet> => {
    if (demo) return demo;
    if (!isConnected) throw new Error("Connect a wallet first");
    if (chainId !== polygonAmoy.id) await switchChainAsync({ chainId: polygonAmoy.id });
    return (await getWalletClient(wagmiConfig, { chainId: polygonAmoy.id })) as unknown as Wallet;
  }, [demo, isConnected, chainId, switchChainAsync]);

  // EIP-6963 discovery lists every installed wallet; fall back to the generic injected connector
  const wallets = connectors.filter((c) => c.type === "injected" && (c.id !== "injected" || connectors.length === 1));
  return {
    address: demo ? demo.account.address : isConnected ? (address ?? null) : null,
    wrongChain: !demo && isConnected && chainId !== polygonAmoy.id,
    getWallet,
    demoIdx,
    setDemoIdx,
    wallets,
    connect,
    connecting: isPending,
    disconnect: () => disconnect(),
    walletErr,
    setWalletErr,
  };
}

export function App() {
  const [proto, setProto] = useState<{ d: Deployment; abi: Abis } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const w = useWallet();
  const { address } = w;
  const [marketIdx, setMarketIdx] = useState(0);
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    loadProtocol().then(setProto, (e) => setLoadErr((e as Error).message));
  }, []);

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
    try {
      await f(await w.getWallet(), ...a);
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
          <select aria-label="Account" value={w.demoIdx} onChange={(e) => w.setDemoIdx(Number(e.target.value))} style={{ width: "auto" }}>
            {DEMO_ACCOUNTS.map((a, i) => (
              <option key={a.label} value={i}>{a.label} · {shortAddr(demoWallet(a.pk).account.address)}</option>
            ))}
          </select>
        ) : address ? (
          <>
            <a className="chip" href={`${CFG.explorer}/address/${address}`} target="_blank" rel="noreferrer">{shortAddr(address)}</a>
            <button className="btn ghost" onClick={w.disconnect}>Disconnect</button>
          </>
        ) : w.wallets.length === 0 ? (
          <span className="chip">No browser wallet found: install MetaMask or Rabby</span>
        ) : (
          w.wallets.map((c) => (
            <button key={c.uid} className="btn" style={{ width: "auto", padding: "6px 14px" }} disabled={w.connecting}
              onClick={() => w.connect(c.id)}>
              {w.connecting ? "Connecting…" : `Connect ${c.name === "Injected" ? "wallet" : c.name}`}
            </button>
          ))
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
      {w.walletErr && <div className="banner">{w.walletErr}</div>}
      {w.wrongChain && <div className="banner">Your wallet is on another network; Phoebe will ask it to switch to Polygon Amoy when you transact.</div>}
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
        <LpPanel key={`lp-${address}`} snap={snap} d={d}
          onDeposit={act((w: Wallet, t: "senior" | "junior", amount: number) => deposit(w, d, abi, t, amount))}
          onWithdraw={act((w: Wallet, t: "senior" | "junior", amount: number) => withdraw(w, d, abi, t, amount))} />
        <ActivityFeed items={snap.activity} />
      </div>
    </div>
  );
}
