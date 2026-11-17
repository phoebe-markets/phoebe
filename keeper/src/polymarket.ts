/**
 * Polymarket on Polygon: contract addresses, minimal ABIs, CLOB client construction, and API egress (SOCKS / ssh -D)
 * with Polymarket's own geoblock check. Shared by the hedger and the test scripts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import axios from "axios"; // the same instance @polymarket/clob-client-v2 uses for every API call
import { SocksProxyAgent } from "socks-proxy-agent";
import { parseAbi, type Address } from "viem";
import { ClobClient, SignatureTypeV2, type ApiKeyCreds, type OrderBookSummary } from "@polymarket/clob-client-v2";

export const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";

// ctf-exchange-v2 README; verified on-chain by keeper/src/polygon-facts.ts
export const PUSD: Address = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const USDCE: Address = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged USDC.e (backs the CTF positions)
export const USDC: Address = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // native USDC
export const CTF: Address = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const CTF_ADAPTER: Address = "0xADa100874d00e3331D00F2007a9c336a65009718"; // split/merge/redeem in pUSD
export const ONRAMP: Address = "0x93070a847efEf7F70739046A929D47a521F5B8ee"; // USDC(.e) -> pUSD
export const OFFRAMP: Address = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854"; // pUSD -> USDC(.e)
export const EXCHANGE_V2: Address = "0xE111180000d2663C0091e4f400237545B87B996B";
export const NEG_RISK_EXCHANGE_V2: Address = "0xe2222d279d744050d28e00520010520000310F59";

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
export const CTF_ABI = parseAbi([
  "function balanceOf(address,uint256) view returns (uint256)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
  "function payoutDenominator(bytes32) view returns (uint256)",
]);
/** CtfCollateralAdapter (and MockCTF on testnets): collateral/parent/partition args are ignored by the adapter. */
export const ADAPTER_ABI = parseAbi([
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function paused(address asset) view returns (bool)",
]);
export const RAMP_ABI = parseAbi([
  "function wrap(address _asset, address _to, uint256 _amount)",
  "function unwrap(address _asset, address _to, uint256 _amount)",
  "function paused(address asset) view returns (bool)",
]);
export const PARTITION = [1n, 2n] as const;

// ---------------------------------------------------------------- CLOB

/**
 * CLOB client for an EOA trading from its own wallet (signature type EOA). Without creds it can only read; with
 * `deriveCreds` it creates or derives the EOA's API key (this registers the key with Polymarket).
 */
export async function clobClient(wallet: unknown, opts: { deriveCreds?: boolean; creds?: ApiKeyCreds } = {}) {
  // ClobSigner's type tracks a newer viem than ours; at runtime it only uses the account and signTypedData.
  const signer = wallet as ConstructorParameters<typeof ClobClient>[0]["signer"];
  let creds = opts.creds;
  if (!creds && process.env.CLOB_API_KEY) {
    creds = { key: process.env.CLOB_API_KEY, secret: process.env.CLOB_SECRET!, passphrase: process.env.CLOB_PASSPHRASE! };
  }
  if (!creds && opts.deriveCreds) {
    creds = await new ClobClient({ host: CLOB_HOST, chain: 137, signer }).createOrDeriveApiKey();
  }
  return new ClobClient({ host: CLOB_HOST, chain: 137, signer, creds, signatureType: SignatureTypeV2.EOA });
}

/** Best bid / ask from a book summary (doesn't rely on the API's level ordering). */
export function topOfBook(book: OrderBookSummary) {
  const bids = (book.bids ?? []).map((l) => Number(l.price));
  const asks = (book.asks ?? []).map((l) => Number(l.price));
  return {
    bid: bids.length ? Math.max(...bids) : 0,
    ask: asks.length ? Math.min(...asks) : 1,
    tick: book.tick_size as "0.1" | "0.01" | "0.001" | "0.0001",
    minSize: Number(book.min_order_size || 5),
    negRisk: Boolean(book.neg_risk),
  };
}

/** Shares available at or better than `limit` on one side (asks for a BUY, bids for a SELL). */
export function depthTo(book: OrderBookSummary, side: "BUY" | "SELL", limit: number) {
  const levels = side === "BUY" ? book.asks ?? [] : book.bids ?? [];
  return levels
    .filter((l) => (side === "BUY" ? Number(l.price) <= limit : Number(l.price) >= limit))
    .reduce((s, l) => s + Number(l.size), 0);
}

// ---------------------------------------------------------------- egress

let tunnel: ChildProcess | undefined;

function portOpen(port: number) {
  return new Promise<boolean>((res) => {
    const c = createConnection({ host: "127.0.0.1", port });
    c.once("connect", () => (c.destroy(), res(true)));
    c.once("error", () => res(false));
  });
}

/**
 * Route Polymarket API traffic (axios: the CLOB client and geoblock check) through SOCKS. `ssh` opens
 * `ssh -N -D` to that host for the life of the process; `socks` uses an existing proxy. RPC traffic stays direct.
 */
export async function setupEgress(opts: { ssh?: string; socks?: string }) {
  let socks = opts.socks ?? "";
  if (opts.ssh) {
    const port = 10_800 + Math.floor(Math.random() * 1000);
    tunnel = spawn("ssh", ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-D", `127.0.0.1:${port}`, opts.ssh], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    process.on("exit", () => tunnel?.kill());
    for (let i = 0; i < 50 && !(await portOpen(port)); i++) {
      if (tunnel.exitCode !== null) throw new Error(`ssh -D to ${opts.ssh} exited (${tunnel.exitCode})`);
      await Bun.sleep(200);
    }
    if (!(await portOpen(port))) throw new Error(`SOCKS tunnel to ${opts.ssh} didn't come up`);
    socks = `127.0.0.1:${port}`;
    console.log(`egress: Polymarket API via ssh -D ${opts.ssh} (SOCKS 127.0.0.1:${port})`);
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
export async function geoblock(): Promise<{ blocked: boolean; country?: string; ip?: string }> {
  const r = await axios.get("https://polymarket.com/api/geoblock", { timeout: 15_000 });
  return r.data;
}
