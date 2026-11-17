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
 *   bun keeper/src/polymarket-1271-test.ts fund 1 --yes            # wrap 1 USDC -> 1 pUSD straight into the signer
 *   bun keeper/src/polymarket-1271-test.ts approve --yes           # signer approves pUSD to the exchanges
 *   bun keeper/src/polymarket-1271-test.ts test <tokenId>          # DRY RUN: build, sign, preflight on-chain
 *   bun keeper/src/polymarket-1271-test.ts test <tokenId> --mode hash --yes   # post + cancel (vault design)
 *   bun keeper/src/polymarket-1271-test.ts test <tokenId> --mode 7739 --yes   # post + cancel (owner signature)
 *   bun keeper/src/polymarket-1271-test.ts withdraw --yes          # pUSD back to PK
 *
 * Rehearsal without real funds: point POLYGON_RPC at an Anvil fork of Polygon and use an Anvil key, then
 * `test <tokenId> --mode hash --yes --no-post` (on-chain steps run on the fork; nothing is posted to Polymarket).
 *
 * Nothing here ever crosses the book: orders are BUYs at the minimum tick, far below the best bid.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const EXCHANGE_V2: Address = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2: Address = "0xe2222d279d744050d28e00520010520000310F59";
const EXCHANGE_V3: Address = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const ONRAMP_ABI = parseAbi(["function wrap(address _asset, address _to, uint256 _amount)"]);
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

// ---------------------------------------------------------------- commands

async function status() {
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
  console.log(`wrap ${usd(amount)} ${has("usdce") ? "USDC.e" : "USDC"} from ${account.address} into pUSD held by the signer ${s}`);
  await tx(`approve ${usd(amount)} to the pUSD onramp`, () =>
    wallet.writeContract({ address: asset, abi: ERC20, functionName: "approve", args: [ONRAMP, amount] }),
  );
  await tx(`onramp.wrap(${asset}, signer, ${usd(amount)})`, () =>
    wallet.writeContract({ address: ONRAMP, abi: ONRAMP_ABI, functionName: "wrap", args: [asset, s, amount] }),
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
  // Only touch API credentials when actually posting: deriving a key registers it with Polymarket.
  const creds = willPost ? (envCreds ?? (await l1.createOrDeriveApiKey())) : undefined;
  const clob = new ClobClient({
    host: HOST,
    chain: 137,
    signer: clobSigner,
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

const commands: Record<string, () => Promise<void>> = { status, deploy, fund, approve, withdraw, test };
if (!commands[cmd]) {
  console.error(`commands: ${Object.keys(commands).join(", ")}  (see the header of this file)`);
  process.exit(1);
}
await commands[cmd]();
