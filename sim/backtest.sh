#!/usr/bin/env bash
# Run the Forge replay over every market in sim/data/batch/manifest.json with one risk config.
#
#   sim/backtest.sh <tag> [KEY=VALUE ...]        e.g.  sim/backtest.sh k3 VOL_K=30000
#   DATASET=holdout sim/backtest.sh ...          (default dataset: batch)
#
# Writes sim/out/<tag>/<slug>.json per market and sim/out/<tag>/config.txt. Summarize with sim/analyze.py.
# Env knobs: see _loadConfig in contracts/test/Replay.t.sol. JOBS (default nproc) controls parallelism.
set -euo pipefail
tag=$1; shift
dataset=${DATASET:-batch}
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/sim/out/$tag"
mkdir -p "$out"
printf '%s\n' "$@" > "$out/config.txt"
(cd "$root/contracts" && forge build -q)

run_one() {
  slug=$1; tag=$2; shift 2
  cd "$ROOT/contracts"
  if ! env "$@" REPLAY="$DATASET_DIR/$slug" SUMMARY="$tag/$slug.json" forge test --mc Replay -q >/dev/null 2>"$ROOT/sim/out/$tag/$slug.err"; then
    echo "FAIL $slug (see sim/out/$tag/$slug.err)"
  else
    rm -f "$ROOT/sim/out/$tag/$slug.err"
  fi
}
export -f run_one
export ROOT=$root
export DATASET_DIR=$dataset

python3 -I -c "import json,sys; [print(m['slug']) for m in json.load(open(sys.argv[1]))]" "$root/sim/data/$dataset/manifest.json" \
  | xargs -P "${JOBS:-$(nproc)}" -I{} bash -c 'run_one "$@"' _ {} "$tag" "$@"
echo "done: $(ls "$out"/*.json | wc -l) markets -> $out"
