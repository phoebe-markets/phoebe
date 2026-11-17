#!/usr/bin/env bash
# Polygon mainnet runbook for the low-dollar live beta. Everything that spends or moves money needs --yes, and the
# commands that trade (split/merge inventory, live hedging) are for the operator to run, not automation.
#
#   POLYGON_RPC=https://...   (an RPC with archive access, e.g. https://polygon.drpc.org or a paid endpoint)
#
#   demo/polygon.sh keys                 # create ~/.phoebe/polygon-{deployer,keeper}.key (600) if missing; print addresses
#   demo/polygon.sh balances             # POL / pUSD / USDC.e of deployer + keeper, venue + pool state
#   demo/polygon.sh deploy --yes         # deploy with deployments/polygon-markets.env -> deployments/polygon.json (gas only)
#   demo/polygon.sh install              # keeper + hedger service on earth (hedger in DRY RUN)
#   demo/polygon.sh status               # hedger view: inventory, exposure, books (via earth egress)
#   demo/polygon.sh split <m> <usd> --yes            # keeper wallet: pUSD -> YES+NO inventory for market m
#   demo/polygon.sh hedge-live on|off    # flip live hedging on earth (on = the service posts Polymarket orders)
#   demo/polygon.sh pause --yes          # kill switch: no new positions, no deposits, venue off (exits keep working)
#   demo/polygon.sh unpause --yes
#   demo/polygon.sh unwind --yes         # stop the service, merge every YES+NO pair back to pUSD
#
# Keys never leave ~/.phoebe except the keeper key, which install ships to earth (root 600, systemd credential).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
rpc=${POLYGON_RPC:?set POLYGON_RPC}
D=$root/deployments/polygon.json
yes=0; for a in "$@"; do [ "$a" = --yes ] && yes=1; done
need_yes() { [ $yes = 1 ] || { echo "dry run: add --yes to send ($*)"; exit 0; }; }
j() { python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$D" "$1"; }
addr() { cat ~/.phoebe/polygon-$1.address; }
PUSD=0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB
USDCE=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
fee=(--priority-gas-price 30gwei)

keeper_env() { export DEPLOYMENT=polygon RPC_URL=$rpc KEEPER_PK=$(cat ~/.phoebe/polygon-keeper.key); }

case "${1:-}" in
  keys)
    umask 077; mkdir -p ~/.phoebe
    for k in deployer keeper; do
      if [ ! -f ~/.phoebe/polygon-$k.key ]; then
        echo "0x$(openssl rand -hex 32)" > ~/.phoebe/polygon-$k.key
        cast wallet address "$(cat ~/.phoebe/polygon-$k.key)" > ~/.phoebe/polygon-$k.address
      fi
      echo "$k: $(addr $k)"
    done
    ;;
  balances)
    for k in deployer keeper; do
      a=$(addr $k)
      printf '%-9s %s  %8s POL  %8s pUSD  %8s USDC.e\n' "$k" "$a" \
        "$(cast balance "$a" --rpc-url "$rpc" --ether | cut -c1-8)" \
        "$(cast call $PUSD 'balanceOf(address)(uint256)' "$a" --rpc-url "$rpc" | cut -d' ' -f1 | python3 -I -c 'print(int(input())/1e6)')" \
        "$(cast call $USDCE 'balanceOf(address)(uint256)' "$a" --rpc-url "$rpc" | cut -d' ' -f1 | python3 -I -c 'print(int(input())/1e6)')"
    done
    if [ -f "$D" ]; then
      echo "venue active: $(cast call "$(j venue)" 'active()(bool)' --rpc-url "$rpc")   pm paused: $(cast call "$(j positionManager)" 'paused()(bool)' --rpc-url "$rpc")"
      for t in 0 1; do echo "tranche $t: $(cast call "$(j pool)" 'trancheAssets(uint8)(uint256)' $t --rpc-url "$rpc" | cut -d' ' -f1 | python3 -I -c 'print(int(input())/1e6)') pUSD"; done
      echo "debt: $(cast call "$(j pool)" 'totalDebt()(uint256)' --rpc-url "$rpc" | cut -d' ' -f1 | python3 -I -c 'print(int(input())/1e6)') pUSD"
    fi
    echo "gas price: $(cast gas-price --rpc-url "$rpc" | python3 -I -c 'import sys; print(round(int(sys.stdin.read())/1e9,1))') gwei"
    ;;
  deploy)
    [[ $(cast chain-id --rpc-url "$rpc") == 137 ]] || { echo "RPC is not Polygon mainnet"; exit 1; }
    [ -f "$D" ] && { echo "$D exists; move it away to redeploy"; exit 1; }
    need_yes "deploy the protocol on Polygon mainnet from $(addr deployer)"
    set -a; . "$root/deployments/polygon-markets.env"; set +a
    cd "$root/contracts"
    NETWORK=polygon DEPLOYMENT=polygon VENUE=keeper KEEPER_ADDR=$(addr keeper) DEPLOYER_PK=$(cat ~/.phoebe/polygon-deployer.key) \
      forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast --slow "${fee[@]}"
    echo "-> deployments/polygon.json"
    ;;
  install)
    NET=polygon POLYGON_RPC=$rpc "$root/demo/install-keeper-service.sh" earth
    ;;
  status)
    keeper_env; exec bun "$root/keeper/src/hedger.ts" status --ssh earth
    ;;
  split)
    need_yes "split \$$3 pUSD into market $2 inventory"
    keeper_env; exec bun "$root/keeper/src/hedger.ts" split "$2" "$3" --yes --ssh earth
    ;;
  hedge-live)
    v=$([ "${2:-}" = on ] && echo 1 || echo 0)
    ssh -o BatchMode=yes earth "sed -i 's/^HEDGE_LIVE=.*/HEDGE_LIVE=$v/' /etc/phoebe/polygon.env && systemctl restart phoebe-keeper-polygon && sleep 15 && journalctl -u phoebe-keeper-polygon -n 6 -o cat"
    ;;
  pause|unpause)
    on=$([ "$1" = pause ] && echo true || echo false)
    need_yes "$1"
    pk=$(cat ~/.phoebe/polygon-deployer.key)
    cast send "$(j positionManager)" 'setPaused(bool)' $on --private-key "$pk" --rpc-url "$rpc" "${fee[@]}" >/dev/null
    cast send "$(j pool)" 'setDepositsPaused(bool)' $on --private-key "$pk" --rpc-url "$rpc" "${fee[@]}" >/dev/null
    act=$([ $on = true ] && echo false || echo true)
    cast send "$(j venue)" 'setActive(bool)' $act --private-key "$pk" --rpc-url "$rpc" "${fee[@]}" >/dev/null
    echo "${1}d: positions $([ $on = true ] && echo closed || echo open), deposits $([ $on = true ] && echo paused || echo open), venue active=$act"
    [ $on = true ] && echo "note: the hedger re-activates the venue when healthy; also run: demo/polygon.sh hedge-live off, or stop the service"
    ;;
  unwind)
    need_yes "stop the keeper service and merge all YES+NO pairs back to pUSD"
    ssh -o BatchMode=yes earth "systemctl stop phoebe-keeper-polygon" || true
    keeper_env
    n=$(j markets)
    for ((m = 0; m < n; m++)); do bun "$root/keeper/src/hedger.ts" merge $m all --yes --ssh earth; done
    "$0" balances
    ;;
  *) sed -n '2,21p' "$0"; exit 1 ;;
esac
