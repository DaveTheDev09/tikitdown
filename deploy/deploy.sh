#!/usr/bin/env bash
# DownTik v2 one-shot deployment — Ubuntu 22.04/24.04
# Prerequisite: app files uploaded to /opt/tikv2 (see upload instructions below)
# Usage: sudo bash deploy.sh yourdomain.com

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/tikv2

if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash deploy.sh <your-domain.com>"
  exit 1
fi

echo "== 1/5: system packages (node, ffmpeg, caddy) =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
if ! command -v ffmpeg >/dev/null; then
  apt-get install -y -qq ffmpeg
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/deb.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "== 2/5: app dependencies =="
cd "$APP_DIR"
if [ ! -f package.json ]; then
  echo "ERROR: $APP_DIR/package.json not found — upload the v2 folder to /opt/tikv2 first"
  exit 1
fi
npm install --omit=dev

echo "== 2b/5: substitute real domain into static assets =="
# All HTML pages ship with downtik.example placeholders (share links, mailto).
find . -maxdepth 3 -name '*.html' -print0 | while IFS= read -r -d '' f; do
  sed -i "s|downtik\.example|$DOMAIN|g" "$f"
done

echo "== 3/5: systemd service =="
cp -f deploy/tikv2.service /etc/systemd/system/tikv2.service
systemctl daemon-reload
systemctl enable --now tikv2
sleep 1
systemctl --no-pager status tikv2 --lines=0 || true

echo "== 4/5: Caddy (auto HTTPS) =="
printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl restart caddy
sleep 2
systemctl --no-pager status caddy --lines=0 || true

echo "== 5/5: firewall =="
if command -v ufw >/dev/null; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

echo ""
echo "DONE. Live at: https://$DOMAIN"
echo "Verify with: curl -s -o /dev/null -w '%{http_code}' https://$DOMAIN/"
echo "App log with: journalctl -u tikv2 -f"