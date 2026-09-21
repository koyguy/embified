# Home box + Cloudflare Tunnel

Run Embified on your own always-on machine. Tunnel provides public HTTPS without port-forwarding.

## Quick path

```bash
sudo bash scripts/home-box/install-embified.sh
sudo bash scripts/home-box/disable-sleep.sh
sudo bash scripts/home-box/install-cloudflared.sh
sudo bash scripts/home-box/setup-named-tunnel.sh vault.example.com
```

Open `https://vault.example.com/login`. For Cloud API webhooks, use origin `https://vault.example.com` (see `/cloud-setup`).

## Layout

| Path | Purpose |
| --- | --- |
| `/opt/embified` | App checkout |
| `/var/lib/embified/data` | Chats + media |
| `/var/lib/embified/auth` | Baileys session |
| `/etc/embified/auth.env` | Inbox password |

Public guide: `/home-setup`.
