#!/usr/bin/env bash
set -euo pipefail
if command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared already installed: $(cloudflared --version 2>&1 | head -1)"
  exit 0
fi
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) PKG_ARCH=amd64 ;;
  aarch64|arm64) PKG_ARCH=arm64 ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac
TMP=$(mktemp -d)
cd "$TMP"
curl -fsSL -o cloudflared.deb \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${PKG_ARCH}.deb"
sudo dpkg -i cloudflared.deb
cloudflared --version
echo "Installed. Next: sudo bash scripts/cloud-api-https/start-quick-tunnel.sh"
