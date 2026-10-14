#!/usr/bin/env bash
# Control-flow tests for oci-launch.sh with a fake `oci` (no Oracle account needed).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); script="$here/../oci-launch.sh"
pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass+1)); }
bad() { echo "  ✗ $1"; fail=$((fail+1)); }
setup() {
  T=$(mktemp -d); export HOME="$T/home" FAKE_STATE="$T/state" OCI_TENANCY=ocid1.tenancy.fake
  mkdir -p "$HOME" "$FAKE_STATE"; echo fakezip >"$T/stack.zip"
  export PATH="$here/bin:$PATH" EMBIFIED_STACK_ZIP_URL="file://$T/stack.zip" EMBIFIED_POLL_SECONDS=0 EMBIFIED_COMPARTMENT_SETTLE=0
}
run() { bash "$script" "$@" >"$T/out" 2>&1; }

echo "dry-run"; setup; FAKE_SCENARIO=ok run --dry-run && ok "exits 0" || bad "exit"
grep -q 'DRY RUN' "$T/out" && ok "says DRY RUN" || bad "banner"
! grep -qE 'create|update|create-apply-job' "$FAKE_STATE/calls" && ok "no write calls" || bad "write calls made"
[[ ! -e "$HOME/embified-vault.txt" && ! -e "$HOME/.ssh/embified_ed25519" ]] && ok "no files written" || bad "files written"

echo "success path (A1)"; setup; FAKE_SCENARIO=ok run && ok "exits 0" || { bad "exit"; cat "$T/out"; }
[[ $(jq -r .shape "$FAKE_STATE/vars.json") == VM.Standard.A1.Flex ]] && ok "A1 used" || bad "shape"
grep -q 'https://fake-vault.trycloudflare.com' "$HOME/embified-vault.txt" && ok "vault URL saved" || bad "url file"
pw=$(cat "$HOME/.embified/inbox-password"); [[ ${#pw} -eq 24 ]] && ok "24-char password" || bad "password"
[[ $(grep -c "$pw" "$T/out") -eq 1 ]] && ok "password printed exactly once" || bad "password echo count"
[[ $(stat -c %a "$HOME/embified-vault.txt") == 600 ]] && ok "vault file is 0600" || bad "perms"
[[ -f "$HOME/.ssh/embified_ed25519.pub" ]] && ok "ssh key created" || bad "ssh key"

echo "re-run is idempotent"; jobs_before=$(cat "$FAKE_STATE/jobs"); FAKE_SCENARIO=ok run && ok "exits 0" || bad "exit"
[[ $(cat "$FAKE_STATE/jobs") == "$jobs_before" ]] && ok "no new apply job" || bad "new job"
[[ $(grep -c 'compartment create' "$FAKE_STATE/calls") -eq 1 && $(grep -c 'stack create' "$FAKE_STATE/calls") -eq 1 ]] && ok "compartment/stack reused" || bad "duplicates"
[[ $(cat "$HOME/.embified/inbox-password") == "$pw" ]] && ok "same password" || bad "password changed"

echo "re-run from fresh Cloud Shell home reuses stack password"; rm -rf "$HOME/.embified"; FAKE_SCENARIO=ok run >/dev/null || true
[[ $(cat "$HOME/.embified/inbox-password") == "$pw" ]] && ok "password recovered from stack" || bad "password not recovered"

echo "A1 out of capacity → E2.1.Micro"; setup; FAKE_SCENARIO=a1-capacity run && ok "exits 0" || { bad "exit"; cat "$T/out"; }
[[ $(jq -r .shape "$FAKE_STATE/vars.json") == VM.Standard.E2.1.Micro ]] && ok "fell back to E2.1.Micro" || bad "no fallback"
grep -q 'out of free VM.Standard.A1.Flex capacity' "$T/out" && ok "explains fallback" || bad "message"

echo "no capacity anywhere"; setup; FAKE_SCENARIO=all-capacity run && bad "should fail" || ok "exits non-zero"
grep -q 'no free capacity' "$T/out" && ok "clear message" || bad "message"

echo "site copy"; cmp -s "$script" "$here/../../../site/install/oci-launch.sh" && ok "site/install copy identical" || bad "site/install/oci-launch.sh differs"

echo; echo "$pass passed, $fail failed"; [[ $fail -eq 0 ]]
