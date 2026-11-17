/**
 * Read-only checks before a Polygon mainnet deployment, plus market selection.
 *
 *   bun keeper/src/polygon-facts.ts                 # facts + ranked candidates
 *   bun keeper/src/polygon-facts.ts --write 3       # also write the top 3 to deployments/polygon-markets.env
 *   bun keeper/src/polygon-facts.ts --min-days 30 --max-spread 0.01 --pick <conditionId>,<conditionId>
 *
 * Confirms, on-chain:
 *   - the CTF and collateral (pUSD) the Polymarket exchanges use
 *   - the CTF positions themselves are USDC.e-backed (legacy CTF); Polymarket's CtfCollateralAdapter does
 *     split/merge/redeem in pUSD by unwrapping/wrapping around the CTF. We settle through that adapter, so the
 *     pool stays in pUSD. Checks the adapter's wiring and pause state.
 *   - every candidate's YES/NO token ids == getPositionId(USDC.e, getCollectionId(0, conditionId, indexSet)),
 *     i.e. the adapter can redeem them
 *   - binary (2 outcome slots), not yet resolved
 * Market filters (Gamma API): order book on, not neg-risk, Yes/No outcomes, mid within [0.2, 0.8], tight spread,
 * resolves at least --min-days out. Ranked by 24h volume.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, zeroHash, type Address, type Hex } from "viem";
import { polygon } from "viem/chains";

const ROOT = join(import.meta.dir, "..", "..");
const EXCHANGE_V2: Address = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2: Address = "0xe2222d279d744050d28e00520010520000310F59";
// ctf-exchange-v2 README
const CTF_ADAPTER: Address = "0xADa100874d00e3331D00F2007a9c336a65009718";
const ONRAMP: Address = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const OFFRAMP: Address = "0x2957922Eb93258b93368531d39fAcCA3B4dC5854";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const MIN_DAYS = Number(opt("min-days", "30"));
const MAX_SPREAD = Number(opt("max-spread", "0.01"));
const WRITE = Number(opt("write", "0"));
const PICK = opt("pick", "").split(",").filter(Boolean).map((s) => s.toLowerCase());

const pub = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC ?? "https://polygon-bor-rpc.publicnode.com"),
  batch: { multicall: true },
});

const EXCHANGE = parseAbi(["function getCtf() view returns (address)", "function getCollateral() view returns (address)"]);
const ADAPTER = parseAbi([
  "function CONDITIONAL_TOKENS() view returns (address)",
  "function COLLATERAL_TOKEN() view returns (address)",
  "function USDCE() view returns (address)",
  "function paused(address) view returns (bool)",
]);
const ERC20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const CTF = parseAbi([
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
]);

type Gamma = {
  question: string;
  slug: string;
  conditionId: Hex;
  clobTokenIds?: string;
  outcomes?: string;
  negRisk?: boolean;
  enableOrderBook?: boolean;
  endDate?: string;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  volume24hr?: number;
  liquidityNum?: number;
  orderMinSize?: number;
  orderPriceMinTickSize?: number;
};

async function facts() {
  const [ctf, collateral, nrCtf, nrCollateral] = await Promise.all([
    pub.readContract({ address: EXCHANGE_V2, abi: EXCHANGE, functionName: "getCtf" }),
    pub.readContract({ address: EXCHANGE_V2, abi: EXCHANGE, functionName: "getCollateral" }),
    pub.readContract({ address: NEG_RISK_EXCHANGE_V2, abi: EXCHANGE, functionName: "getCtf" }),
    pub.readContract({ address: NEG_RISK_EXCHANGE_V2, abi: EXCHANGE, functionName: "getCollateral" }),
  ]);
  const [dec, sym] = await Promise.all([
    pub.readContract({ address: collateral, abi: ERC20, functionName: "decimals" }),
    pub.readContract({ address: collateral, abi: ERC20, functionName: "symbol" }),
  ]);
  console.log(`exchange v2:     ctf ${ctf}, collateral ${collateral} (${sym}, ${dec} decimals)`);
  console.log(`neg-risk v2:     ctf ${nrCtf}, collateral ${nrCollateral}`);
  const [aCtf, aColl, usdce] = await Promise.all(
    (["CONDITIONAL_TOKENS", "COLLATERAL_TOKEN", "USDCE"] as const).map((f) =>
      pub.readContract({ address: CTF_ADAPTER, abi: ADAPTER, functionName: f }),
    ),
  );
  if (aCtf !== ctf || aColl !== collateral) throw new Error(`adapter wired to ctf ${aCtf} / collateral ${aColl}`);
  const paused = async (a: Address) => pub.readContract({ address: a, abi: ADAPTER, functionName: "paused", args: [usdce] });
  const [pa, pon, poff] = await Promise.all([paused(CTF_ADAPTER), paused(ONRAMP), paused(OFFRAMP)]);
  console.log(`ctf adapter:     ${CTF_ADAPTER} (CTF positions are backed by USDC.e ${usdce})`);
  console.log(`USDC.e paused?   adapter ${pa}, onramp ${pon}, offramp ${poff}`);
  return { ctf, collateral, usdce, dec };
}

async function gammaMarkets(): Promise<Gamma[]> {
  const out: Gamma[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const r = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=100&offset=${offset}`,
    );
    if (!r.ok) throw new Error(`gamma ${r.status}: ${await r.text()}`);
    const page = (await r.json()) as Gamma[];
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

function screen(m: Gamma): string | null {
  if (!m.enableOrderBook) return "no book";
  if (m.negRisk) return "neg-risk";
  const outcomes = JSON.parse(m.outcomes ?? "[]");
  if (outcomes.length !== 2 || outcomes[0] !== "Yes" || outcomes[1] !== "No") return "not Yes/No";
  if (JSON.parse(m.clobTokenIds ?? "[]").length !== 2) return "tokens";
  const mid = ((m.bestBid ?? 0) + (m.bestAsk ?? 0)) / 2;
  if (mid < 0.2 || mid > 0.8) return "price";
  if ((m.spread ?? 1) > MAX_SPREAD) return "spread";
  const end = Date.parse(m.endDate ?? "");
  if (!(end > Date.now() + MIN_DAYS * 86400_000)) return "too soon";
  return null;
}

async function verify(ctf: Address, collateral: Address, m: Gamma) {
  const [yes, no] = JSON.parse(m.clobTokenIds!) as string[];
  const coll = await Promise.all(
    [1n, 2n].map((i) =>
      pub.readContract({ address: ctf, abi: CTF, functionName: "getCollectionId", args: [zeroHash, m.conditionId, i] }),
    ),
  );
  const [pYes, pNo, denom, slots] = await Promise.all([
    pub.readContract({ address: ctf, abi: CTF, functionName: "getPositionId", args: [collateral, coll[0]] }),
    pub.readContract({ address: ctf, abi: CTF, functionName: "getPositionId", args: [collateral, coll[1]] }),
    pub.readContract({ address: ctf, abi: CTF, functionName: "payoutDenominator", args: [m.conditionId] }),
    pub.readContract({ address: ctf, abi: CTF, functionName: "getOutcomeSlotCount", args: [m.conditionId] }),
  ]);
  const problems: string[] = [];
  if (pYes.toString() !== yes || pNo.toString() !== no) problems.push("token ids not USDC.e CTF positions");
  if (denom !== 0n) problems.push("already resolved");
  if (slots !== 2n) problems.push(`${slots} outcome slots`);
  return { yes, no, problems };
}

const { ctf, collateral, usdce } = await facts();
const all = await gammaMarkets();
const reasons: Record<string, number> = {};
let candidates = all.filter((m) => {
  if (PICK.length) return PICK.includes(m.conditionId.toLowerCase());
  const why = screen(m);
  if (why) reasons[why] = (reasons[why] ?? 0) + 1;
  return !why;
});
console.log(`\ngamma: ${all.length} active markets; screened out ${JSON.stringify(reasons)}; ${candidates.length} candidates\n`);

const picked: (Gamma & { yes: string; no: string })[] = [];
for (const m of candidates.slice(0, 25)) {
  const v = await verify(ctf, usdce, m);
  const mid = ((m.bestBid ?? 0) + (m.bestAsk ?? 0)) / 2;
  const tag = v.problems.length ? `REJECT (${v.problems.join(", ")})` : "ok";
  console.log(
    `${tag.padEnd(8)} vol24h $${Math.round(m.volume24hr ?? 0).toLocaleString().padStart(10)}  liq $${Math.round(m.liquidityNum ?? 0).toLocaleString().padStart(9)}  ` +
      `mid ${mid.toFixed(3)}  spread ${(m.spread ?? 0).toFixed(3)}  ends ${m.endDate?.slice(0, 10)}  ${m.question}`,
  );
  if (!v.problems.length) picked.push({ ...m, yes: v.yes, no: v.no });
}

if (WRITE > 0) {
  const top = picked.slice(0, WRITE);
  if (!top.length) throw new Error("no verified candidates to write");
  const q = (xs: (string | number)[]) => xs.join(",");
  const env = [
    `# Polymarket markets for the Polygon mainnet deployment (picked ${new Date().toISOString().slice(0, 10)} by keeper/src/polygon-facts.ts:`,
    `# not neg-risk, Yes/No, mid 0.2-0.8, spread <= ${MAX_SPREAD}, >= ${MIN_DAYS} days out, token ids verified as USDC.e CTF positions, settled in pUSD via the adapter)`,
    `POLY_CTF=${ctf}`,
    `POLY_COLLATERAL=${collateral}`,
    `POLY_CTF_ADAPTER=${CTF_ADAPTER}`,
    `MARKET_NAMES="${q(top.map((m) => m.question.replaceAll('"', "").replaceAll(",", "").replaceAll("$", "\\$")))}"`,
    `MARKET_SLUGS=${q(top.map((m) => m.slug))}`,
    `CONDITION_IDS=${q(top.map((m) => m.conditionId))}`,
    `POLY_TOKEN_IDS=${q(top.map((m) => m.yes))}`,
    `POLY_NO_TOKEN_IDS=${q(top.map((m) => m.no))}`,
    `MARKET_RESOLUTIONS=${q(top.map((m) => Math.floor(Date.parse(m.endDate!) / 1000)))}`,
    `MARKET_PRICES=${q(top.map((m) => Math.round((((m.bestBid ?? 0) + (m.bestAsk ?? 0)) / 2) * 1e6)))}`,
    "",
  ].join("\n");
  const path = join(ROOT, "deployments", "polygon-markets.env");
  writeFileSync(path, env);
  console.log(`\nwrote ${top.length} markets to ${path}`);
}
