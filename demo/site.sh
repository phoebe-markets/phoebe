#!/usr/bin/env bash
# Build the static site (landing at /, app at /app/) and publish it to earth, which serves phoebe.markets via nginx
# (/etc/nginx/sites-available/phoebe, root /var/www/phoebe).
#
#   demo/site.sh            # build with Polygon mainnet as the default network, upload, swap in atomically
#   demo/site.sh tls        # one-time, once DNS points at earth: certbot for phoebe.markets + www
#
#   VITE_DEFAULT_NET   default network for visitors (polygon; ?net=amoy still works)
#   VITE_POLYGON_RPC   browser RPC for Polygon (default https://polygon.drpc.org)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
host=${SITE_HOST:-earth}

if [ "${1:-}" = tls ]; then
  # earth's certbot already has an ACME account (it manages the other sites' certs)
  ssh -o BatchMode=yes "$host" "certbot --nginx -n --redirect -d phoebe.markets -d www.phoebe.markets"
  exit 0
fi

(cd "$root/contracts" && forge build >/dev/null)
cd "$root/web"
VITE_DEFAULT_NET=${VITE_DEFAULT_NET:-polygon} VITE_POLYGON_RPC=${VITE_POLYGON_RPC:-https://polygon.drpc.org} npx vite build >/dev/null
[ -f dist/deployments/polygon.json ] || echo "warning: no deployments/polygon.json yet; the Polygon network won't load until demo/polygon.sh deploy"
stamp=$(date +%Y%m%d%H%M%S)
tar -C dist -czf - . | ssh -o BatchMode=yes "$host" "set -e; d=/var/www/phoebe-$stamp; mkdir -p \$d; tar -C \$d -xzf -; chmod -R a+rX \$d
  if [ -d /var/www/phoebe ] && [ ! -L /var/www/phoebe ]; then mv /var/www/phoebe /var/www/phoebe-old-$stamp; fi
  ln -sfn \$d /var/www/phoebe.tmp && mv -T /var/www/phoebe.tmp /var/www/phoebe
  ls -dt /var/www/phoebe-2* | tail -n +4 | xargs -r rm -r"
echo "published to $host:/var/www/phoebe ($stamp)"
