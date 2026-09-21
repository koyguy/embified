#!/usr/bin/env bash
# Ephemeral HTTPS for home Embified (URL changes when this process exits).
set -euo pipefail
TARGET="${EMBIFIED_TUNNEL_TARGET:-http://127.0.0.1:80}"
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Run: sudo bash scripts/home-box/install-cloudflared.sh"
  exit 1
fi
echo "Quick tunnel → $TARGET"
echo "Copy https://*.trycloudflare.com into Cloud API “Public HTTPS origin” if needed."
exec cloudflared tunnel --url "$TARGET" --no-autoupdate
