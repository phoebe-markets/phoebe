#!/usr/bin/env bash
# Render the Devpost gallery (1500x1000 PNG, 3:2) into demo/gallery/out/.
#   demo/gallery/render.sh          # designed slides + fresh screenshots of phoebe.markets
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
shot() { # url out.png [extra flags]
  timeout 120 chromium --headless=new --disable-gpu --hide-scrollbars --force-dark-mode \
    --blink-settings=preferredColorScheme=0 --window-size=1500,1000 --virtual-time-budget=25000 \
    --screenshot="$2" "$1" 2>/dev/null >/dev/null
}
# raw app screenshots (used inside the framed slides, and as plain gallery images)
shot "https://phoebe.markets/app/" shot-trade.png
shot "https://phoebe.markets/app/#lp" shot-lp.png
shot "https://phoebe.markets/app/?net=amoy" shot-amoy.png
shot "https://phoebe.markets/" out/02-landing.png
cp ../thumbnail/devpost-thumbnail.png out/01-title.png
n=3
for s in flow risk backtest tranches live app-trade app-lp; do
  shot "file://$PWD/slides.html#$s" "out/$(printf %02d $n)-$s.png"; n=$((n + 1))
done
ls -la out
