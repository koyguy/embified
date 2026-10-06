#!/usr/bin/env bash
# Run a Cloudflare quick tunnel to the local inbox and publish its https origin.
# Installed as /usr/local/sbin/embified-tunnel-run by install-tunnel-service.sh.
set -uo pipefail
TARGET="${EMBIFIED_TUNNEL_TARGET:-http://127.0.0.1:80}"
URL_FILE="${EMBIFIED_TUNNEL_URL_FILE:-/var/lib/embified/tunnel-url.txt}"
mkdir -p "$(dirname "$URL_FILE")"
# Old quick-tunnel URLs die with their process; never redirect to a stale one.
rm -f "$URL_FILE"

cloudflared tunnel --no-autoupdate --url "$TARGET" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    url="${BASH_REMATCH[1]}"
    [[ "$url" == "https://api.trycloudflare.com" ]] && continue
    if [[ "$(cat "$URL_FILE" 2>/dev/null)" != "$url" ]]; then
      printf '%s\n' "$url" >"$URL_FILE.tmp" && chmod 644 "$URL_FILE.tmp" && mv -f "$URL_FILE.tmp" "$URL_FILE"
      echo "embified-tunnel: public URL $url (written to $URL_FILE)"
    fi
  fi
done
exit "${PIPESTATUS[0]}"
