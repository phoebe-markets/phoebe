import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, http, type Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, polygon, polygonAmoy } from "viem/chains";

const ROOT = join(import.meta.dir, "..", "..");

export type Deployment = {
  chainId: number;
  markets: number;
  names?: string[];
  venueType?: "mock" | "keeper";
  complementNo?: boolean; // oracle derives NO = 1 - YES; push YES only
  polyTokenIds?: string[];
  tokenIds?: string[]; // YES, NO per market (decimal strings)
  conditionIds?: `0x${string}`[];
  mockCtf?: boolean;
  deployBlock?: number;
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

/** ABI straight from Foundry's build output, so it can't drift from the contracts. */
export function abi(contract: string): Abi {
  const f = join(ROOT, "contracts", "out", `${contract}.sol`, `${contract}.json`);
  return JSON.parse(readFileSync(f, "utf8")).abi as Abi;
}

const errorsOf = (a: Abi) => a.filter((x) => x.type === "error");

export const ABI_EXTRA = () => ({ ctf: abi("MockCTF"), keeperVenue: abi("KeeperVenue") });

export const ABI = {
  // include token errors so reverts bubbling up from USDC / ERC-1155 transfers decode by name
  pm: [...abi("PositionManager"), ...errorsOf(abi("MockUSDC")), ...errorsOf(abi("MockCTF"))] as Abi,
  oracle: abi("KeeperOracle"),
  risk: abi("RiskEngine"),
  pool: abi("LendingPool"),
  venue: abi("MockVenue"),
  erc20: abi("MockUSDC"),
};

/** DEPLOYMENT=<name> selects deployments/<name>.json (default "local"). */
export function loadDeployment(path = join(ROOT, "deployments", `${process.env.DEPLOYMENT ?? "local"}.json`)): Deployment {
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

// Anvil dev account #1, the keeper in script/Deploy.s.sol (public test key; override for anything real)
const ANVIL_KEEPER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export function clients(rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545", chainId = 31337) {
  const account = privateKeyToAccount((process.env.KEEPER_PK ?? ANVIL_KEEPER_PK) as `0x${string}`);
  const chain = chainId === polygon.id ? polygon : chainId === polygonAmoy.id ? polygonAmoy : foundry;
  const transport = http(rpcUrl, { batch: { batchSize: 50, wait: 0 } }); // JSON-RPC batching for sweeps
  return {
    account,
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ chain, transport, account }),
    test: createTestClient({ chain: foundry, transport, mode: "anvil" }),
  };
}

/** Public RPCs cap eth_getLogs ranges; fetch in chunks. */
export const LOG_CHUNK = BigInt(process.env.LOG_CHUNK ?? 2000);

export type Clients = ReturnType<typeof clients>;

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

export const WAD = 10n ** 18n;
export const fmtUsd = (x: bigint) => `$${(Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
