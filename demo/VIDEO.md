# Demo video plan (about 3 minutes)

The story: **leverage on Polymarket, funded by a two-tranche LP pool, with real execution and real liquidations.**
Mainnet shows that it's real: real USDC.e, real Polymarket shares, a real hedge fill. The local replay shows what
mainnet can't do on cue: a price crash driving liquidations and an absorb, using a historical market's real prices.

## Before recording
- [ ] `POLYGON_RPC=https://polygon.drpc.org demo/polygon.sh balances`: the keeper shows about 150 YES and 150 NO
      per market, the venue is active, and the pool has the LP seed.
- [ ] `journalctl -u phoebe-keeper-polygon -f` on earth shows price pushes; `hedge-live` is on.
- [ ] MetaMask on Polygon, holding about $60 USDC.e and 2 POL. A clean browser profile with no other extensions.
- [ ] Second terminal, local replay ready: `demo/replay.sh sim/data/biden-nominee.json -- --speed 20 --traders 12`,
      then the UI at `localhost:5173/app/?net=local`.
- [ ] Polymarket open in a tab, on the market you'll trade, showing the same price as Phoebe.
- [ ] Polygonscan open on the PositionManager address, for the "it's on chain" shot.

## Shot list
| # | Time | On screen | Voice-over |
|---|------|-----------|------------|
| 1 | 0:00–0:15 | phoebe.markets landing page | "Polymarket has deep liquidity and no leverage. Phoebe adds leverage, funded by LPs who choose their risk." |
| 2 | 0:15–0:40 | App → LP tab: pool overview, senior vs junior cards. Deposit $25 into junior, confirm in MetaMask. | "Senior LPs are paid first and take losses last. Junior takes first loss and earns the opening and liquidation fees. These are real deposits on Polygon mainnet." |
| 3 | 0:40–1:15 | Trade tab: pick the market and show that the price matches the Polymarket tab. Margin $15 at 2x, point at the liquidation price, then open. | "Every position is backed by real Polymarket outcome shares that the protocol holds. The loan comes from the pool, and the liquidation line moves with volatility and as resolution gets closer." |
| 4 | 1:15–1:35 | earth terminal: hedger log line (`BUY … YES … matched`) → Polygonscan transaction | "Our market maker sold those shares, then bought the same amount back on Polymarket's order book within seconds, so it stays flat." |
| 5 | 1:35–2:25 | Local replay, sped up: a historical market crashes, positions turn red, the keeper liquidates, a position is absorbed, the activity feed fills in | "This is a real market's price history replayed at 20x. When prices crash, the keeper liquidates. If a position is too far gone to sell, the pool absorbs the shares as inventory, and junior takes the hit before senior does." |
| 6 | 2:25–2:45 | Back on mainnet: close the position (profit or loss, whichever it is), then show the LP position with accrued interest | "Closing sells the shares back through the venue and repays the loan, in one transaction." |
| 7 | 2:45–3:00 | Landing page or architecture diagram | "Senior/junior tranches, a live risk engine, real Polymarket execution. phoebe.markets." |

## Notes
- Keep mainnet amounts small but visible. Per-position size is capped at $40 (margin + borrow), so 2x on $15 fits.
- If the maker briefly shows "Market maker offline" (hedger in cooldown or a stale price), wait one keeper tick (15s).
- Fallback if mainnet isn't funded in time: record shots 2–4 on Amoy (`?net=amoy`, faucet button) and say "testnet".
  Shot 4 then becomes the keeper log, not a Polymarket fill.
- Record at 1920×1080 with browser zoom at 110%, and hide the bookmarks bar.
- After recording: `demo/polygon.sh pause --yes` if you're done taking deposits, or leave it live for judges.
