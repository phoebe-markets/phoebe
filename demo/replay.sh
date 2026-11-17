#!/usr/bin/env bash
# Local demo: a chain whose clock starts at a historical market's first tick, the full protocol deployed with
# the backtested config, and the keeper replaying real prices (plus demo traders).
#
#   demo/replay.sh [sim/data/biden-nominee.json ...] [-- keeper flags, default: --speed 20 --traders 12]
#
# Env: PORT (8545). After the replay ends the chain stays up (for the UI) until Ctrl-C; KEEP_CHAIN=0 to exit.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
port=${PORT:-8545}

files=()
while [[ $# -gt 0 && $1 != "--" ]]; do files+=("$1"); shift; done
[[ ${1:-} == "--" ]] && shift
flags=("$@"); [[ ${#flags[@]} -eq 0 ]] && flags=(--speed 20 --traders 12)
[[ ${#files[@]} -eq 0 ]] && files=("$root/sim/data/biden-nominee.json")

read -r t0 res px names < <(python3 -I - "${files[@]}" <<'PY'
import json, os, sys
ds = [json.load(open(f)) for f in sys.argv[1:]]
t0 = min(d["t"][0] for d in ds)
res = ",".join(str(d.get("resolutionTime") or d["t"][-1] + 14 * 86400) for d in ds)
px = ",".join(str(min(d["p"][0], 1_000_000)) for d in ds)
names = ",".join((d.get("name") or os.path.basename(f)[:-5]).replace(",", " ") for d, f in zip(ds, sys.argv[1:]))
print(t0, res, px, names)
PY
)

anvil --port "$port" --timestamp "$t0" --silent &
anvil_pid=$!
trap 'kill $anvil_pid 2>/dev/null' EXIT
sleep 1

(cd "$root/contracts" && MARKET_RESOLUTIONS=$res MARKET_PRICES=$px MARKET_NAMES=$names \
  forge script script/Deploy.s.sol --rpc-url "http://127.0.0.1:$port" --broadcast -q)
echo "deployed at chain time $(date -u -d @"$t0" +%F\ %R) UTC -> deployments/local.json"

RPC_URL="http://127.0.0.1:$port" bun "$root/keeper/src/main.ts" replay "${files[@]}" "${flags[@]}"

if [[ ${KEEP_CHAIN:-1} == 1 ]]; then
  echo "replay done; chain still running on :$port for the UI (Ctrl-C to stop)"
  wait $anvil_pid
fi
