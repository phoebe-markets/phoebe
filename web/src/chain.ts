import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, polygonAmoy } from "viem/chains";

export type Deployment = {
  chainId: number;
  markets: number;
  names: string[];
  resolutionTimes: number[];
  deployBlock?: number;
  venueType?: "mock" | "keeper";
  polyTokenIds?: string[];
  tokenIds?: string[]; // YES, NO per market (decimal strings)
  conditionIds?: Hex[];
  marketSlugs?: string[];
  mockCtf?: boolean;
  usdc: Address;
  ctf: Address;
  oracle: Address;
  venue: Address;
  pool: Address;
  senior: Address;
  junior: Address;
  risk: Address;
  positionManager: Address;
  keeper: Address;
  trader: Address;
};

export type Abis = Record<"pm" | "risk" | "oracle" | "pool" | "vault" | "usdc", Abi>;

// ---------------------------------------------------------------- networks

export type Net = "local" | "amoy";

type NetConfig = {
  label: string;
  chain: Chain;
  rpc: string;
  pollMs: number;
  logChunk: bigint; // eth_getLogs block range per call
  wallet: "demo" | "injected";
  explorer?: string;
  /** Some chains enforce a minimum priority fee that wallets don't know about (Amoy: 25 gwei). */
  minTipGwei?: number;
};

export const NETWORKS: Record<Net, NetConfig> = {
  local: {
    label: "Local (Anvil replay)",
    chain: foundry,
    rpc: (import.meta.env.VITE_LOCAL_RPC as string | undefined) ?? "http://127.0.0.1:8545",
    pollMs: 1000,
    logChunk: 1_000_000n,
    wallet: "demo",
  },
  amoy: {
    label: "Polygon Amoy testnet",
    chain: polygonAmoy,
    rpc: (import.meta.env.VITE_AMOY_RPC as string | undefined) ?? "https://polygon-amoy-bor-rpc.publicnode.com",
    pollMs: 6000, // public RPC: be polite
    logChunk: 5_000n, // publicnode caps eth_getLogs at 10k blocks
    wallet: "injected",
    explorer: "https://amoy.polygonscan.com",
    minTipGwei: 30, // node minimum is 25; wallets default to ~1.5 and get rejected
  },
};

/** ?net=amoy|local; defaults to amoy anywhere but localhost. Switching networks reloads the page. */
export const NET: Net = (() => {
  const q = new URLSearchParams(location.search).get("net");
  if (q === "local" || q === "amoy") return q;
  return ["localhost", "127.0.0.1"].includes(location.hostname) ? "local" : "amoy";
})();
export const CFG = NETWORKS[NET];

export function switchNet(n: Net) {
  const u = new URL(location.href);
  u.searchParams.set("net", n);
  location.href = u.toString();
}

// JSON-RPC batching: a refresh issues dozens of reads, sent as one HTTP request.
const transport = http(CFG.rpc, { batch: { batchSize: 100, wait: 0 } });
export const pub = createPublicClient({ chain: CFG.chain, transport });

// ---------------------------------------------------------------- wallets

export type Wallet = WalletClient<Transport, Chain, Account>;

/**
 * Local demo accounts: Anvil's public dev keys, funded by contracts/script/Deploy.s.sol. Local chain only.
 * They let people try the replay without setting up a wallet.
 */
export const DEMO_ACCOUNTS: { label: string; pk: Hex }[] = [
  { label: "Trader", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
  { label: "Senior LP", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { label: "Junior LP", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
];

export function demoWallet(pk: Hex): Wallet {
  return createWalletClient({ chain: CFG.chain, transport, account: privateKeyToAccount(pk) });
}

// ---------------------------------------------------------------- protocol files

export async function loadProtocol(): Promise<{ d: Deployment; abi: Abis }> {
  const get = async (path: string) => {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
    return r.json();
  };
  const [d, pm, risk, oracle, pool, vault, usdc] = await Promise.all([
    get(`/deployments/${NET}.json`),
    get("/abi/PositionManager.json"),
    get("/abi/RiskEngine.json"),
    get("/abi/KeeperOracle.json"),
    get("/abi/LendingPool.json"),
    get("/abi/TrancheVault.json"),
    get("/abi/MockUSDC.json"),
  ]);
  if (d.chainId !== CFG.chain.id) throw new Error(`deployments/${NET}.json is for chain ${d.chainId}, expected ${CFG.chain.id}`);
  const errors = (a: Abi) => a.filter((x) => x.type === "error");
  return {
    d,
    // fold token errors into the manager's ABI so reverts from transfers decode by name
    abi: { pm: [...pm, ...errors(usdc)], risk, oracle, pool, vault, usdc },
  };
}

/**
 * Market i's YES / NO token ids. Deployments list them in `tokenIds` (YES, NO per market; Polymarket's 256-bit ids on
 * mainnet). Older mock deployments without it use 2i+1 / 2i+2.
 */
export const yesId = (d: { tokenIds?: string[] }, i: number) => (d.tokenIds ? BigInt(d.tokenIds[2 * i]) : BigInt(2 * i + 1));
export const noId = (d: { tokenIds?: string[] }, i: number) => (d.tokenIds ? BigInt(d.tokenIds[2 * i + 1]) : BigInt(2 * i + 2));

/** Which market and side a token id belongs to (undefined if it isn't listed). */
export function marketOf(d: { tokenIds?: string[]; markets: number }, tokenId: bigint): { market: number; side: "YES" | "NO" } | undefined {
  for (let i = 0; i < d.markets; i++) {
    if (yesId(d, i) === tokenId) return { market: i, side: "YES" };
    if (noId(d, i) === tokenId) return { market: i, side: "NO" };
  }
  return undefined;
}
