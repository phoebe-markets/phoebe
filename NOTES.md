# Phoebe — open items

## TODO (later): can a contract place orders through Polymarket's API?

**Status:** parked; this doesn't block anything else. The contracts reach the market through the
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
