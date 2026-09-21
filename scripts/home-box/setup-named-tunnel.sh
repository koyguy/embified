#!/usr/bin/env bash
# Create/run a named Cloudflare Tunnel for a stable hostname.
# Usage: sudo bash setup-named-tunnel.sh vault.example.com
set -euo pipefail
HOSTNAME="${1:-}"
if [[ -z "$HOSTNAME" ]]; then
  echo "Usage: $0 <hostname>   e.g. vault.example.com"
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Install cloudflared first: sudo bash scripts/home-box/install-cloudflared.sh"
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)."
  exit 1
fi

TUNNEL_NAME="${EMBIFIED_TUNNEL_NAME:-embified}"
TARGET="${EMBIFIED_TUNNEL_TARGET:-http://127.0.0.1:80}"

echo "Logging into Cloudflare (browser)…"
cloudflared tunnel login

if ! cloudflared tunnel list 2>/dev/null | grep -qw "$TUNNEL_NAME"; then
  cloudflared tunnel create "$TUNNEL_NAME"
fi

cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || true

CONF_DIR=/etc/cloudflared
mkdir -p "$CONF_DIR"
CRED=$(ls /root/.cloudflared/*.json 2>/dev/null | head -1 || true)
if [[ -z "$CRED" ]]; then
  CRED=$(ls "$HOME/.cloudflared"/*.json 2>/dev/null | head -1 || true)
fi
# Prefer credentials matching tunnel id from list
TUNNEL_ID=$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$2==n || $1==n {print $1; exit}')
if [[ -n "${TUNNEL_ID:-}" && -f "/root/.cloudflared/${TUNNEL_ID}.json" ]]; then
  CRED="/root/.cloudflared/${TUNNEL_ID}.json"
fi
if [[ -z "${CRED:-}" || ! -f "$CRED" ]]; then
  echo "Could not find tunnel credentials JSON under ~/.cloudflared"
  exit 1
fi
cp "$CRED" "$CONF_DIR/credentials.json"
chmod 600 "$CONF_DIR/credentials.json"

cat > "$CONF_DIR/config.yml" <<YAML
tunnel: ${TUNNEL_ID:-$TUNNEL_NAME}
credentials-file: $CONF_DIR/credentials.json
ingress:
  - hostname: $HOSTNAME
    service: $TARGET
  - service: http_status:404
YAML

cloudflared service install || true
systemctl enable --now cloudflared
systemctl restart cloudflared

echo
echo "Tunnel should serve https://$HOSTNAME → $TARGET"
echo "Set vault password + open https://$HOSTNAME/login"
echo "For Cloud API: public HTTPS origin = https://$HOSTNAME"
