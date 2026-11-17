#!/usr/bin/env bash
# Install / update the Amoy keeper as a systemd service on a remote host (Debian/systemd, root SSH).
#
#   demo/install-keeper-service.sh earth          # ship bundle, install Bun (pinned + checksum), unit, restart
#   ssh earth journalctl -fu phoebe-keeper        # follow logs
#
# Ships only what the keeper needs: keeper/, the ABIs it reads from contracts/out, deployments/amoy.json.
# The key (~/.phoebe/amoy-keeper.key) goes to /etc/phoebe/keeper.key (root 600) and reaches the service via
# systemd LoadCredential; the service runs as an ephemeral DynamicUser with a read-only filesystem.
# Never run two keepers on the same key (nonce collisions): stop any local `demo/amoy.sh keeper` first.
set -euo pipefail
host=${1:?usage: install-keeper-service.sh <ssh-host>}
root=$(cd "$(dirname "$0")/.." && pwd)
BUN_VERSION=bun-v1.4.4

bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
mkdir -p "$bundle/keeper" "$bundle/deployments"
cp -r "$root/keeper/src" "$root/keeper/package.json" "$root/keeper/bun.lock" "$bundle/keeper/"
for c in PositionManager KeeperOracle RiskEngine LendingPool MockVenue MockUSDC MockCTF KeeperVenue; do
  mkdir -p "$bundle/contracts/out/$c.sol"
  cp "$root/contracts/out/$c.sol/$c.json" "$bundle/contracts/out/$c.sol/"
done
cp "$root/deployments/amoy.json" "$bundle/deployments/"

ssh -o BatchMode=yes "$host" "set -e
  mkdir -p /opt/phoebe/bin /opt/phoebe/app
  if [ \"\$(/opt/phoebe/bin/bun --version 2>/dev/null)\" != \"${BUN_VERSION#bun-v}\" ]; then
    cd /tmp && F=bun-linux-x64.zip
    curl -fsSLO https://github.com/oven-sh/bun/releases/download/$BUN_VERSION/\$F
    curl -fsSLO https://github.com/oven-sh/bun/releases/download/$BUN_VERSION/SHASUMS256.txt
    grep \" \$F\\\$\" SHASUMS256.txt | sha256sum -c -
    unzip -oq \$F && install -m 755 bun-linux-x64/bun /opt/phoebe/bin/bun && rm -rf bun-linux-x64 \$F SHASUMS256.txt
  fi"
# --chmod/--chown: the bundle dir is mode 700 locally; the service user must be able to read it
rsync -a --delete --chown=root:root --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$bundle/" "$host:/opt/phoebe/app/"
ssh -o BatchMode=yes "$host" 'cd /opt/phoebe/app/keeper && /opt/phoebe/bin/bun install --frozen-lockfile --production >/dev/null'
ssh -o BatchMode=yes "$host" 'umask 077; mkdir -p /etc/phoebe; cat > /etc/phoebe/keeper.key' < ~/.phoebe/amoy-keeper.key

ssh -o BatchMode=yes "$host" 'cat > /etc/systemd/system/phoebe-keeper.service' <<'UNIT'
[Unit]
Description=Phoebe keeper (Amoy): Polymarket prices -> oracle, market making, liquidations
After=network-online.target
Wants=network-online.target

[Service]
DynamicUser=yes
StateDirectory=phoebe-keeper
Environment=HOME=/var/lib/phoebe-keeper
Environment=DEPLOYMENT=amoy
Environment=RPC_URL=https://polygon-amoy-bor-rpc.publicnode.com
LoadCredential=keeper.key:/etc/phoebe/keeper.key
WorkingDirectory=/opt/phoebe/app
ExecStart=/bin/sh -c 'KEEPER_PK=$$(cat "$${CREDENTIALS_DIRECTORY}/keeper.key") exec /opt/phoebe/bin/bun /opt/phoebe/app/keeper/src/main.ts live --interval 60 --min-move 0.003 --heartbeat 3300'
Restart=always
RestartSec=20
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
ssh -o BatchMode=yes "$host" 'systemctl daemon-reload && systemctl enable phoebe-keeper.service >/dev/null && systemctl restart phoebe-keeper.service && sleep 20 && systemctl is-active phoebe-keeper.service && journalctl -u phoebe-keeper -n 3 -o cat'
