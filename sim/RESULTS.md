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
| **Absorb + 6h cool-off** | underwater positions aren't fire-sold: debt is written off against junior, the shares go to backstop inventory, and a keeper sells them 6h later (or at resolution) | fire-sales into crashed books; one-tick spikes |
| **Dutch-auction liquidation bonus** | starts at 3% and grows 1%/hour once a position is flagged liquidatable, up to 15% | thin books where a fixed bonus doesn't cover a liquidator's slippage |
| **Per-position borrow cap** | ≤ 3% of the market's daily volume | keeps every position small enough to liquidate profitably |
| Cluster caps | available, but set loosely (≥25% of the pool per cluster) | correlated markets in a shared pool. The backtest shows they cost volume without reducing tail losses (see below) |

## Round 2: liquidity, absorb, correlated markets

The liquidators now face square-root price impact when selling seized shares: `slip = Y·√(sold / daily volume)`,
using each market's lifetime average daily volume. Y = 0.3 (about 5% to sell $15k into $500k/day) is the
working assumption. Absorbed inventory pays the same impact when the keeper sells it.

**Absorb vs fire-sale** (full strategy, attentive traders, Y = 0.3):

| Underwater policy | Train LP PnL | Train worst mkt | Holdout LP PnL | Holdout worst mkt |
|---|---|---|---|---|
| Fire-sell to liquidators | +197k | −25k | +203k | −3.5k |
| Absorb, hold to resolution | +216k | **−135k** | +295k | −5.5k |
| Absorb, 1h cool-off | +368k | −10k | +218k | −3.8k |
| **Absorb, 6h cool-off** | **+392k** | **−3.5k** | **+218k** | −4.0k |
| Absorb, 24h cool-off | +387k | −6.0k | +214k | −4.6k |

- Holding to resolution makes the LPs bet on the outcome. That's the same expected value but a much fatter
  tail: one shutdown market took 67% of its junior tranche.
- A cool-off keeps most of the benefit without that bet. On the train set, a large share of the gain
  (+151k net recovery) comes from prices rebounding after crashes. On the holdout the recovery is only
  +2.6k, roughly what the martingale argument predicts. **The robust claim is "never worse, sometimes
  much better", not "+150k".**

**Liquidator slippage barely matters for the full strategy** (Y = 0 / 0.1 / 0.3 / 1.0 → train LP PnL
+243k / +243k / +197k / +192k). With heavy slippage, liquidators simply wait, and in markets that
recover that avoids crystallizing losses.

**Correlated markets in one shared pool:** 25 clusters (markets of the same event across both sets, plus a
21-market Iran theme), each replayed in one shared $1M pool, with every market trading at the same time.

| Cluster cap | LP PnL (25 pools) | Worst cluster | Junior min | Volume | Peak util |
|---|---|---|---|---|---|
| none | +389k | −2.5k | 197k | 193M | 32% |
| 25% of pool | +314k | −2.5k | 197k | 161M | 21% |
| 10% of pool | +197k | −2.7k | 197k | 105M | 10% |

With this risk engine, correlation isn't the binding risk in the data: per-market rules already keep each
jump small, and the junior-coverage gate limits total debt. Cluster caps are kept as a loose safety valve.

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

## Round 3: stress test, and the gap it found

**Stress:** 4× trader flow ($20k margin per position) on the shared-pool clusters, pushing utilization to the
junior-coverage limit (~90%).
- *Attentive traders:* LPs +$2.45M, worst cluster −$11.7k, senior never impaired. Correlation is still not the
  binding risk.
- *Lazy traders* broke it: on 23 clusters, credit loss was $1.15M, and the Romania election cluster lost $367k,
  more than its whole junior tranche. **Senior was impaired.**

**Cause:** position size vs liquidity, not a jump. $60k positions in markets trading $260–420k/day cost
11–14% to liquidate under the impact model, far above the 3% bonus. Liquidators passed (8,092 unprofitable
attempts), positions drifted underwater as the result became clear, and the protocol absorbed $877k of debt
into a book that kept falling. Even capping position size at 1% of daily volume wasn't enough: a $2.7k sale
still costs about 3.2%, more than the 3% bonus.

**Fix:** a Dutch-auction liquidation bonus (the discount grows until someone takes the position) plus a
per-position borrow cap.

| Romania cluster, lazy traders, 4× flow | LP PnL | Credit loss | Absorbed | Trader liq. penalties |
|---|---|---|---|---|
| Fixed 3% bonus | −367k | 583k | 49 | 14k |
| + position cap 1% of daily volume | −118k | 133k | 54 | 4k |
| **Auction bonus** (+1%/h, max 15%) | **+158k** | 102k | 14 | 270k |
| Auction + cap 3% | +67k | 20k | 12 | 155k |
| Auction + cap 1% | +32k | **0** | **0** | 36k |

**Full stress rerun with the fix** (lazy traders, 4× flow, all shared-pool clusters):

| | Fixed 3% bonus | **Auction + 3% cap** |
|---|---|---|
| Credit loss (24 comparable clusters) | 1.18M | **266k** |
| Worst cluster | −367k (Romania) | −97k (Fed chair, 49% of its junior) |
| Clusters with senior impaired | 9 | **0** |
| LP PnL, all 25 clusters | — | +2.03M |
| Share of positions liquidated / trader liq. penalties | 13% / 0.3M | 38% / 3.4M |

Lazy traders now pay for leaving oversized positions in thin markets. The LPs don't.

On the train and holdout sets the auction changes nothing, because attentive traders exit before the clock
runs: it costs nothing where it isn't needed. The 3% cap costs about 10% of holdout volume (LP PnL
+218k → +197k). Adopted: **auction + 3% cap.**

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
python3 sim/make-clusters.py                       # shared-pool clusters -> sim/data/clusters

FULL="NAIVE=false ATTENTIVE=9000 BONUS=300 LIQ_FEE=200 JUMP_BPS=1000 OPEN_FEE=30 SLIP_Y=3000 ABSORB=true INV_HOLD=21600"
DATASET=holdout  sim/backtest.sh h_full  $FULL
DATASET=clusters sim/backtest.sh cl_full $FULL     # ~3 min; the 21-market Iran cluster dominates
python3 sim/analyze.py h_full cl_full --markets
```

Single market with a timeline CSV: `REPLAY=batch/<slug> forge test --mc Replay -vv` (from `contracts/`).
