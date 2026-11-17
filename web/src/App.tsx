import { useEffect, useMemo, useState } from "react";
import { DEMO_ACCOUNTS, loadProtocol, walletFor, type Abis, type Deployment } from "./chain";
import { useProtocol } from "./store";
import { addMargin, closePosition, deposit, explain, openPosition, withdraw } from "./actions";
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

export function App() {
  const [proto, setProto] = useState<{ d: Deployment; abi: Abis } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [acct, setAcct] = useState(0);
  const [marketIdx, setMarketIdx] = useState(0);
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    loadProtocol().then(setProto, (e) => setLoadErr((e as Error).message));
  }, []);

  const wallet = useMemo(() => walletFor(DEMO_ACCOUNTS[acct].pk), [acct]);
  const { snap, error, refreshNow } = useProtocol(proto?.d ?? null, proto?.abi ?? null, wallet.account.address);

  if (loadErr) {
    return (
      <div className="app">
        <div className="banner">
          Couldn't load the protocol: {loadErr}. Start a local chain with <code>demo/replay.sh</code>, then reload.
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
  // wrap actions: friendly revert reasons, then refresh immediately instead of waiting for the poll
  const act = <A extends unknown[]>(f: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try {
      await f(...a);
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
        <span className="chip" title="Chain time (replays run on historical time)">⏱ {when(snap.chainTime)} UTC</span>
        <span className="chip">block {String(snap.block)}</span>
        <select aria-label="Account" value={acct} onChange={(e) => setAcct(Number(e.target.value))} style={{ width: "auto" }}>
          {DEMO_ACCOUNTS.map((a, i) => (
            <option key={a.label} value={i}>{a.label} · {shortAddr(walletFor(a.pk).account.address)}</option>
          ))}
        </select>
        <span className="chip">{usd(snap.account.usdc)} USDC</span>
        <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)} style={{ width: "auto" }}>
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </header>

      {error && <div className="banner">Chain read failed, showing the last good state: {error}</div>}

      <div className="grid-main">
        <MarketPanel m={m} history={snap.history[m.index] ?? []} side={side} chainTime={snap.chainTime} />
        <TradePanel m={m} snap={snap} side={side} setSide={setSide}
          onOpen={act((tokenId: bigint, margin: number, borrow: number) => openPosition(wallet, d, abi, tokenId, margin, borrow))} />
      </div>

      <Positions snap={snap}
        onClose={act((id: bigint) => closePosition(wallet, d, abi, id))}
        onAddMargin={act((id: bigint, amount: number) => addMargin(wallet, d, abi, id, amount))} />

      <div className="grid-2">
        <LpPanel snap={snap}
          onDeposit={act((t: "senior" | "junior", amount: number) => deposit(wallet, d, abi, t, amount))}
          onWithdraw={act((t: "senior" | "junior", amount: number) => withdraw(wallet, d, abi, t, amount))} />
        <ActivityFeed items={snap.activity} />
      </div>
    </div>
  );
}
