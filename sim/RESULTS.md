# Risk strategy backtests

Real Polymarket price histories (10-minute ticks, last 45 days before each market closed, then the
resolution tick) replayed through the real contracts. Each market gets its own $1M LP pool
(80% senior / 20% junior). A synthetic trader opens a $5k-margin position every 2 hours, alternating
YES and NO, at 90% of the max LTV allowed at that moment, and holds for up to 3 days. A liquidator
bot sweeps every tick and only liquidates when it's profitable at the *market* price.

- **Train set:** the 60 highest-volume resolved binary markets that pass the filters (`sim/data/batch`).
- **Holdout:** the next 60 (`sim/data/holdout`). No parameters were tuned on it.
- **Two trader models:** *lazy* (never exits early) and *attentive* (closes voluntarily once
  LTV ≥ 90% of the liquidation LTV). Real traders fall somewhere in between.

## Recommended strategy ("full")

| Mechanism | Setting | What it addresses |
|---|---|---|
| Price bands | full LTV for p in [0.15, 0.85], 0 at 0.03 / 0.97 | positions on near-0 / near-1 shares |
| Time ramp | ramps to 0 over the 3 days before a cutoff 24h ahead of scheduled resolution | known event dates (election night) |
| Volatility cap | cushion ≥ 2σ (1-day horizon), EWMA τ = 3 days | turbulent regimes (Biden debate → dropout) |
| Jump allowance | cushion ≥ an extra 0.10 absolute move | jumps out of calm markets (Lighter launch) |
| Liquidation split | 3% bonus to the liquidator + 2% fee to junior (same 5% total cost to traders) | funds the insurance buffer from the liquidation flow |
| Opening fee | 0.3% of borrowed, to junior | charges for the jump risk that remains |

## Results: LP PnL summed over 60 × $1M pools, ~45 days each

| Strategy | Train, lazy | Train, attentive | **Holdout, lazy** | **Holdout, attentive** |
|---|---|---|---|---|
| Naive (flat 75% LTV, one pool) | −5,911k | — | −7,980k | — |
| Base (bands + ramp + vol) | −125k | −97k | −15k | — |
| + opening fee | +160k | +187k | +260k | +264k |
| + opening fee + jump 0.10 | — | +134k | — | +165k |
| **Full** | **+474k** | **+243k** | **+523k** | **+271k** |

Full strategy on the holdout: bad debt $13k (10–11 events) on $118M notional, 3/60 markets lose money,
the worst single market is −$3.5k (1.75% of that pool's junior tranche), and senior LPs are never impaired.

## What didn't work

- **Higher base interest rate** (5% → 15% APR): it only adds about $64k, because holds are short. A
  fee charged per position beats a rate charged per unit of time.
- **Median-of-3 oracle:** worse (−148k vs −125k). It does filter one-tick spikes, but it also delays
  liquidations during real jumps. An earlier version of the sim showed it as perfect, but that was
  an artifact: the liquidator was paying the lagged oracle price. Fixed by separating the market
  price from the oracle and requiring liquidations to be profitable.

## Trade-offs

- The jump allowance costs about 35% of volume. On average LP PnL it loses to a plain opening fee,
  but it cuts bad debt by about 75% and the worst-market loss by 2–3×. We take the smaller tail.
- With lazy traders, 40%+ of positions get liquidated; with attentive traders, 17–18%. The full strategy is
  profitable under both, and doesn't depend on traders getting liquidated: on the holdout with
  attentive traders, revenue is $155k opening fees + about $105k liquidation fees + interest.

## Known limits of the backtest

- **10-minute ticks.** Real liquidations are faster, but a jump is a jump, so the sim is roughly neutral here.
- **Liquidators always show up and pay the market price.** After a real crash the book may be thin, so
  the real outcome is likely worse. Mitigations: whitelisting liquid markets and per-market borrow caps.
- **Isolated per-market pools.** A shared pool takes correlated jumps across related markets (e.g. 6 Iran
  markets) at the same time. Needs caps per *event cluster*, not just per market.
- **Trader demand doesn't respond to fees or rates.**
- **Survivorship.** The dataset is top-volume markets only, which is also what we'd whitelist.

## Reproduce

```sh
bun sim/fetch-batch.ts 60 45 1000                 # train set -> sim/data/batch
bun sim/fetch-batch.ts 60 45 2000 holdout 60      # holdout   -> sim/data/holdout
DATASET=holdout sim/backtest.sh h_att_full NAIVE=false ATTENTIVE=9000 \
  BONUS=300 LIQ_FEE=200 JUMP_BPS=1000 OPEN_FEE=30
python3 sim/analyze.py h_att_full --markets
```

Single market with a timeline CSV: `REPLAY=batch/<slug> forge test --mc Replay -vv` (from `contracts/`).
