import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { getWalletClient } from "@wagmi/core";
import { wagmiConfig } from "./wagmi";
import { NON_EVM_HINT, traceProvider } from "./walletTrace";
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
import { useProtocol, type PositionView } from "./store";
import { addMargin, closePosition, deposit, explain, mintTestUsdc, openPosition, settlePosition, unwrapPusd, withdraw } from "./actions";
import { StatusBanner } from "./components/StatusBanner";
import { UsdcePanel } from "./components/UsdcePanel";
import { MarketBar, MarketPanel } from "./components/MarketPanel";
import { TradePanel } from "./components/TradePanel";
import { Positions } from "./components/Positions";
import { LpForm, PoolOverview } from "./components/LpPanel";
import { ActivityFeed } from "./components/Activity";
import { shortAddr, usd, when } from "./format";
import { logoSvg } from "./brand/logo";

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
/** Browser wallets only exist on the wagmi chains (Amoy, Polygon); the local replay uses demo accounts. */
const WALLET_CHAIN = CFG.chain.id as (typeof wagmiConfig)["chains"][number]["id"];

function useWallet() {
  const [demoIdx, setDemoIdx] = useState(0);
  const demo = useMemo(() => (CFG.wallet === "demo" ? demoWallet(DEMO_ACCOUNTS[demoIdx].pk) : null), [demoIdx]);
  const { address, chainId, isConnected, connector } = useAccount();
  // record every request the connected wallet handles (see walletTrace.ts)
  useEffect(() => {
    // while wagmi rehydrates a previous session, `connector` can be a plain object without methods
    if (connector && typeof connector.getProvider === "function") {
      connector.getProvider().then((p) => traceProvider(p, connector.name), () => {});
    }
  }, [connector]);
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
        // ask for the network at connect time, so the wallet grants this site the chain as well as the account
        await connectAsync({ connector: c, chainId: WALLET_CHAIN });
      } catch (e) {
        setWalletErr(explain(e));
      }
    },
    [connectors, connectAsync],
  );

  const getWallet = useCallback(async (): Promise<Wallet> => {
    if (demo) return demo;
    if (!isConnected) throw new Error("Connect a wallet first");
    if (chainId !== WALLET_CHAIN) await switchChainAsync({ chainId: WALLET_CHAIN });
    return (await getWalletClient(wagmiConfig, { chainId: WALLET_CHAIN })) as unknown as Wallet;
  }, [demo, isConnected, chainId, switchChainAsync]);

  // EIP-6963 discovery lists every installed wallet; fall back to the generic injected connector
  // MetaMask / Rabby first; wallets for other ecosystems last (they often refuse EVM testnets like Amoy)
  const rank = (n: string) => (/metamask/i.test(n) ? 0 : /rabby/i.test(n) ? 1 : NON_EVM_HINT.test(n) ? 9 : 5);
  const wallets = connectors
    .filter((c) => c.type === "injected" && (c.id !== "injected" || connectors.length === 1))
    .sort((a, b) => rank(a.name) - rank(b.name));
  return {
    address: demo ? demo.account.address : isConnected ? (address ?? null) : null,
    walletName: demo ? "demo account" : connector?.name,
    wrongChain: !demo && isConnected && chainId !== CFG.chain.id,
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

type Tab = "trade" | "lp";

/** The open tab lives in the URL hash (#lp), so links can go straight to the liquidity page. */
function useTab(): [Tab, (t: Tab) => void] {
  const read = (): Tab => (location.hash === "#lp" ? "lp" : "trade");
  const [tab, setTab] = useState<Tab>(read);
  useEffect(() => {
    const on = () => setTab(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (t: Tab) => {
    history.replaceState(null, "", t === "lp" ? "#lp" : location.pathname + location.search);
    setTab(t);
    scrollTo({ top: 0 });
  };
  return [tab, go];
}

const THEME_NEXT: Record<Theme, Theme> = { system: "dark", dark: "light", light: "system" };
const THEME_ICON: Record<Theme, React.ReactNode> = {
  system: <path d="M12 3a9 9 0 1 0 0 18V3Z" fill="currentColor" />,
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor" />,
  light: (
    <>
      <circle cx="12" cy="12" r="4" fill="currentColor" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
};

function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <button className="icon-btn" title={`Theme: ${theme} (click for ${THEME_NEXT[theme]})`} aria-label={`Theme: ${theme}`}
      onClick={() => setTheme(THEME_NEXT[theme])}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
        {theme === "system" && <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />}
        {THEME_ICON[theme]}
      </svg>
    </button>
  );
}

const Chevron = () => (
  <svg className="chev" viewBox="0 0 12 12" width="10" height="10" aria-hidden>
    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A button that opens a small menu; closes on outside click or Escape. */
function Menu({ label, className, children }: { label: React.ReactNode; className?: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", away);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", away);
      removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div className="menu-pop" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
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
  const [tab, setTab] = useTab();

  useEffect(() => {
    loadProtocol().then(setProto, (e) => setLoadErr((e as Error).message));
  }, []);

  const { snap, error, refreshNow } = useProtocol(proto?.d ?? null, proto?.abi ?? null, address);

  const brand = (
    <a className="brand" href="/" title="Phoebe home">
      <span className="brand-mark" dangerouslySetInnerHTML={{ __html: logoSvg("app") }} />
    </a>
  );

  if (loadErr) {
    return (
      <>
        <header className="topbar"><div className="topbar-inner">{brand}</div></header>
        <main className="app">
          <div className="banner">
            Couldn't load the protocol on {CFG.label}: {loadErr}.{" "}
            {NET === "local" ? (
              <>Start a local chain with <code>demo/replay.sh</code>, then reload, or <a href="?net=amoy">open the Amoy testnet</a>.</>
            ) : (
              <>Check the RPC, or <a href="?net=local">open a local replay</a>.</>
            )}
          </div>
        </main>
      </>
    );
  }
  if (!proto || !snap) {
    return (
      <>
        <header className="topbar"><div className="topbar-inner">{brand}</div></header>
        <main className="app">
          <div className="loading">
            <span className="spinner" aria-hidden />
            {error ? `Waiting for the chain: ${error}` : `Connecting to ${CFG.label}…`}
          </div>
        </main>
      </>
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
  const faucet = () => {
    setFaucetMsg("Minting 10,000 test USDC…");
    act((w: Wallet) => mintTestUsdc(w, d, abi))().then(
      () => setFaucetMsg(null),
      (e) => setFaucetMsg((e as Error).message),
    );
  };

  const pusdCard = CFG.mainnet && address ? (
    <UsdcePanel snap={snap} address={address} onUnwrap={act((w: Wallet, amount: number) => unwrapPusd(w, amount))} />
  ) : null;

  const wallet =
    CFG.wallet === "demo" ? (
      <Menu className="wallet-btn" label={<><span className="dot" aria-hidden />{DEMO_ACCOUNTS[w.demoIdx].label}<Chevron /></>}>
        {(close) => (
          <>
            <div className="menu-note mono">{usd(snap.account.usdc)} USDC</div>
            {DEMO_ACCOUNTS.map((a, i) => (
              <button key={a.label} role="menuitemradio" aria-checked={i === w.demoIdx} onClick={() => { close(); w.setDemoIdx(i); }}>
                {a.label} <small>{shortAddr(demoWallet(a.pk).account.address)}</small>
                {i === w.demoIdx && <span className="check" aria-hidden>✓</span>}
              </button>
            ))}
          </>
        )}
      </Menu>
    ) : address ? (
      <Menu className="wallet-btn" label={<><span className="dot" aria-hidden />{shortAddr(address)}<Chevron /></>}>
        {(close) => (
          <>
            <div className="menu-note">Connected via {w.walletName}</div>
            <div className="menu-note mono">{usd(snap.account.usdc)} {CFG.asset}</div>
            {CFG.faucet && <button role="menuitem" onClick={() => { close(); faucet(); }}>Get 10k test USDC</button>}
            {CFG.explorer && (
              <a role="menuitem" href={`${CFG.explorer}/address/${address}`} target="_blank" rel="noreferrer" onClick={close}>View on explorer ↗</a>
            )}
            <button role="menuitem" onClick={() => { close(); w.disconnect(); }}>Disconnect</button>
          </>
        )}
      </Menu>
    ) : w.wallets.length === 0 ? (
      <span className="chip">No browser wallet: install MetaMask or Rabby</span>
    ) : (
      <Menu className="btn wallet-connect" label={w.connecting ? "Connecting…" : <>Connect wallet<Chevron /></>}>
        {(close) =>
          w.wallets.map((c) => (
            <button key={c.uid} role="menuitem" disabled={w.connecting} onClick={() => { close(); w.connect(c.id); }}>
              {c.name === "Injected" ? "Browser wallet" : c.name}
              {NON_EVM_HINT.test(c.name) && <small> may not support Polygon</small>}
            </button>
          ))
        }
      </Menu>
    );

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          {brand}
          <nav className="tabs" aria-label="Sections">
            <button aria-current={tab === "trade" ? "page" : undefined} onClick={() => setTab("trade")}>Trade</button>
            <button aria-current={tab === "lp" ? "page" : undefined} onClick={() => setTab("lp")}>Provide liquidity</button>
          </nav>
          <span className="spacer" />
          <span className="chip chain-chip" title="Chain time (replays run on historical time) and block">
            {when(snap.chainTime)} UTC · #{String(snap.block)}
          </span>
          <Menu className="pill-btn" label={<>{CFG.label}<Chevron /></>}>
            {(close) =>
              (Object.keys(NETWORKS) as Net[]).map((n) => (
                <button key={n} role="menuitemradio" aria-checked={n === NET} onClick={() => { close(); if (n !== NET) switchNet(n); }}>
                  {NETWORKS[n].label}
                  {n === NET && <span className="check" aria-hidden>✓</span>}
                </button>
              ))
            }
          </Menu>
          {wallet}
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </header>

      <main className="app">
        {error && <div className="banner">Chain read failed, showing the last good state: {error}</div>}
        {w.walletErr && <div className="banner">{w.walletErr}</div>}
        {w.wrongChain && <div className="banner">Your wallet is on another network; Phoebe will ask it to switch to {CFG.chain.name} when you transact.</div>}
        {faucetMsg && <div className="banner">{faucetMsg}</div>}
        <StatusBanner snap={snap} />

        {tab === "trade" ? (
          <>
            <MarketBar m={m} markets={snap.markets} onPick={setMarketIdx} chainTime={snap.chainTime} />
            <div className="grid-main">
              <MarketPanel m={m} history={snap.history[m.index] ?? []} side={side} />
              <TradePanel key={`trade-${address}`} m={m} snap={snap} side={side} setSide={setSide}
                onOpen={act((w: Wallet, tokenId: bigint, margin: number, borrow: number) => openPosition(w, d, abi, tokenId, margin, borrow))} />
            </div>
            <Positions key={`pos-${address}`} snap={snap}
              onClose={act((w: Wallet, id: bigint) => closePosition(w, d, abi, id))}
              onAddMargin={act((w: Wallet, id: bigint, amount: number) => addMargin(w, d, abi, id, amount))}
              onSettle={d.conditionIds ? act((w: Wallet, p: PositionView) =>
                settlePosition(w, d, abi, p.id, d.conditionIds![p.market], snap.status.redeemed[p.market])) : undefined} />
            {pusdCard}
            <ActivityFeed items={snap.activity} />
          </>
        ) : (
          <>
            <div className="grid-main">
              <PoolOverview snap={snap} d={d} />
              <LpForm key={`lp-${address}`} snap={snap}
                onDeposit={act((w: Wallet, t: "senior" | "junior", amount: number) => deposit(w, d, abi, t, amount))}
                onWithdraw={act((w: Wallet, t: "senior" | "junior", amount: number) => withdraw(w, d, abi, t, amount))} />
            </div>
            {pusdCard}
            <ActivityFeed items={snap.activity} />
          </>
        )}

        <footer className="app-foot">
          {NET === "polygon"
            ? `Live on Polygon: positions are backed by real Polymarket outcome tokens. Prices come from Polymarket via the keeper; fills come from the market maker's inventory at oracle ±${(snap.status.venueSpread * 100).toFixed(1)}%, hedged on Polymarket. Unaudited; small caps.`
            : NET === "amoy"
            ? "Live on Polygon Amoy: prices stream from Polymarket via the keeper; fills come from the keeper's inventory at oracle ±0.5%. Testnet funds only. Need gas? Get Amoy POL from a faucet."
            : "Local replay: a historical Polymarket market replayed on an Anvil chain, on historical time."}
        </footer>
      </main>
    </>
  );
}
