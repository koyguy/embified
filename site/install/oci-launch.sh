#!/usr/bin/env bash
# Embified — one-command vault launcher for Oracle Cloud Shell.
#
#   bash <(curl -fsSL https://koyguy.github.io/embified/install/oci-launch.sh)
#   bash <(curl -fsSL https://koyguy.github.io/embified/install/oci-launch.sh) --dry-run
#
# Runs entirely inside YOUR tenancy with Cloud Shell's built-in, already-signed-in
# `oci` CLI. No API keys or credentials are created, and nothing is sent to Embified.
# Safe to re-run: it reuses the "embified" compartment, the stack and the saved password.
#
# Source of truth: scripts/oci-cloudshell/oci-launch.sh (copied to site/install/).
set -euo pipefail

STACK_ZIP_URL="${EMBIFIED_STACK_ZIP_URL:-https://github.com/koyguy/embified/releases/download/orm-stack/embified-oci-stack.zip}"
COMPARTMENT_NAME="${EMBIFIED_COMPARTMENT:-embified}"
STACK_NAME="${EMBIFIED_STACK_NAME:-embified-vault}"
STATE_DIR="${EMBIFIED_STATE_DIR:-$HOME/.embified}"
OUT_FILE="${EMBIFIED_OUT_FILE:-$HOME/embified-vault.txt}"
HEALTH_TIMEOUT="${EMBIFIED_HEALTH_TIMEOUT:-900}"   # seconds (~15 min)
POLL="${EMBIFIED_POLL_SECONDS:-15}"
JOB_TIMEOUT="${EMBIFIED_JOB_TIMEOUT:-2400}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help) echo "Usage: oci-launch.sh [--dry-run]   (run inside Oracle Cloud Shell)"; exit 0 ;;
    *) echo "Unknown option: $arg (try --dry-run)" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
say()  { printf '%s▸%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
dry()  { [[ $DRY_RUN -eq 1 ]]; }

for bin in oci jq curl ssh-keygen; do
  command -v "$bin" >/dev/null 2>&1 || die "Missing '$bin'. Run this inside Oracle Cloud Shell (the >_ icon in the console)."
done

printf '\n%sEmbified vault launcher%s%s\n\n' "$B" "$N" "$( dry && echo ' — DRY RUN (nothing will be created)')"

# ---------- tenancy + home region ----------
TENANCY="${OCI_TENANCY:-}"
if [[ -z "$TENANCY" && -n "${OCI_CLI_CONFIG_FILE:-}" && -r "${OCI_CLI_CONFIG_FILE}" ]]; then
  TENANCY=$(awk -F= '/^[[:space:]]*tenancy[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}' "$OCI_CLI_CONFIG_FILE")
fi
[[ -n "$TENANCY" ]] || die "Couldn't detect your tenancy. Are you in Oracle Cloud Shell?"

HOME_REGION=$(oci iam region-subscription list --tenancy-id "$TENANCY" \
  --query 'data[?"is-home-region"] | [0]."region-name"' --raw-output 2>/dev/null || true)
[[ -n "$HOME_REGION" && "$HOME_REGION" != "null" ]] || die "Couldn't read your home region."
say "Home region: ${B}${HOME_REGION}${N} (Always Free only works here)"
O=(--region "$HOME_REGION")

# ---------- compartment ----------
COMP=$(oci "${O[@]}" iam compartment list --compartment-id "$TENANCY" --name "$COMPARTMENT_NAME" \
  --lifecycle-state ACTIVE --query 'data[0].id' --raw-output 2>/dev/null || true)
if [[ -n "$COMP" && "$COMP" != "null" ]]; then
  say "Reusing compartment '$COMPARTMENT_NAME'"
elif dry; then
  COMP="ocid1.compartment.dryrun"; say "[dry-run] would create compartment '$COMPARTMENT_NAME'"
else
  say "Creating compartment '$COMPARTMENT_NAME'…"
  COMP=$(oci "${O[@]}" iam compartment create --compartment-id "$TENANCY" --name "$COMPARTMENT_NAME" \
    --description "Embified WhatsApp vault" --wait-for-state ACTIVE --query 'data.id' --raw-output)
  sleep "${EMBIFIED_COMPARTMENT_SETTLE:-20}"  # new compartments take a moment to be usable everywhere
fi

# ---------- SSH key + password (kept in Cloud Shell, reused on re-run) ----------
mkdir -p "$STATE_DIR" "$HOME/.ssh"; chmod 700 "$STATE_DIR" "$HOME/.ssh"
KEY="$HOME/.ssh/embified_ed25519"
if [[ -f "$KEY.pub" ]]; then say "Reusing SSH key $KEY"
elif dry; then say "[dry-run] would create SSH key $KEY"
else ssh-keygen -q -t ed25519 -N '' -C embified-vault -f "$KEY"; say "Created SSH key $KEY"; fi
PUBKEY=$(cat "$KEY.pub" 2>/dev/null || echo "ssh-ed25519 DRYRUN embified-vault")

STACK=$(oci "${O[@]}" resource-manager stack list --compartment-id "$COMP" --display-name "$STACK_NAME" \
  --lifecycle-state ACTIVE --query 'data[0].id' --raw-output 2>/dev/null || true)
[[ "$STACK" == "null" ]] && STACK=""
[[ -n "$STACK" ]] && say "Reusing stack '$STACK_NAME'"

PASS_FILE="$STATE_DIR/inbox-password"
PASSWORD=""
if [[ -s "$PASS_FILE" ]]; then
  PASSWORD=$(cat "$PASS_FILE")
elif [[ -n "$STACK" ]]; then
  # Re-run from a fresh Cloud Shell: keep the password the vault was built with.
  PASSWORD=$(oci "${O[@]}" resource-manager stack get --stack-id "$STACK" \
    --query 'data.variables."embified_auth_password"' --raw-output 2>/dev/null || true)
  [[ "$PASSWORD" == "null" ]] && PASSWORD=""
fi
if [[ -z "$PASSWORD" ]]; then
  PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)
fi
[[ ${#PASSWORD} -ge 12 ]] || die "Couldn't generate an inbox password."
dry || { (umask 077; printf '%s' "$PASSWORD" >"$PASS_FILE"); }

# ---------- stack ----------
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
ZIP="$WORK/stack.zip"; VARS="$WORK/vars.json"

write_vars() {  # $1 shape, $2 availability domain
  local ocpus=2 mem=12
  [[ "$1" == *Flex ]] || { ocpus=1; mem=1; }
  (umask 077; jq -n --arg c "$COMP" --arg r "$HOME_REGION" --arg k "$PUBKEY" --arg p "$PASSWORD" \
        --arg s "$1" --arg ad "$2" --arg o "$ocpus" --arg m "$mem" \
    '{compartment_ocid:$c, region:$r, ssh_public_key:$k, embified_auth_password:$p,
      shape:$s, availability_domain:$ad, ocpus:$o, memory_in_gbs:$m}' >"$VARS")
}

if dry; then
  say "[dry-run] would download $STACK_ZIP_URL"
else
  say "Downloading the Embified stack…"
  curl -fsSL "$STACK_ZIP_URL" -o "$ZIP" || die "Couldn't download the stack zip."
fi

mapfile -t ADS < <(oci "${O[@]}" iam availability-domain list --compartment-id "$TENANCY" \
  --query 'data[].name' 2>/dev/null | jq -r '.[]?' 2>/dev/null || true)
[[ ${#ADS[@]} -gt 0 ]] || ADS=("")

set_stack() {  # $1 shape, $2 AD
  write_vars "$1" "$2"
  if dry; then
    if [[ -n "$STACK" ]]; then say "[dry-run] would update stack '$STACK_NAME' (shape $1)"
    else say "[dry-run] would create stack '$STACK_NAME' (shape $1)"; STACK="ocid1.ormstack.dryrun"; fi
  elif [[ -n "$STACK" ]]; then
    oci "${O[@]}" resource-manager stack update --stack-id "$STACK" --config-source "$ZIP" \
      --variables "file://$VARS" --force >/dev/null
  else
    say "Creating Resource Manager stack '$STACK_NAME'…"
    STACK=$(oci "${O[@]}" resource-manager stack create --compartment-id "$COMP" --display-name "$STACK_NAME" \
      --description "Embified WhatsApp vault (Always Free)" --config-source "$ZIP" \
      --variables "file://$VARS" --query 'data.id' --raw-output)
  fi
}

# Returns 0 on success, 10 on "Out of host capacity", 1 on other failure.
run_apply() {
  if dry; then say "[dry-run] would run an apply job and wait for it"; return 0; fi
  local job state waited=0 logs
  job=$(oci "${O[@]}" resource-manager job create-apply-job --stack-id "$STACK" \
    --execution-plan-strategy AUTO_APPROVED --query 'data.id' --raw-output)
  printf '  building (takes 2–5 min) '
  while :; do
    state=$(oci "${O[@]}" resource-manager job get --job-id "$job" --query 'data."lifecycle-state"' --raw-output)
    case "$state" in
      SUCCEEDED) echo " done"; LAST_JOB="$job"; return 0 ;;
      FAILED|CANCELED) echo " $state"; break ;;
    esac
    (( waited >= JOB_TIMEOUT )) && { echo; die "Apply job is taking too long. Check Resource Manager → Stacks → $STACK_NAME."; }
    printf '.'; sleep "$POLL"; waited=$((waited + POLL))
  done
  logs=$(oci "${O[@]}" resource-manager job get-job-logs-content --job-id "$job" --query 'data' --raw-output 2>/dev/null || true)
  if grep -qiE 'out of host capacity|OutOfHostCapacity' <<<"$logs"; then return 10; fi
  if grep -qiE 'LimitExceeded|service limit' <<<"$logs"; then
    warn "Oracle says a free-tier limit is reached (maybe an existing free VM already uses it)."
  fi
  printf '%s\n' "$logs" | grep -iE 'error' | tail -n 8 >&2 || true
  return 1
}

already_built() {
  [[ -n "$STACK" && "$STACK" != *dryrun ]] || return 1
  local last
  # shellcheck disable=SC2016  # backticks are JMESPath literals, not shell
  last=$(oci "${O[@]}" resource-manager job list --stack-id "$STACK" --sort-by timeCreated --sort-order DESC \
    --query 'data[?operation==`APPLY`] | [0]' 2>/dev/null || true)
  [[ -n "$last" && "$last" != "null" ]] || return 1
  [[ $(jq -r '."lifecycle-state"' <<<"$last") == SUCCEEDED ]] || return 1
  LAST_JOB=$(jq -r '.id' <<<"$last")
}

LAST_JOB=""
if already_built; then
  say "Your vault is already built — skipping straight to the health check."
else
  launched=0
  for shape in VM.Standard.A1.Flex VM.Standard.E2.1.Micro; do
    for ad in "${ADS[@]}"; do
      say "Launching on ${B}${shape}${N}${ad:+ in ${ad##*:}}…"
      set_stack "$shape" "$ad"
      rc=0; run_apply || rc=$?
      if [[ $rc -eq 0 ]]; then launched=1; break 2; fi
      if [[ $rc -eq 10 ]]; then warn "Oracle is out of free $shape capacity${ad:+ in ${ad##*:}} — trying the next option."; continue; fi
      die "Launch failed. Fix the error above, then run the same command again (it resumes)."
    done
  done
  [[ $launched -eq 1 ]] || die "Oracle has no free capacity right now in $HOME_REGION. Wait an hour and run the same command again."
fi

# ---------- public IP ----------
if dry; then
  IP="203.0.113.10"; say "[dry-run] would read the vault IP from the stack outputs"
else
  IP=$(oci "${O[@]}" resource-manager job get-job-tf-state --job-id "$LAST_JOB" --file - 2>/dev/null \
        | jq -r '.outputs.public_ip.value // empty' 2>/dev/null || true)
  if [[ -z "$IP" ]]; then
    inst=$(oci "${O[@]}" compute instance list --compartment-id "$COMP" --display-name "$STACK_NAME" \
          --lifecycle-state RUNNING --query 'data[0].id' --raw-output 2>/dev/null || true)
    [[ -n "$inst" && "$inst" != "null" ]] && IP=$(oci "${O[@]}" compute instance list-vnics --instance-id "$inst" \
          --query 'data[0]."public-ip"' --raw-output 2>/dev/null || true)
  fi
  [[ -n "$IP" && "$IP" != "null" ]] || die "Couldn't find your vault's public IP. Run the command again in a minute."
fi
say "Vault IP: ${B}${IP}${N}"

# ---------- wait for the app + https tunnel ----------
URL=""
if dry; then
  URL="https://example-dry-run.trycloudflare.com"; say "[dry-run] would poll http://$IP/api/digest/health for publicUrl"
else
  printf '  installing Embified on your server (5–15 min) '
  waited=0; body=""
  while (( waited < HEALTH_TIMEOUT )); do
    body=$(curl -fsS -m 8 "http://$IP/api/digest/health" 2>/dev/null || true)
    URL=$(jq -r '.publicUrl // empty' <<<"$body" 2>/dev/null || true)
    [[ "$URL" == https://* ]] && break
    URL=""; printf '.'; sleep "$POLL"; waited=$((waited + POLL))
  done
  echo
  if [[ -z "$URL" ]]; then
    if [[ -n "$body" ]]; then warn "The vault is up but its https link isn't ready yet. Use http://$IP/ for now (it forwards to https once ready)."
    else warn "The server is still installing. Give it 10 more minutes, then run this same command again."; fi
    URL="http://$IP/"
  fi
fi

# ---------- result ----------
if ! dry; then
  (umask 077; cat >"$OUT_FILE" <<TXT
Embified vault ($(date -u +%Y-%m-%dT%H:%MZ))
Vault link:      $URL
Always works:    http://$IP/   (forwards to the current https link)
Inbox password:  $PASSWORD
SSH:             ssh -i $KEY ubuntu@$IP
TXT
  )
fi

line='════════════════════════════════════════════════════════════'
printf '\n%s%s%s\n' "$G" "$line" "$N"
printf '  %s🎉 Your Embified vault is ready%s\n\n' "$B" "$N"
printf '  Vault link:     %s%s%s\n' "$B" "$URL" "$N"
printf '  Backup link:    http://%s/\n' "$IP"
if dry; then printf '  Inbox password: (hidden in dry run)\n'; else printf '  Inbox password: %s%s%s\n' "$B" "$PASSWORD" "$N"; fi
printf '\n  %sSave both now%s (password manager or notes). Also saved in %s\n' "$Y" "$N" "$OUT_FILE"
printf '  Next: paste the vault link back into the Embified chat.\n'
printf '%s%s%s\n\n' "$G" "$line" "$N"
