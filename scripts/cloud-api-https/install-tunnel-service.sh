#!/usr/bin/env bash
# Install cloudflared + embified-tunnel.service: free HTTPS for the inbox via a Cloudflare
# quick tunnel (https://*.trycloudflare.com, no Cloudflare account or domain needed).
# Idempotent; does not restart a running tunnel (that would change its URL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
URL_FILE=/var/lib/embified/tunnel-url.txt
if [[ $EUID -ne 0 ]]; then echo "Run with sudo"; exit 1; fi
bash "$ROOT/install-cloudflared.sh"
install -m 0755 "$ROOT/embified-tunnel-run.sh" /usr/local/sbin/embified-tunnel-run
install -m 0644 "$ROOT/embified-tunnel.service" /etc/systemd/system/embified-tunnel.service
install -d -m 0755 /var/lib/embified
systemctl daemon-reload
systemctl enable --now embified-tunnel.service
for _ in $(seq 1 45); do
  [[ -s "$URL_FILE" ]] && break
  sleep 1
done
if [[ -s "$URL_FILE" ]]; then
  echo "HTTPS inbox: $(cat "$URL_FILE")/login"
  echo "http://<public-ip>/ now forwards there. The URL changes when the tunnel restarts."
else
  echo "Tunnel URL not ready yet. Check: journalctl -u embified-tunnel -n 50 --no-pager"
fi
