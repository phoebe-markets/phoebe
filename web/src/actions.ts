import { BaseError, ContractFunctionRevertedError, maxUint256, type Abi, type Address } from "viem";
import { pub, type Abis, type Deployment, type Wallet } from "./chain";
import { lastWalletFailure } from "./walletTrace";

const USD = 1_000_000;
export const toUsdc = (x: number) => BigInt(Math.round(x * USD));

/** Human-readable reasons for the protocol's custom errors. */
const REASONS: Record<string, string> = {
  LtvTooHigh: "Leverage is above what the risk engine allows right now",
  OpenNotAllowed: "New positions are closed on this market (too close to resolution, or paused)",
  StalePrice: "Oracle price is stale; wait for the keeper",
  BorrowCapExceeded: "Market borrow cap reached",
  ClusterCapExceeded: "Cluster borrow cap reached",
  PositionTooLarge: "Position is larger than this market's liquidity allows",
  JuniorCoverage: "Pool is at its junior-coverage limit",
  InsufficientCash: "Pool has no free liquidity for this right now",
  Underwater: "Position is underwater; it can only be liquidated or absorbed",
  ERC20InsufficientBalance: "Not enough USDC",
  ERC4626ExceededMaxWithdraw: "Withdrawal exceeds what the tranche can release now",
  ERC4626ExceededMaxRedeem: "Withdrawal exceeds what the tranche can release now",
};

export function explain(e: unknown): string {
  // wallet (EIP-1193) errors: name the wallet, the call it refused, and its own message
  const code = (e as { code?: number }).code ?? (e as { cause?: { code?: number } }).cause?.code;
  const f = lastWalletFailure();
  const where = f ? ` [${f.wallet} refused ${f.method}${f.code !== undefined ? `, code ${f.code}` : ""}: "${f.message}"]` : "";
  if (code === 4001 || f?.code === 4001) return `You rejected the request in your wallet${where}`;
  if (code === 4100 || f?.code === 4100) {
    return `Your wallet hasn't authorized this site for this account or network${where}. ` +
      "If that isn't MetaMask, disconnect and use Connect MetaMask; in MetaMask, check the site is connected to this account and to Polygon Amoy.";
  }
  if (f && !(e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError))) {
    return `${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}${where}`;
  }
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName ?? r.reason;
      return (name && REASONS[name]) ?? name ?? r.shortMessage;
    }
    return e.shortMessage;
  }
  return (e as Error).message;
}

async function write(w: Wallet, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: w.account, address, abi, functionName, args });
  const hash = await w.writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`transaction reverted (${hash})`);
  return r;
}

async function ensureAllowance(w: Wallet, d: Deployment, abi: Abis, spender: Address, amount: bigint) {
  const allowance = (await pub.readContract({
    address: d.usdc,
    abi: abi.usdc,
    functionName: "allowance",
    args: [w.account.address, spender],
  })) as bigint;
  if (allowance < amount) await write(w, d.usdc, abi.usdc, "approve", [spender, maxUint256]);
}

export async function openPosition(w: Wallet, d: Deployment, abi: Abis, tokenId: bigint, margin: number, borrow: number) {
  const m = toUsdc(margin);
  const b = toUsdc(borrow);
  await ensureAllowance(w, d, abi, d.positionManager, m + b); // margin + opening fee headroom
  return write(w, d.positionManager, abi.pm, "open", [tokenId, m, b, 0n]);
}

export const closePosition = (w: Wallet, d: Deployment, abi: Abis, id: bigint) =>
  write(w, d.positionManager, abi.pm, "close", [id, 0n]);

export async function addMargin(w: Wallet, d: Deployment, abi: Abis, id: bigint, amount: number) {
  await ensureAllowance(w, d, abi, d.positionManager, toUsdc(amount));
  return write(w, d.positionManager, abi.pm, "addMargin", [id, toUsdc(amount)]);
}

export async function deposit(w: Wallet, d: Deployment, abi: Abis, tranche: "senior" | "junior", amount: number) {
  const vault = d[tranche];
  await ensureAllowance(w, d, abi, vault, toUsdc(amount));
  return write(w, vault, abi.vault, "deposit", [toUsdc(amount), w.account.address]);
}

/** Testnet faucet: the mock USDC is freely mintable. */
export const mintTestUsdc = (w: Wallet, d: Deployment, abi: Abis, amount = 10_000) =>
  write(w, d.usdc, abi.usdc, "mint", [w.account.address, toUsdc(amount)]);

export const withdraw = (w: Wallet, d: Deployment, abi: Abis, tranche: "senior" | "junior", amount: number) =>
  write(w, d[tranche], abi.vault, "withdraw", [toUsdc(amount), w.account.address, w.account.address]);
