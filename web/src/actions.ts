import { BaseError, ContractFunctionRevertedError, maxUint256, parseAbi, parseGwei, type Abi, type Address } from "viem";
import { CFG, pub, type Abis, type Deployment, type Wallet } from "./chain";
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
  ERC4626ExceededMaxDeposit: "Deposit is over this tranche's cap (or deposits are paused)",
  DepositCap: "Deposit is over this tranche's cap (or deposits are paused)",
  IsPaused: "New positions are paused by the guardian; closing still works",
  MarketResolved: "This market has resolved: settle the position instead",
  NotRedeemed: "The market's shares haven't been redeemed yet",
  Inactive: "The market maker is offline (it pauses itself when Polymarket is unreachable); try again shortly",
  OnlyUnpaused: "Polymarket's on-ramp has wrapping paused for this token",
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

/** Suggested EIP-1559 fees honouring the chain's minimum tip (wallets show these as "site suggested"). */
async function fees() {
  if (!CFG.minTipGwei) return {};
  const tip = parseGwei(String(CFG.minTipGwei));
  const base = (await pub.getBlock()).baseFeePerGas ?? 0n;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
}

async function write(w: Wallet, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: w.account, address, abi, functionName, args });
  const hash = await w.writeContract({ ...(request as object), ...(await fees()) } as never);
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

/** Pay out a position in a resolved market (redeeming the market first if nobody has yet). */
export async function settlePosition(w: Wallet, d: Deployment, abi: Abis, id: bigint, conditionId: `0x${string}`, redeemed: boolean) {
  if (!redeemed) await write(w, d.positionManager, abi.pm, "redeem", [conditionId]);
  return write(w, d.positionManager, abi.pm, "settle", [id]);
}

// Polymarket's collateral off-ramp (Polygon): pUSD -> USDC.e (the pool asset on mainnet), 1:1
export const USDCE: Address = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const PUSD: Address = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const OFFRAMP: Address = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";
const RAMP_ABI = parseAbi([
  "function unwrap(address _asset, address _to, uint256 _amount)",
  "function paused(address asset) view returns (bool)",
  "error OnlyUnpaused()",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

export async function pusdBalance(who: Address) {
  return Number(await pub.readContract({ address: PUSD, abi: ERC20_ABI, functionName: "balanceOf", args: [who] })) / USD;
}

export const offrampPaused = () => pub.readContract({ address: OFFRAMP, abi: RAMP_ABI, functionName: "paused", args: [USDCE] });

/** Unwrap pUSD (Polymarket's trading balance) into USDC.e through Polymarket's off-ramp. */
export async function unwrapPusd(w: Wallet, amount: number) {
  const amt = toUsdc(amount);
  const a = (await pub.readContract({ address: PUSD, abi: ERC20_ABI, functionName: "allowance", args: [w.account.address, OFFRAMP] })) as bigint;
  if (a < amt) await write(w, PUSD, ERC20_ABI, "approve", [OFFRAMP, amt]);
  return write(w, OFFRAMP, RAMP_ABI, "unwrap", [USDCE, w.account.address, amt]);
}

/** Testnet faucet: the mock USDC is freely mintable. */
export const mintTestUsdc = (w: Wallet, d: Deployment, abi: Abis, amount = 10_000) =>
  write(w, d.usdc, abi.usdc, "mint", [w.account.address, toUsdc(amount)]);

export const withdraw = (w: Wallet, d: Deployment, abi: Abis, tranche: "senior" | "junior", amount: number) =>
  write(w, d[tranche], abi.vault, "withdraw", [toUsdc(amount), w.account.address, w.account.address]);
