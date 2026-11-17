# Phoebe — open items

## Can a contract place orders through Polymarket's API?

**Status (2026-11-16):** the on-chain half is **answered: yes**. The off-chain half (the CLOB API) is ready to test.
- `contracts/src/polymarket/PolymarketOrderSigner.sol`: an EIP-1271 maker that accepts either an owner ERC-7739
  signature (under its own domain, "PhoebeOrderSigner") or an owner pre-approved order hash (the vault design).
- `contracts/test/PolymarketFork.t.sol` (run with `POLYGON_RPC=... forge test --mc PolymarketFork`): the **real deployed
  CTFExchangeV2 accepts** both signature modes via `validateOrder`, rejects a mismatched order, and our order hash
  matches `hashOrder`.
- `keeper/src/polymarket-1271-test.ts`: deploy / fund / approve / test / withdraw against mainnet. Rehearsed end to end
  on an Anvil fork (both modes, normal and neg-risk exchange). Only `POST /order` hasn't run, because that needs real
  credentials. The test order is a BUY of 5 shares at the minimum tick ($0.01), far below the best bid, then cancelled.

**To run the live test** (your key; about $1 pUSD + a little POL for gas):
```sh
export PK=0x...                      # EOA with some POL and >= $1 USDC on Polygon
T=keeper/src/polymarket-1271-test.ts
bun $T status
bun $T deploy --yes
bun $T fund 1 --yes                  # wraps 1 USDC into pUSD held by the signer (--usdce for USDC.e)
bun $T approve --yes
bun $T test <tokenId> --mode hash --yes    # the vault design
bun $T test <tokenId> --mode 7739 --yes    # owner-signature design
bun $T withdraw --yes
```
API creds are derived from PK unless CLOB_API_KEY / CLOB_SECRET / CLOB_PASSPHRASE are set.
Polymarket API traffic can egress via `--ssh <host>` (opens `ssh -N -D` for the run) or `--socks host:port`; RPC stays
direct. `geo` shows what Polymarket sees, and `test --yes` refuses to post if Polymarket reports the location as blocked.
(This dev machine exits via a US VPN, which Polymarket blocks; the team is in Norway, so use `--ssh earth`.)
Native USDC wrapping is currently paused on the onramp: `swap` converts USDC to USDC.e first, then `fund --usdce`.
The result to look for is "RESULT: the CLOB ACCEPTED / did NOT accept ...", plus the API's errorMsg.

**Testnet note:** Polymarket's contracts exist on Amoy at the same addresses, but its staging CLOB
(clob-staging.polymarket.com) isn't publicly reachable, so the API question can only be answered on mainnet.

### Original investigation

The contracts reach the market through the
`IExecutionVenue` interface (`contracts/src/interfaces/IExecutionVenue.sol`). Whichever path we
pick, only a new venue adapter is needed.

**What we know (checked 2026-11-16):**
- Live exchange: `CTFExchangeV2` at `0xE111180000d2663C0091e4f400237545B87B996B`
  (neg-risk markets: `0xe2222d279d744050d28e00520010520000310F59`).
  Source: github.com/Polymarket/ctf-exchange-v2. The V1 exchange `0x4bFb…` is archived.
- Settlement token is **pUSD** (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`). Anyone can wrap
  USDC/USDC.e into it via CollateralOnramp `0x93070a847efEf7F70739046A929D47a521F5B8ee`.
- `clob-client-v2` also references `exchangeV3` at `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa`.
  It's an upgradeable proxy and I found no public source. Need to find out which markets use it.
- On-chain, V2 supports `SignatureType.POLY_1271` (3): signer == maker == contract, checked with
  solady `isValidSignatureNow`. **So a vault contract can be the maker on-chain.**
- Every fill is `onlyOperator`, so orders still have to go through Polymarket's off-chain order API (the CLOB).
- `clob-client-v2` only uses POLY_1271 for Polymarket's own "DepositWallet". The signature is
  ERC-7739 `TypedDataSign`-wrapped:
  `innerSig(65) || appDomainSep(32) || contentsHash(32) || contentsType || uint16 len`.

**Still unknown:** whether the closed-source CLOB API accepts an arbitrary 1271 contract as the
maker, or only Polymarket's deposit wallets. API keys are also tied to a regular wallet.

**Test plan (needs real Polymarket API creds and about $5 of pUSD; region may be blocked):**
1. Deploy a minimal 1271 contract on Polygon that holds pUSD and has set allowances for the exchange.
2. Post a small, non-crossing limit order with maker = contract via `clob-client-v2`, then cancel it.
3. If rejected, retry with the contract accepting the ERC-7739-wrapped format.

**Paths:**
- **A (1271 works):** `PolymarketVenue` acts as the maker. The vault records approved order hashes,
  and `isValidSignature` approves only those. Fills land in the vault and are reconciled through
  the exchange's on-chain order status.
- **B (fallback, keeper/solver):** a keeper buys on the CLOB with its own wallet, then sells the
  tokens to the vault in one transaction at a price the vault checks against the oracle.
  This doesn't depend on Polymarket's API.
