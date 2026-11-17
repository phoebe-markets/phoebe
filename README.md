# Phoebe

Leveraged trading on Polymarket outcome tokens. Traders post USDC margin and borrow from a tranched LP pool.
The risk engine is built and backtested around the problem specific to prediction markets: prices *jump*,
and every market ends in a jump to 0 or 1.

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry project: `LendingPool` + `TrancheVault` (senior/junior), `RiskEngine`, `PositionManager`, `KeeperOracle`, mocks |
| `sim/` | Backtesting on real Polymarket price histories. `sim/RESULTS.md` has the findings and the chosen risk config |
| `keeper/` | Bun + viem keeper: pushes oracle prices (live Polymarket or historical replay) and runs liquidate / absorb / inventory sales |
| `web/` | Vite + React + viem dashboard: market risk breakdown, price and max-leverage history, trading, positions, LP tranches, activity |
| `demo/replay.sh` | One command: historical local chain + deploy + keeper replay + demo traders |
| `demo/amoy.sh` | Polygon Amoy testnet: balances / deploy / run the live keeper (`deployments/amoy.json`) |
| `demo/install-keeper-service.sh` | Install the live Amoy keeper as a systemd service on a server (runs on `earth`) |
| `NOTES.md` | Open items (live Polymarket order routing) |

## How the risk engine works

The liquidation LTV for a position is the minimum of:
- **base × price band × time ramp:** no leverage near 0 or 1, ramping to zero before scheduled resolution
- **volatility + jump cap:** `1 − (2σ₁d + 0.10) / p`, so the collateral cushion covers a 2-sigma day plus a 10-cent jump

Underwater positions are never fire-sold. They're **absorbed** (debt written off against junior, shares into
backstop inventory) and sold by the keeper after a 6h cool-off. Fees (0.3% opening, 2% of each liquidation) go
to the junior tranche, which takes first loss.

Backtest on 60 holdout markets: LPs +$218k to +$523k depending on trader behavior. Senior was never impaired.
Details: `sim/RESULTS.md`.

## Run it

```sh
# contracts
cd contracts && forge test

# backtest one market with a timeline CSV
REPLAY=biden-nominee forge test --mc Replay -vv

# full demo: Biden 2024 nomination market, replayed through a live local chain
cd keeper && bun install && cd ..
demo/replay.sh sim/data/biden-nominee.json -- --speed 20 --traders 12

# UI (in another terminal): http://localhost:5173
cd web && bun install && bunx vite
```

The UI reads `deployments/local.json` and the ABIs from `contracts/out` through the dev server, so it always
matches the latest deploy. It signs with Anvil's demo accounts (Trader / Senior LP / Junior LP selector), so
nobody needs a wallet locally.

`demo/replay.sh` starts Anvil with its clock at the market's first tick, deploys with
`contracts/script/Deploy.s.sol` (addresses in `deployments/local.json`), and runs `keeper/src/main.ts`.
