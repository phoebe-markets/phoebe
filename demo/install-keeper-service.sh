#!/usr/bin/env bash
# Install / update a keeper as a systemd service on a remote host (Debian/systemd, root SSH).
#
#   demo/install-keeper-service.sh earth                                       # Amoy (unit phoebe-keeper)
#   NET=polygon POLYGON_RPC=https://... demo/install-keeper-service.sh earth   # mainnet (unit phoebe-keeper-polygon)
#   ssh earth journalctl -fu phoebe-keeper[-polygon]                           # follow logs
#
# Ships only what the keeper needs: keeper/, the ABIs it reads from contracts/out, deployments/<net>.json.
# The key (~/.phoebe/<net>-keeper.key) goes to /etc/phoebe/ (root 600) and reaches the service via systemd
# LoadCredential; the service runs as an ephemeral DynamicUser with a read-only filesystem.
#
# Mainnet: the keeper also runs the hedger, which only LOGS what it would trade until HEDGE_LIVE=1 is set in
# /etc/phoebe/polygon.env (root 600; also holds the RPC URL and the optional NTFY_TOPIC). This installer never turns
# live hedging on: `demo/polygon.sh hedge-live on` does, and that is the operator's call.
# Never run two keepers on the same key (nonce collisions): stop any local keeper first.
set -euo pipefail
host=${1:?usage: [NET=amoy|polygon] install-keeper-service.sh <ssh-host>}
root=$(cd "$(dirname "$0")/.." && pwd)
BUN_VERSION=bun-v1.4.4
NET=${NET:-amoy}
case "$NET" in
  amoy)
    unit=phoebe-keeper; app=/opt/phoebe/app; keyfile=/etc/phoebe/keeper.key
    desc="Phoebe keeper (Amoy): Polymarket prices -> oracle, market making, liquidations"
    run_args="live --interval 60 --min-move 0.003 --heartbeat 3300"
    env_line="Environment=RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com"
    ;;
  polygon)
    : "${POLYGON_RPC:?set POLYGON_RPC (an RPC with archive access; stored root-only on the host)}"
    unit=phoebe-keeper-polygon; app=/opt/phoebe/app-polygon; keyfile=/etc/phoebe/polygon-keeper.key
    desc="Phoebe keeper (Polygon mainnet): oracle, liquidations, settlement, hedger"
    run_args="live --interval 15 --min-move 0.002 --heartbeat 300"
    env_line="EnvironmentFile=/etc/phoebe/polygon.env"
    ;;
  *) echo "NET must be amoy or polygon"; exit 1 ;;
esac
[ -f "$root/deployments/$NET.json" ] || { echo "no deployments/$NET.json"; exit 1; }
[ -f ~/.phoebe/$NET-keeper.key ] || { echo "no ~/.phoebe/$NET-keeper.key"; exit 1; }

bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
mkdir -p "$bundle/keeper" "$bundle/deployments"
cp -r "$root/keeper/src" "$root/keeper/package.json" "$root/keeper/bun.lock" "$bundle/keeper/"
for c in PositionManager KeeperOracle RiskEngine LendingPool MockVenue MockUSDC MockCTF KeeperVenue; do
  mkdir -p "$bundle/contracts/out/$c.sol"
  cp "$root/contracts/out/$c.sol/$c.json" "$bundle/contracts/out/$c.sol/"
done
cp "$root/deployments/$NET.json" "$bundle/deployments/"

ssh -o BatchMode=yes "$host" "set -e
  mkdir -p /opt/phoebe/bin $app
  if [ \"\$(/opt/phoebe/bin/bun --version 2>/dev/null)\" != \"${BUN_VERSION#bun-v}\" ]; then
    cd /tmp && F=bun-linux-x64.zip
    curl -fsSLO https://github.com/oven-sh/bun/releases/download/$BUN_VERSION/\$F
    curl -fsSLO https://github.com/oven-sh/bun/releases/download/$BUN_VERSION/SHASUMS256.txt
    grep \" \$F\\\$\" SHASUMS256.txt | sha256sum -c -
    unzip -oq \$F && install -m 755 bun-linux-x64/bun /opt/phoebe/bin/bun && rm -rf bun-linux-x64 \$F SHASUMS256.txt
  fi"
# --chmod/--chown: the bundle dir is mode 700 locally; the service user must be able to read it
rsync -a --delete --chown=root:root --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$bundle/" "$host:$app/"
ssh -o BatchMode=yes "$host" "cd $app/keeper && /opt/phoebe/bin/bun install --frozen-lockfile --production >/dev/null"
ssh -o BatchMode=yes "$host" "umask 077; mkdir -p /etc/phoebe; cat > $keyfile" < ~/.phoebe/$NET-keeper.key

if [ "$NET" = polygon ]; then
  # (re)write the RPC; keep an existing HEDGE_LIVE / NTFY_TOPIC, defaulting HEDGE_LIVE to off
  ssh -o BatchMode=yes "$host" "set -e; umask 077; touch /etc/phoebe/polygon.env
    sed -i '/^RPC_URL=/d' /etc/phoebe/polygon.env
    grep -q '^HEDGE_LIVE=' /etc/phoebe/polygon.env || echo 'HEDGE_LIVE=0' >> /etc/phoebe/polygon.env
    cat >> /etc/phoebe/polygon.env" <<<"RPC_URL=$POLYGON_RPC"
fi

# Unquoted heredoc: $unit etc. expand here; \$\$ leaves systemd's literal $$ (escaped $) in the unit.
ssh -o BatchMode=yes "$host" "cat > /etc/systemd/system/$unit.service" <<UNIT
[Unit]
Description=$desc
After=network-online.target
Wants=network-online.target

[Service]
DynamicUser=yes
StateDirectory=$unit
Environment=HOME=/var/lib/$unit
Environment=DEPLOYMENT=$NET
$env_line
LoadCredential=keeper.key:$keyfile
WorkingDirectory=$app
ExecStart=/bin/sh -c 'KEEPER_PK=\$\$(cat "\$\${CREDENTIALS_DIRECTORY}/keeper.key") exec /opt/phoebe/bin/bun $app/keeper/src/main.ts $run_args'
Restart=always
RestartSec=20
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
ssh -o BatchMode=yes "$host" "systemctl daemon-reload && systemctl enable $unit.service >/dev/null && systemctl restart $unit.service && sleep 20 && systemctl is-active $unit.service && journalctl -u $unit -n 5 -o cat"
