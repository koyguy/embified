# Always Free idle-reclaim shield

Oracle can reclaim **idle** Always Free compute. This timer keeps a light heartbeat so a quiet Embified vault is less likely to look abandoned.

## What it does (every 6 hours)

1. `GET` local `/api/digest` (falls back to `/health` if auth returns 401)
2. Tiny outbound `GET` to `https://cloud.oracle.com/` (egress signal)
3. Writes `/var/lib/embified/idle-shield-last.json`

CPU and egress are negligible.

## Install on an existing vault

```bash
cd /opt/embified   # or your checkout
sudo bash scripts/idle-reclaim-shield/install.sh
```

## Verify

```bash
systemctl list-timers | grep embified-idle
journalctl -u embified-idle-shield -n 30 --no-pager
cat /var/lib/embified/idle-shield-last.json
```

## New vaults

`infra/oci-resource-manager` cloud-init installs and enables this timer automatically.

## Honest limits

This is not a guarantee — Oracle policy can change. Prefer occasional real inbox use, keep the instance running, and watch OCI email for reclaim notices.
