import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

export type Deployment = {
  chainId: number;
  markets: number;
  names: string[];
  resolutionTimes: number[];
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

export const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined) ?? "http://127.0.0.1:8545";

// JSON-RPC batching: a refresh issues dozens of reads, sent as one HTTP request.
const transport = http(RPC_URL, { batch: { batchSize: 500, wait: 0 } });
export const pub = createPublicClient({ chain: foundry, transport });

/**
 * Demo accounts: Anvil's public dev keys, funded by contracts/script/Deploy.s.sol. Local chain only.
 * They let judges trade without setting up a wallet.
 */
export const DEMO_ACCOUNTS: { label: string; pk: Hex }[] = [
  { label: "Trader", pk: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
  { label: "Senior LP", pk: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { label: "Junior LP", pk: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
];

export function walletFor(pk: Hex) {
  return createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(pk) });
}
export type Wallet = ReturnType<typeof walletFor>;

export async function loadProtocol(): Promise<{ d: Deployment; abi: Abis }> {
  const get = async (path: string) => {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
    return r.json();
  };
  const [d, pm, risk, oracle, pool, vault, usdc] = await Promise.all([
    get("/deployment.json"),
    get("/abi/PositionManager.json"),
    get("/abi/RiskEngine.json"),
    get("/abi/KeeperOracle.json"),
    get("/abi/LendingPool.json"),
    get("/abi/TrancheVault.json"),
    get("/abi/MockUSDC.json"),
  ]);
  const errors = (a: Abi) => a.filter((x) => x.type === "error");
  return {
    d,
    // fold token errors into the manager's ABI so reverts from transfers decode by name
    abi: { pm: [...pm, ...errors(usdc)], risk, oracle, pool, vault, usdc },
  };
}

/** Market i trades tokens 2i+1 (YES) and 2i+2 (NO). */
export const yesId = (i: number) => BigInt(2 * i + 1);
export const noId = (i: number) => BigInt(2 * i + 2);
