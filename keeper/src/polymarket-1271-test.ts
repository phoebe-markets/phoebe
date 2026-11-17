#!/usr/bin/env bun
/**
 * Does Polymarket's CLOB accept orders from an arbitrary EIP-1271 contract maker? (NOTES.md)
 *
 * The ON-CHAIN half is already answered by contracts/test/PolymarketFork.t.sol: the deployed CTFExchangeV2 accepts
 * PolymarketOrderSigner orders (both ERC-7739 owner signatures and pre-approved hashes). This script answers the
 * OFF-CHAIN half by posting one tiny, non-crossing limit order to the real CLOB API and cancelling it.
 *
 * Polygon MAINNET, real funds (about $1 of pUSD + a little POL for gas). You run it, with your own key:
 *
 *   export PK=0x...                                   # your EOA: owns the signer contract, holds the API key
 *   export POLYGON_RPC=https://polygon-bor-rpc.publicnode.com   (default)
 *   # optional: CLOB_API_KEY / CLOB_SECRET / CLOB_PASSPHRASE (otherwise derived from PK via L1 auth)
 *
 *   bun keeper/src/polymarket-1271-test.ts status
 *   bun keeper/src/polymarket-1271-test.ts deploy --yes            # deploy PolymarketOrderSigner (owner = PK)
 *   bun keeper/src/polymarket-1271-test.ts swap 1.5 --yes          # native USDC -> USDC.e on Uniswap V3 (0.01% pool)
 *   bun keeper/src/polymarket-1271-test.ts fund 1 --usdce --yes    # wrap 1 USDC.e -> 1 pUSD straight into the signer
 *   bun keeper/src/polymarket-1271-test.ts approve --yes           # signer approves pUSD to the exchanges
 *   bun keeper/src/polymarket-1271-test.ts test <tokenId>          # DRY RUN: build, sign, preflight on-chain
 *   bun keeper/src/polymarket-1271-test.ts test <tokenId> --mode hash --yes   # post + cancel (vault design)
 *   bun keeper/src/polymarket-1271-test.ts test <tokenId> --mode 7739 --yes   # post + cancel (owner signature)
 *   bun keeper/src/polymarket-1271-test.ts withdraw --yes          # pUSD back to PK
 *   bun keeper/src/polymarket-1271-test.ts apikey-contract --yes --ssh earth   # try an API key OWNED BY THE CONTRACT
 *   bun keeper/src/polymarket-1271-test.ts test <tokenId> --contract-key --yes --ssh earth   # post with that key
 *
 * Why apikey-contract: the CLOB answered "the order signer address has to be the address of the API KEY". A 1271
 * order's signer must be the contract, so the API key has to belong to the contract. We sign ClobAuth for the
 * contract address with the owner EOA and pre-approve its digest on the contract (in case the server verifies via
 * EIP-1271). If the server instead ecrecovers, or only knows its own deposit wallets, this fails, and that settles it.
 *
 * Rehearsal without real funds: point POLYGON_RPC at an Anvil fork of Polygon and use an Anvil key, then
 * `test <tokenId> --mode hash --yes --no-post` (on-chain steps run on the fork; nothing is posted to Polymarket).
 *
 * Nothing here ever crosses the book: orders are BUYs at the minimum tick, far below the best bid.
 *
 * Network egress for Polymarket API calls (RPC calls stay direct):
 *   --ssh <alias>        open `ssh -N -D` to that host for the run and send CLOB traffic through it (e.g. --ssh earth)
 *   --socks <host:port>  use an existing SOCKS5 proxy instead
 *   bun keeper/src/polymarket-1271-test.ts geo --ssh earth   # what country Polymarket sees, and whether it's blocked
 * Before posting, the script asks Polymarket's geoblock endpoint and refuses to post if that location is blocked.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import axios from "axios"; // the same instance @polymarket/clob-client-v2 uses for every API call
import { SocksProxyAgent } from "socks-proxy-agent";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  formatUnits,
  hashDomain,
  hashStruct,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";
import { polygon } from "viem/chains";
import { ClobClient, OrderType, Side, SignatureTypeV2, type ApiKeyCreds } from "@polymarket/clob-client-v2";

const ROOT = join(import.meta.dir, "..", "..");
const STATE = join(ROOT, "deployments", "polymarket-signer.json");
const HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";

// Polygon mainnet (ctf-exchange-v2 README; clob-client-v2 src/config.ts)
const PUSD: Address = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const ONRAMP: Address = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const USDC: Address = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // native USDC
const USDCE: Address = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged USDC.e
// Uniswap V3 on Polygon (canonical deployments; router/quoter verified to point at the factory below)
const UNI_V3_FACTORY: Address = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNI_ROUTER02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNI_QUOTER_V2: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const STABLE_POOL_FEE = 100; // 0.01% USDC/USDC.e pool
const EXCHANGE_V2: Address = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2: Address = "0xe2222d279d744050d28e00520010520000310F59";
const EXCHANGE_V3: Address = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const ONRAMP_ABI = parseAbi([
  "function wrap(address _asset, address _to, uint256 _amount)",
  "function paused(address asset) view returns (bool)",
  "error OnlyUnpaused()",
]);
const UNI_ABI = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const EXCHANGE_ABI = parseAbi([
  "struct Order { uint256 salt; address maker; address signer; uint256 tokenId; uint256 makerAmount; uint256 takerAmount; uint8 side; uint8 signatureType; uint256 timestamp; bytes32 metadata; bytes32 builder; bytes signature; }",
  "function hashOrder(Order order) view returns (bytes32)",
  "function validateOrder(Order order) view",
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;
const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const TYPED_DATA_SIGN = [
  { name: "contents", type: "Order" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;

// ---------------------------------------------------------------- setup

const args = process.argv.slice(2);
const cmd = args[0];
const has = (f: string) => args.includes(`--${f}`);
const opt = (f: string, d: string) => (args.includes(`--${f}`) ? args[args.indexOf(`--${f}`) + 1] : d);
const confirmed = has("yes");

if (!process.env.PK) {
  console.error("Set PK (your EOA private key) first. See the header of this file.");
  process.exit(1);
}
const account = privateKeyToAccount(process.env.PK as Hex);
const transport = http(process.env.POLYGON_RPC ?? "https://polygon-bor-rpc.publicnode.com");
const pub = createPublicClient({ chain: polygon, transport });
const wallet = createWalletClient({ chain: polygon, transport, account });

const CONTRACT_CREDS = join(process.env.HOME ?? ".", ".phoebe", "polymarket-contract-creds.json");
const CLOB_AUTH_MSG = "This message attests that I control the given wallet"; // clob-client-v2 MSG_TO_SIGN
const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

/**
 * An ethers-style signer for clob-client-v2 that REPORTS the contract address (so L1/L2 auth headers and
 * order.signer say "contract") but SIGNS with the owner EOA.
 */
function contractSigner(contract: Address) {
  return {
    getAddress: async () => contract,
    _signTypedData: (domain: Record<string, unknown>, types: Record<string, { name: string; type: string }[]>, value: Record<string, unknown>) => {
      // primary type = the one no other type references (viem needs it explicitly; ethers infers it)
      const referenced = new Set(Object.values(types).flatMap((fs) => fs.map((f) => f.type.replace(/\[\]$/, ""))));
      const primaryType = Object.keys(types).find((t) => !referenced.has(t))!;
      return wallet.signTypedData({ domain, types, primaryType, message: value } as never);
    },
  };
}

const usd = (x: bigint) => `$${formatUnits(x, 6)}`;
const signerAddress = (): Address => {
  if (!existsSync(STATE)) throw new Error(`no signer deployed yet (${STATE}); run: deploy --yes`);
  return JSON.parse(readFileSync(STATE, "utf8")).signer;
};
const signerAbi = () =>
  JSON.parse(readFileSync(join(ROOT, "contracts/out/PolymarketOrderSigner.sol/PolymarketOrderSigner.json"), "utf8"));

async function tx(what: string, f: () => Promise<Hex>) {
  if (!confirmed) {
    console.log(`[dry run] would send: ${what}   (add --yes to send)`);
    return;
  }
  const hash = await f();
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${r.status === "success" ? "ok" : "REVERTED"}: ${what}  https://polygonscan.com/tx/${hash}`);
  if (r.status !== "success") process.exit(1);
}

// ---------------------------------------------------------------- egress (SOCKS for Polymarket API traffic)

let tunnel: ChildProcess | undefined;

function portOpen(port: number) {
  return new Promise<boolean>((res) => {
    const c = createConnection({ host: "127.0.0.1", port });
    c.once("connect", () => (c.destroy(), res(true)));
    c.once("error", () => res(false));
  });
}

async function setupEgress() {
  let socks = opt("socks", process.env.CLOB_SOCKS ?? "");
  const sshHost = opt("ssh", "");
  if (sshHost) {
    const port = 10_800 + Math.floor(Math.random() * 1000);
    tunnel = spawn("ssh", ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-D", `127.0.0.1:${port}`, sshHost], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    process.on("exit", () => tunnel?.kill());
    for (let i = 0; i < 50 && !(await portOpen(port)); i++) {
      if (tunnel.exitCode !== null) throw new Error(`ssh -D to ${sshHost} exited (${tunnel.exitCode})`);
      await Bun.sleep(200);
    }
    if (!(await portOpen(port))) throw new Error(`SOCKS tunnel to ${sshHost} didn't come up`);
    socks = `127.0.0.1:${port}`;
    console.log(`egress: Polymarket API via ssh -D ${sshHost} (SOCKS 127.0.0.1:${port})`);
  } else if (socks) {
    console.log(`egress: Polymarket API via SOCKS ${socks}`);
  }
  if (socks) {
    const agent = new SocksProxyAgent(`socks5h://${socks}`); // socks5h: DNS resolved on the far side too
    axios.defaults.httpAgent = agent;
    axios.defaults.httpsAgent = agent;
    axios.defaults.proxy = false; // ignore HTTP(S)_PROXY env so traffic can't silently bypass the tunnel
  }
}

/** Polymarket's own geoblock check, over the same egress as the API calls. */
async function geoblock(): Promise<{ blocked: boolean; country?: string; ip?: string }> {
  const r = await axios.get("https://polymarket.com/api/geoblock", { timeout: 15_000 });
  return r.data;
}

// ---------------------------------------------------------------- commands

/** Try to get CLOB API credentials owned by the contract (see header). */
async function apikeyContract() {
  const s = signerAddress();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = 0n;
  const domain = { name: "ClobAuthDomain", version: "1", chainId: 137 } as const;
  const message = { address: s, timestamp: String(ts), nonce, message: CLOB_AUTH_MSG };
  const digest = hashTypedData({ domain, types: CLOB_AUTH_TYPES, primaryType: "ClobAuth", message });
  const sig = await wallet.signTypedData({ domain, types: CLOB_AUTH_TYPES, primaryType: "ClobAuth", message });
  console.log(`ClobAuth for contract ${s}: ts ${ts}, digest ${digest}`);
  await tx(`signer.approveHash(ClobAuth digest ${digest})`, () =>
    wallet.writeContract({ address: s, abi: signerAbi().abi, functionName: "approveHash", args: [digest, true] }),
  );
  if (!confirmed) return console.log("[dry run] stopping before calling the API (add --yes)");

  const headers = { POLY_ADDRESS: s, POLY_SIGNATURE: sig, POLY_TIMESTAMP: String(ts), POLY_NONCE: String(nonce) };
  const call = async (method: "get" | "post", path: string) => {
    try {
      const r = await axios.request({ method, url: `${HOST}${path}`, headers, timeout: 20_000 });
      return { status: r.status, data: r.data };
    } catch (e) {
      const r = (e as { response?: { status: number; data: unknown } }).response;
      return { status: r?.status ?? 0, data: r?.data ?? String(e) };
    }
  };
  let res = await call("get", "/auth/derive-api-key");
  console.log("GET /auth/derive-api-key ->", JSON.stringify(res));
  if (!(res.data as { apiKey?: string })?.apiKey) {
    res = await call("post", "/auth/api-key");
    console.log("POST /auth/api-key ->", JSON.stringify(res));
  }
  const raw = res.data as { apiKey?: string; secret?: string; passphrase?: string };
  if (!raw?.apiKey) return console.log("\nRESULT: the CLOB would NOT issue an API key owned by the contract.");
  mkdirSync(join(process.env.HOME ?? ".", ".phoebe"), { recursive: true, mode: 0o700 });
  writeFileSync(CONTRACT_CREDS, JSON.stringify({ address: s, key: raw.apiKey, secret: raw.secret, passphrase: raw.passphrase }), { mode: 0o600 });
  console.log(`\nRESULT: the CLOB ISSUED an API key owned by the contract (saved to ${CONTRACT_CREDS}, key ${raw.apiKey}).`);
  console.log("Next: test <tokenId> --contract-key --yes --ssh earth");
}

async function geo() {
  const g = await geoblock();
  console.log(`Polymarket sees: ${JSON.stringify(g)}`);
}

async function status() {
  const [pausedUsdc, pausedUsdce] = await Promise.all(
    [USDC, USDCE].map((a) => pub.readContract({ address: ONRAMP, abi: ONRAMP_ABI, functionName: "paused", args: [a] })),
  );
  console.log(`pUSD onramp: native USDC ${pausedUsdc ? "PAUSED" : "open"}, USDC.e ${pausedUsdce ? "PAUSED" : "open"}`);
  const [pol, usdc, usdce] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [account.address] }),
    pub.readContract({ address: USDCE, abi: ERC20, functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(`EOA ${account.address}: ${formatUnits(pol, 18)} POL, ${usd(usdc)} USDC, ${usd(usdce)} USDC.e`);
  if (!existsSync(STATE)) return console.log("signer: not deployed (run: deploy --yes)");
  const s = signerAddress();
  const bal = await pub.readContract({ address: PUSD, abi: ERC20, functionName: "balanceOf", args: [s] });
  console.log(`signer ${s}: ${usd(bal)} pUSD`);
  for (const [name, ex] of [["V2", EXCHANGE_V2], ["negRisk V2", NEG_RISK_EXCHANGE_V2], ["V3", EXCHANGE_V3]] as const) {
    const a = await pub.readContract({ address: PUSD, abi: ERC20, functionName: "allowance", args: [s, ex] });
    console.log(`  pUSD allowance to exchange ${name}: ${a === maxUint256 ? "max" : usd(a)}`);
  }
}

async function deploy() {
  const art = signerAbi();
  if (!confirmed) return console.log(`[dry run] would deploy PolymarketOrderSigner(owner=${account.address}) (add --yes)`);
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [account.address] });
  const r = await pub.waitForTransactionReceipt({ hash });
  mkdirSync(join(ROOT, "deployments"), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ chainId: 137, signer: r.contractAddress, owner: account.address }, null, 2));
  console.log(`deployed PolymarketOrderSigner at ${r.contractAddress}  https://polygonscan.com/tx/${hash}`);
}

async function fund() {
  const amount = parseUnits(args[1] ?? "1", 6);
  const asset = has("usdce") ? USDCE : USDC;
  const s = signerAddress();
  // Polymarket pauses wrapping per asset (native USDC was paused on 2026-11-16 while USDC.e was open)
  const paused = await pub.readContract({ address: ONRAMP, abi: ONRAMP_ABI, functionName: "paused", args: [asset] });
  if (paused) {
    const other = asset === USDC ? "USDC.e (use --usdce)" : "native USDC (drop --usdce)";
    throw new Error(`Polymarket's onramp has wrapping PAUSED for ${has("usdce") ? "USDC.e" : "native USDC"}. Try ${other}.`);
  }
  console.log(`wrap ${usd(amount)} ${has("usdce") ? "USDC.e" : "USDC"} from ${account.address} into pUSD held by the signer ${s}`);
  await tx(`approve ${usd(amount)} to the pUSD onramp`, () =>
    wallet.writeContract({ address: asset, abi: ERC20, functionName: "approve", args: [ONRAMP, amount] }),
  );
  await tx(`onramp.wrap(${asset}, signer, ${usd(amount)})`, () =>
    wallet.writeContract({ address: ONRAMP, abi: ONRAMP_ABI, functionName: "wrap", args: [asset, s, amount] }),
  );
}

/** Native USDC -> USDC.e on Uniswap V3's 0.01% stable pool (Polymarket's onramp only accepts USDC.e right now). */
async function swap() {
  const amountIn = parseUnits(args[1] ?? "1.5", 6);
  const slipBps = BigInt(opt("slippage-bps", "50"));
  const pool = await pub.readContract({ address: UNI_V3_FACTORY, abi: UNI_ABI, functionName: "getPool", args: [USDC, USDCE, STABLE_POOL_FEE] });
  const { result } = await pub.simulateContract({
    address: UNI_QUOTER_V2,
    abi: UNI_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: USDC, tokenOut: USDCE, amountIn, fee: STABLE_POOL_FEE, sqrtPriceLimitX96: 0n }],
  });
  const quoted = result[0];
  const minOut = (quoted * (10_000n - slipBps)) / 10_000n;
  console.log(`swap ${usd(amountIn)} USDC -> USDC.e via Uniswap V3 pool ${pool} (0.01%)`);
  console.log(`quote ${usd(quoted)} USDC.e, min out ${usd(minOut)} (slippage ${slipBps} bps)`);
  // stablecoins: refuse anything worse than 1% off par, whatever the slippage setting
  if (quoted * 100n < amountIn * 99n) throw new Error(`quote is more than 1% below par; not swapping`);
  await tx(`USDC.approve(router, ${usd(amountIn)})`, () =>
    wallet.writeContract({ address: USDC, abi: ERC20, functionName: "approve", args: [UNI_ROUTER02, amountIn] }),
  );
  await tx(`router.exactInputSingle(${usd(amountIn)} USDC -> >= ${usd(minOut)} USDC.e to ${account.address})`, () =>
    wallet.writeContract({
      address: UNI_ROUTER02,
      abi: UNI_ABI,
      functionName: "exactInputSingle",
      args: [{ tokenIn: USDC, tokenOut: USDCE, fee: STABLE_POOL_FEE, recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    }),
  );
}

async function approve() {
  const s = signerAddress();
  const abi = signerAbi().abi;
  for (const ex of [EXCHANGE_V2, NEG_RISK_EXCHANGE_V2, EXCHANGE_V3]) {
    await tx(`signer.approveERC20(pUSD, ${ex}, max)`, () =>
      wallet.writeContract({ address: s, abi, functionName: "approveERC20", args: [PUSD, ex, maxUint256] }),
    );
  }
}

async function withdraw() {
  const s = signerAddress();
  const bal = await pub.readContract({ address: PUSD, abi: ERC20, functionName: "balanceOf", args: [s] });
  await tx(`signer.withdrawERC20(pUSD, ${account.address}, ${usd(bal)})`, () =>
    wallet.writeContract({ address: s, abi: signerAbi().abi, functionName: "withdrawERC20", args: [PUSD, account.address, bal] }),
  );
}

async function test() {
  const tokenId = args[1];
  if (!tokenId || tokenId.startsWith("--")) throw new Error("usage: test <polymarket tokenId> [--mode hash|7739] [--yes]");
  const mode = opt("mode", "hash");
  const s = signerAddress();

  // 1. API credentials belong to the EOA (L1 auth); the order's maker/funder is the contract.
  const willPost = confirmed && !has("no-post");
  const envCreds = process.env.CLOB_API_KEY
    ? ({ key: process.env.CLOB_API_KEY, secret: process.env.CLOB_SECRET!, passphrase: process.env.CLOB_PASSPHRASE! } as ApiKeyCreds)
    : undefined;
  // ClobSigner's type tracks a newer viem than ours; at runtime it only uses the account and signTypedData.
  const clobSigner = wallet as unknown as ConstructorParameters<typeof ClobClient>[0]["signer"];
  const l1 = new ClobClient({ host: HOST, chain: 137, signer: clobSigner });
  const useContractKey = has("contract-key");
  if (useContractKey && !existsSync(CONTRACT_CREDS)) throw new Error("no contract-owned API key yet: run apikey-contract --yes");
  const contractCreds = useContractKey ? (JSON.parse(readFileSync(CONTRACT_CREDS, "utf8")) as ApiKeyCreds) : undefined;
  // Only touch API credentials when actually posting: deriving a key registers it with Polymarket.
  const creds = contractCreds ?? (willPost ? (envCreds ?? (await l1.createOrDeriveApiKey())) : undefined);
  const clob = new ClobClient({
    host: HOST,
    chain: 137,
    // with a contract-owned key, auth headers must carry the contract address (the EOA still signs)
    signer: useContractKey ? (contractSigner(s) as unknown as typeof clobSigner) : clobSigner,
    creds,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: s,
  });

  // 2. A BUY at the minimum tick, far below the market: it can't fill.
  const book = await clob.getOrderBook(tokenId);
  const tick = book.tick_size as "0.01" | "0.001";
  const price = Number(tick);
  const bestBid = Number(book.bids?.at(-1)?.price ?? book.bids?.[0]?.price ?? 0);
  const size = Math.max(Number(book.min_order_size || 5), 5);
  if (bestBid > 0 && price >= bestBid) throw new Error(`price ${price} would not rest below best bid ${bestBid}`);
  console.log(`market ${book.market}: tick ${tick}, min size ${book.min_order_size}, negRisk ${book.neg_risk}, best bid ${bestBid}`);
  console.log(`order: BUY ${size} shares @ ${price} = $${(size * price).toFixed(2)} pUSD, maker = signer ${s}, mode = ${mode}`);

  const order = (await clob.createOrder(
    { tokenID: tokenId, price, size, side: Side.BUY },
    { tickSize: tick, negRisk: book.neg_risk },
  )) as unknown as Record<string, string | number>;
  if ((order.maker as string).toLowerCase() !== s.toLowerCase()) throw new Error(`client set maker ${order.maker}, expected the signer`);

  // 3. Re-sign: ERC-7739 nested typed data under OUR domain ("PhoebeOrderSigner"), not Polymarket's deposit wallet.
  const exchange = book.neg_risk ? NEG_RISK_EXCHANGE_V2 : EXCHANGE_V2;
  const [, exName, exVersion, exChain, exVc] = await pub.readContract({ address: exchange, abi: EXCHANGE_ABI, functionName: "eip712Domain" });
  const exDomain = { name: exName, version: exVersion, chainId: Number(exChain), verifyingContract: exVc };
  const contents = {
    salt: BigInt(order.salt),
    maker: order.maker as Address,
    signer: order.signer as Address,
    tokenId: BigInt(order.tokenId),
    makerAmount: BigInt(order.makerAmount),
    takerAmount: BigInt(order.takerAmount),
    side: order.side === "BUY" || order.side === 0 ? 0 : 1,
    signatureType: Number(order.signatureType),
    timestamp: BigInt(order.timestamp),
    metadata: order.metadata as Hex,
    builder: order.builder as Hex,
  };
  const appSep = hashDomain({
    domain: { ...exDomain, chainId: exChain },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
  const contentsHash = hashStruct({ data: contents, primaryType: "Order", types: ORDER_TYPES });
  const inner = await wallet.signTypedData({
    domain: exDomain,
    types: { TypedDataSign: TYPED_DATA_SIGN, ...ORDER_TYPES },
    primaryType: "TypedDataSign",
    message: { contents, name: "PhoebeOrderSigner", version: "1", chainId: 137n, verifyingContract: s, salt: zeroHash },
  });
  const signature = encodePacked(
    ["bytes", "bytes32", "bytes32", "string", "uint16"],
    [inner, appSep, contentsHash, ORDER_TYPE_STRING, ORDER_TYPE_STRING.length],
  );
  const onchainOrder = { ...contents, signature };
  const orderHash = await pub.readContract({ address: exchange, abi: EXCHANGE_ABI, functionName: "hashOrder", args: [onchainOrder] });
  console.log(`order hash ${orderHash} (exchange ${exchange}, domain v${exVersion})`);

  if (mode === "hash") {
    const approved = await pub.readContract({ address: s, abi: signerAbi().abi, functionName: "approvedHash", args: [orderHash] });
    if (!approved) {
      await tx(`signer.approveHash(${orderHash})`, () =>
        wallet.writeContract({ address: s, abi: signerAbi().abi, functionName: "approveHash", args: [orderHash, true] }),
      );
    }
  }

  // 4. Preflight against the REAL exchange: proves the order is valid on-chain before the API sees it.
  try {
    await pub.readContract({ address: exchange, abi: EXCHANGE_ABI, functionName: "validateOrder", args: [onchainOrder] });
    console.log("preflight: exchange.validateOrder OK (signature accepted on-chain)");
  } catch (e) {
    if (mode === "hash" && !confirmed) console.log("preflight: skipped for hash mode in dry run (hash not approved yet)");
    else throw new Error(`preflight failed: the exchange rejects this order on-chain: ${(e as Error).message.split("\n")[0]}`);
  }

  if (willPost) {
    const g = await geoblock();
    console.log(`geoblock: ${JSON.stringify(g)}`);
    if (g.blocked) throw new Error(`Polymarket reports this location (${g.country}) as blocked; not posting.`);
  }
  if (!willPost) {
    return console.log(`\n[${confirmed ? "--no-post" : "dry run"}] stopping before POST /order.${confirmed ? "" : " Re-run with --yes to post and cancel."}`);
  }

  // 5. Post, look it up, cancel. The answer we came for is the API's response.
  const signed = { ...order, signature } as unknown as Parameters<typeof clob.postOrder>[0];
  const res = await clob.postOrder(signed, OrderType.GTC);
  console.log("\nPOST /order ->", JSON.stringify(res, null, 2));
  if (!res?.orderID) {
    console.log("\nRESULT: the CLOB did NOT accept a contract maker in this mode (see errorMsg above).");
    return;
  }
  console.log("\nRESULT: the CLOB ACCEPTED an order from the EIP-1271 contract maker.");
  const live = await clob.getOrder(res.orderID).catch((e) => ({ error: String(e) }));
  console.log("GET order ->", JSON.stringify(live));
  const cancel = await clob.cancelOrder({ orderID: res.orderID });
  console.log("DELETE order ->", JSON.stringify(cancel));
}

const commands: Record<string, () => Promise<void>> = {
  status, deploy, swap, fund, approve, withdraw, test, geo, "apikey-contract": apikeyContract,
};
if (!commands[cmd]) {
  console.error(`commands: ${Object.keys(commands).join(", ")}  (see the header of this file)`);
  process.exit(1);
}
try {
  await setupEgress();
  await commands[cmd]();
} finally {
  tunnel?.kill();
}
