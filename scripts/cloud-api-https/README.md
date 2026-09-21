# HTTPS for WhatsApp Cloud API

Meta only calls webhooks over **HTTPS**. An Always Free public IP on port 80 is not enough.

## Quick tunnel

```bash
sudo bash scripts/cloud-api-https/install-cloudflared.sh
sudo bash scripts/cloud-api-https/start-quick-tunnel.sh
```

Copy the printed `https://…trycloudflare.com` origin into the inbox **Official Cloud API** form → *Public HTTPS origin*.

Meta callback = `<origin>/api/whatsapp/webhook`.

Quick-tunnel hostnames change when the process restarts.

## Persistent tunnel

Create a named Cloudflare Tunnel pointed at `http://127.0.0.1:80`, then use that stable origin as `WEBHOOK_PUBLIC_URL`.

See the public guide at `/cloud-setup`.
