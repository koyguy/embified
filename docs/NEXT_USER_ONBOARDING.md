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











## Home box + Cloudflare Tunnel

Run Embified on your own always-on machine (NUC, Pi + SSD, old laptop that never sleeps):

1. Open the **[home box guide](https://koyguy.github.io/embified/home-setup.html)** (or `scripts/home-box/README.md`).
2. `sudo bash scripts/home-box/install-embified.sh` then `disable-sleep.sh`.
3. Named tunnel: `sudo bash scripts/home-box/setup-named-tunnel.sh vault.example.com`.
4. Login at `https://vault.example.com` — Baileys QR and/or Cloud API using that origin.

No Oracle reclaim risk; you own power, disk, and backups.

## Official Cloud API (no Baileys)

If you will not run an unofficial linked-device client:

1. Open the **[Cloud API guide](https://koyguy.github.io/embified/cloud-setup.html)** (public site).
2. Put HTTPS in front of the VM (`scripts/cloud-api-https/` — Cloudflare Tunnel).
3. In the inbox, switch to **Official Cloud API**, paste token + phone number ID + public HTTPS origin.
4. Configure Meta’s webhook to the shown callback URL and verify token.

1:1 chats work on a standard Cloud API number. Official groups need OBA / Groups API eligibility.

## HTTPS inbox (Cloudflare quick tunnel)

Every vault gets free HTTPS so the inbox password never crosses the internet as plain http. No domain or Cloudflare account needed. Resource Manager cloud-init installs it; on an older vault run:

```bash
sudo bash /opt/embified/scripts/cloud-api-https/install-tunnel-service.sh
cat /var/lib/embified/tunnel-url.txt          # https://<random>.trycloudflare.com
```

- `embified-tunnel.service` runs `cloudflared` (about 20 MB RAM, `Restart=always`) against `http://127.0.0.1:80` and writes the assigned URL to `/var/lib/embified/tunnel-url.txt`. `GET /api/digest/health` shows it as `publicUrl`.
- Give the user **`http://<PUBLIC_IP>/`**: it 302s to the same path on the current https URL. `/health`, `/api/digest/health`, the webhook and the marketing 301s stay on http.
- Session cookies set over the tunnel carry `Secure`.
- **Caveat:** the `trycloudflare.com` URL changes whenever cloudflared restarts or the VM reboots. The IP keeps forwarding to the current one, so bookmark the IP, not the tunnel URL.
- **Upgrade when there is a domain:** named tunnel (`scripts/home-box/setup-named-tunnel.sh vault.example.com`) + `EMBIFIED_PUBLIC_URL=https://vault.example.com` on `embified.service`, then `systemctl disable --now embified-tunnel`. Steps: [`scripts/cloud-api-https/README.md`](../scripts/cloud-api-https/README.md#upgrade-to-a-named-tunnel-stable-url-needs-a-domain-on-cloudflare).

## Idle reclaim shield (Always Free)

Oracle may reclaim Always Free VMs that look idle. After the vault is up:

```bash
sudo bash /opt/embified/scripts/idle-reclaim-shield/install.sh
```

Resource Manager cloud-init installs this automatically. Confirm with `systemctl list-timers | grep embified-idle` and `cat /var/lib/embified/idle-shield-last.json`.

See [`scripts/idle-reclaim-shield/README.md`](../scripts/idle-reclaim-shield/README.md).

## Customer onboarding funnel — https://koyguy.github.io/embified/ (send new users here)

Public, mobile-first, gamified quest that takes a new customer from zero to a running vault. Share **<https://koyguy.github.io/embified/>** — a static site on GitHub Pages (HTTPS), built from [`site/`](../site/) by `.github/workflows/pages.yml`. Invite links use `SITE_URL` from [`site/config.js`](../site/config.js). Old vault links (`http://<vault>/start?ref=…`, `/vault`, `/create-vault`, `/cloud-setup`, `/home-setup`) 301 to the site (`PUBLIC_SITE_URL` env, default `https://koyguy.github.io/embified`). Hosting details, custom domain and analytics: [`PUBLIC_SITE.md`](PUBLIC_SITE.md).

| Level | What the user does | XP |
| --- | --- | --- |
| 1 | Create Oracle account on Oracle’s site (`signup.cloud.oracle.com`), pick home region | 100 |
| 2 | Card verification on Oracle’s page — honest explainer (≈US$1 temporary auth, reversed; Always Free not charged) + India/decline troubleshooting | 150 |
| 3 | Sign in to `cloud.oracle.com` | 50 |
| 4 | Paste root compartment (= tenancy) OCID | 100 |
| 5 | SSH key — generated in-browser (Ed25519 via WebCrypto, tweetnacl fallback on plain http; RSA-3072 fallback) or pasted | 100 |
| 6 | **Deploy to Oracle Cloud** (Resource Manager `stacks/create?zipUrl=…&zipUrlVariables=…` pre-filled with region/compartment/SSH key), paste `public_ip` | 250 |
| 7 | Set `EMBIFIED_AUTH_PASSWORD` (generated commands) + link WhatsApp via QR | 250 |

- Embified never automates Oracle signup or touches card data — Oracle does verification on its own page.
- Progress, XP, badges and referral code live in `localStorage` (`embified.start.v1`). `?ref=<code>` is captured and gives +50 XP.
- Stack zip for the deploy button: `https://github.com/koyguy/embified/releases/download/orm-stack/embified-oci-stack.zip`, republished by `.github/workflows/publish-orm-stack.yml` whenever `infra/oci-resource-manager/` changes.
- Anonymous analytics are **off** by default (static hosting can’t store events, and strangers no longer reach the vault). Set `ANALYTICS_URL` in `site/config.js` to any HTTPS collector that accepts CORS JSON POSTs (`event`, `cid`, `level`, `ref`). The vault’s old collector (`POST /api/funnel/event` → `DATA_DIR/funnel-events.jsonl`, `GET /api/funnel/stats`) is still in the code but behind the auth wall.
- Alternatives remain: [home box](https://koyguy.github.io/embified/home-setup.html), [Cloud API](https://koyguy.github.io/embified/cloud-setup.html), [classic wizard](https://koyguy.github.io/embified/create-vault.html).

## Control plane (browser)

Open the **[guided quest](https://koyguy.github.io/embified/)** (above) or the **[classic wizard](https://koyguy.github.io/embified/create-vault.html)**:

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
4. Open `http://<public_ip>/login`; once the tunnel is up it forwards to the HTTPS `trycloudflare.com` URL (see [HTTPS inbox](#https-inbox-cloudflare-quick-tunnel)). Link WhatsApp as usual.

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

Sign in at `http://<PUBLIC_IP>/login` — the sidebar meter (or `/api/disk`) should show quota 200 GB and large free space on `/data`.

### Firewall

OCI Network Security Group / subnet security list: allow **TCP 22** (admin) and **TCP 80** (inbox; with the HTTPS tunnel it only forwards browsers to the https URL and serves monitors). The tunnel itself is outbound-only, so no extra port. Prefer locking UI to VPN/SSH-tunnel until auth exists.

For HTTPS on a manually installed vault, run `sudo bash /opt/embified/scripts/cloud-api-https/install-tunnel-service.sh` (see [HTTPS inbox](#https-inbox-cloudflare-quick-tunnel)).

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
- [ ] `http://IP/login` 302s to `https://….trycloudflare.com/login`, which loads over TLS; inbox sidebar shows the disk meter
- [ ] `curl -s http://IP/api/digest/health` shows `publicUrl`; login cookie over https has `Secure`
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
