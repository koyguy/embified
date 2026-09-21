#!/usr/bin/env bash
set -euo pipefail
TARGET="${EMBIFIED_TUNNEL_TARGET:-http://127.0.0.1:80}"
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared missing. Run: sudo bash scripts/cloud-api-https/install-cloudflared.sh"
  exit 1
fi
echo "Starting quick tunnel → $TARGET"
echo "Copy the https://*.trycloudflare.com origin into Embified Cloud API settings (no path)."
echo "Meta callback = <origin>/api/whatsapp/webhook"
exec cloudflared tunnel --url "$TARGET" --no-autoupdate
