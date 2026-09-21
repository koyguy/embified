# Next-user onboarding — personal 200 GB WhatsApp group vault

Each user gets **their own** Oracle Always Free tenancy + VM + disk. Embified does **not** share one disk across users. This guide is what we run (or hand them) to initiate the same vault setup you have on `embified-free`.

## Product rule

| Concern | Model |
| --- | --- |
| Identity | 1 human → 1 Oracle Cloud Free Tier account → 1 home-region Always Free VM |
| WhatsApp | 1 linked number (Baileys) or Cloud API phone per vault |
| Data | Local only on that VM (`DATA_DIR` + `AUTH_DIR`) |
| Control plane (later) | Embified.com can help provision; it should not store their chat bytes |

Do **not** onboard a second person onto an existing public IP/inbox. Give them a fresh node.





## Control plane (browser)

On any running Embified node, open **`/create-vault`** for the guided flow:

1. Oracle Free Tier signup
2. Paste compartment OCID + SSH public key (browser-only; builds `terraform.tfvars`)
3. Zip `infra/oci-resource-manager/`, create an OCI Resource Manager stack, Apply
4. Set `EMBIFIED_AUTH_PASSWORD` before sharing the public IP

OAuth “Connect Oracle” is not available yet — OCIDs are pasted manually.

## Provision via Resource Manager

Preferred for a greenfield tenancy: use the Terraform stack in [`infra/oci-resource-manager/`](../infra/oci-resource-manager/).

1. Zip that folder and create an **OCI Resource Manager** stack (see the folder README).
2. Apply → note `public_ip`.
3. Wait for cloud-init, then set `EMBIFIED_AUTH_PASSWORD` in `/etc/embified/auth.env` **before** sharing the IP.
4. Open `/vault` (public) and `/login` (inbox). Link WhatsApp as usual.

Manual console steps below remain the fallback when ORM is unavailable.

## Prerequisites (user brings)

1. Email + phone for **Oracle Cloud Free Tier** signup: https://www.oracle.com/cloud/free/
2. WhatsApp on the phone they will archive (linked-device) **or** Cloud API credentials
3. Ability to complete Oracle email verify + payment-method verification (Always Free still needs a card on file in most regions; they are not charged if they stay in free limits)

## Phase A — Oracle tenancy (user or assisted)

1. Sign up Free Tier; pick **home region** carefully (Always Free compute is home-region only). Prefer a region with A1/Micro capacity (e.g. `ap-hyderabad-1` when available).
2. Wait until **Pay As You Go / Always Free** account is active (not stuck in verifying).
3. In Compute → Instances → **Create instance**:
   - Name: `embified-vault` (or `embified-<handle>`)
   - Image: Ubuntu 22.04+
   - Shape: Always Free — `VM.Standard.E2.1.Micro` **or** `VM.Standard.A1.Flex` within free OCPU/RAM (≤2 OCPU / 12 GB tenancy-wide after mid-2026 limits)
   - Networking: public subnet + assign public IP
   - SSH key: paste a new ed25519 public key (save the private key; embified ops will need it for first deploy)
4. Confirm instance **Running** and note public IP.

### Storage layout (do this at day 0)

Always Free allowance: **200 GB** block+boot combined per tenancy.

1. Leave boot at default **~47–50 GB**.
2. Block Storage → Create Block Volume `embified-data`, size **~150 GB**, same AD as the instance, Always Free eligible.
3. Attach to the instance (paravirtualized).
4. After OS access:

```bash
sudo CONFIRM=yes bash scripts/oci-always-free/mount-data-volume.sh
# expects mount at /data with /data/store and /data/auth
```

## Phase B — Install embified on their VM

From a machine that has the private SSH key:

```bash
ssh -i ~/.ssh/<their-key> ubuntu@<PUBLIC_IP>

# on VM
sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo mkdir -p /opt/embified
sudo git clone https://github.com/koyguy/embified.git /opt/embified
cd /opt/embified
sudo npm ci
sudo npm run build

# vault paths on the attached volume
sudo mkdir -p /data/store /data/auth_info

sudo tee /etc/systemd/system/embified.service >/dev/null <<'UNIT'
[Unit]
Description=Embified WhatsApp vault
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/embified
Environment=NODE_ENV=production
Environment=PORT=80
Environment=WA_PROVIDER=baileys
Environment=AUTH_DIR=/data/auth_info
Environment=DATA_DIR=/data/store
Environment=EMBIFIED_QUOTA_BYTES=214748364800
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now embified
curl -sS http://127.0.0.1/api/disk
```

Open `http://<PUBLIC_IP>/vault` — meter should show quota 200 GB and large free space on `/data`.

### Firewall

OCI Network Security Group / subnet security list: allow **TCP 22** (admin) and **TCP 80** (inbox). Prefer locking UI to VPN/SSH-tunnel until auth exists.

## Phase C — Link WhatsApp

1. Open `http://<PUBLIC_IP>/` → Linked device.
2. Scan QR (second screen / other device — phone camera cannot scan itself).
3. Confirm `/api/status` shows connected; new group messages appear after link (no full history backfill).

## Phase D — Wire vibe deploy (optional but recommended)

So embified bot / GitHub can update their node without Cloud Shell:

1. Keep their SSH private key in a password manager.
2. On the VM, install the update script:

```bash
sudo tee /usr/local/bin/embified-update >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/embified
git config --global --add safe.directory /opt/embified || true
git fetch origin main
git reset --hard origin/main
npm ci
npm run build
systemctl restart embified
sleep 4
systemctl is-active embified
curl -sS -m 8 http://127.0.0.1/api/disk | head -c 400; echo
SCRIPT
sudo chmod +x /usr/local/bin/embified-update
```

3. For multi-tenant ops later: store `host + ubuntu + private key` per customer in secrets; run `sudo embified-update` over SSH after merges. Do **not** point every customer at one shared GitHub deploy secret.

## Acceptance checklist (new user live)

- [ ] Instance Always Free shape, Running
- [ ] Boot + data volume ≤ 200 GB; `/data` mounted; `df -h /data` shows ~150 GB class size
- [ ] `curl -s http://IP/api/disk` → JSON, `ok: true`, quota ~200 GB
- [ ] `http://IP/vault` loads landing + meter
- [ ] WhatsApp connected; at least one group receiving
- [ ] Auth + store only under `/data/...` (not boot-only)
- [ ] SSH key backed up; `embified-update` works
- [ ] User understands: sharing their IP shares **their** inbox until auth is added

## What embified (company) must still build

1. **Auth wall** on the inbox (magic link / password) before public IPs are shared.
2. **Provisioner** — Terraform/OCI Resource Manager stack: VM + 150 GB volume + cloud-init installs embified.
3. **Control plane** — “Create vault” → Oracle signup → paste tenancy + SSH key (or OAuth when available).
4. **Idle reclaim shield** — digest ping / docs so Always Free VMs are not reaped.
5. **Official Cloud API path** for users who cannot accept Baileys risk.

Until those exist, onboard the next user **manually with this doc** — one tenancy, one vault, one WhatsApp.
