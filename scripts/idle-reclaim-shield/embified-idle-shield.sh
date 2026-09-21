#!/usr/bin/env bash
# Light heartbeat against local Embified + tiny egress so Always Free VMs look alive.
set -euo pipefail

BASE_URL="${EMBIFIED_SHIELD_URL:-http://127.0.0.1}"
OUTBOUND_URL="${EMBIFIED_SHIELD_OUTBOUND:-https://cloud.oracle.com/}"
TIMEOUT_SECS="${EMBIFIED_SHIELD_TIMEOUT:-20}"
STAMP_DIR="${EMBIFIED_SHIELD_STAMP_DIR:-/var/lib/embified}"
STAMP_FILE="$STAMP_DIR/idle-shield-last.json"

log() { echo "[embified-idle-shield] $*"; }

mkdir -p "$STAMP_DIR"

local_ok=0
outbound_ok=0
local_code="000"
outbound_code="000"

if local_code=$(curl -sS -o /tmp/embified-shield-digest.json -w '%{http_code}' \
    --connect-timeout "$TIMEOUT_SECS" --max-time "$TIMEOUT_SECS" \
    "$BASE_URL/api/digest"); then
  if [[ "$local_code" == "200" ]]; then
    local_ok=1
  else
    # Auth wall may 401 digest; health is enough for liveness.
    local_code=$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout "$TIMEOUT_SECS" --max-time "$TIMEOUT_SECS" \
      "$BASE_URL/health" || true)
    [[ "$local_code" == "200" ]] && local_ok=1
  fi
else
  local_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout "$TIMEOUT_SECS" --max-time "$TIMEOUT_SECS" \
    "$BASE_URL/health" || echo "000")
  [[ "$local_code" == "200" ]] && local_ok=1
fi

if outbound_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout "$TIMEOUT_SECS" --max-time "$TIMEOUT_SECS" \
    -A "embified-idle-shield/1.0" "$OUTBOUND_URL"); then
  # Any HTTP response counts as egress (3xx included).
  if [[ "$outbound_code" =~ ^[123][0-9][0-9]$ ]]; then
    outbound_ok=1
  fi
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$STAMP_FILE" <<JSON
{"ts":"$ts","local_ok":$local_ok,"local_code":"$local_code","outbound_ok":$outbound_ok,"outbound_code":"$outbound_code"}
JSON

log "ts=$ts local=$local_ok/$local_code outbound=$outbound_ok/$outbound_code"

if [[ "$local_ok" -ne 1 ]]; then
  log "ERROR: local embified not healthy"
  exit 1
fi
exit 0
