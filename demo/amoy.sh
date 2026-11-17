#!/usr/bin/env bash
# Polygon Amoy testnet: deploy the protocol (KeeperVenue / Path B) on live Polymarket markets, and run its keeper.
#
#   demo/amoy.sh balances     # deployer + keeper POL balances
#   demo/amoy.sh deploy       # deploy with deployments/amoy-markets.env -> deployments/amoy.json
#   demo/amoy.sh keeper       # live keeper: Polymarket midpoints -> oracle, maker inventory, liquidations
#
# Keys: ~/.phoebe/amoy-deployer.key and ~/.phoebe/amoy-keeper.key (testnet only). Env: AMOY_RPC.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
rpc=${AMOY_RPC:-https://polygon-amoy-bor-rpc.publicnode.com}
dep_addr=$(cat ~/.phoebe/amoy-deployer.address)
kpr_addr=$(cat ~/.phoebe/amoy-keeper.address)

case "${1:-}" in
  balances)
    for a in "deployer $dep_addr" "keeper $kpr_addr"; do
      set -- $a; printf '%-9s %s  %s POL\n' "$1" "$2" "$(cast balance "$2" --rpc-url "$rpc" --ether)"
    done
    echo "gas price: $(cast gas-price --rpc-url "$rpc" | python3 -I -c 'import sys; print(round(int(sys.stdin.read())/1e9,1))') gwei"
    ;;
  deploy)
    [[ $(cast chain-id --rpc-url "$rpc") == 80002 ]] || { echo "RPC is not Amoy"; exit 1; }
    set -a; . "$root/deployments/amoy-markets.env"; set +a
    cd "$root/contracts"
    DEPLOYMENT=amoy VENUE=keeper KEEPER_ADDR=$kpr_addr DEPLOYER_PK=$(cat ~/.phoebe/amoy-deployer.key) \
      forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast --slow
    echo "-> deployments/amoy.json"
    ;;
  keeper)
    DEPLOYMENT=amoy RPC_URL=$rpc KEEPER_PK=$(cat ~/.phoebe/amoy-keeper.key) \
      exec bun "$root/keeper/src/main.ts" live --interval "${INTERVAL:-60}" --min-move "${MIN_MOVE:-0.003}" --heartbeat "${HEARTBEAT:-1500}"
    ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
