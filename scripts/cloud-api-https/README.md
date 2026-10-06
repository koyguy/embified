# HTTPS for the inbox (and WhatsApp Cloud API webhooks)

A vault on a bare public IP serves `http://<ip>/`, so the inbox password would cross the
internet in plain text. Meta also only calls webhooks over **HTTPS**. A free Cloudflare
**quick tunnel** fixes both without a domain or a Cloudflare account.

## Quick tunnel as a service (default on Oracle vaults)

```bash
sudo bash /opt/embified/scripts/cloud-api-https/install-tunnel-service.sh
```

This installs `cloudflared` (amd64/arm64 auto-detect) and `embified-tunnel.service`:

| Piece | What it does |
| --- | --- |
| `/etc/systemd/system/embified-tunnel.service` | `Restart=always`, `MemoryMax=200M`, sandboxed; target `http://127.0.0.1:80` |
| `/usr/local/sbin/embified-tunnel-run` | Runs `cloudflared tunnel --url …` and writes the assigned origin to the URL file |
| `/var/lib/embified/tunnel-url.txt` | Current `https://<random>.trycloudflare.com` (removed while the tunnel is down) |

The app reads that file (`EMBIFIED_TUNNEL_URL_FILE` overrides the path):

- Plain-http requests that reach the public IP (`/`, `/login`, the inbox, `/api/…`, `/auth/…`)
  get a 302 (307 for POST) to the **same path on the current https URL**. So
  `http://<public-ip>/` always forwards to wherever the tunnel lives now.
- Still served over http: `/health`, `/api/digest/health`, `/api/whatsapp/webhook`, `/public/*`
  and the marketing 301s (`/start`, `/vault`, …). Local `curl http://127.0.0.1/...` is never redirected.
- Express trusts `X-Forwarded-Proto` only from loopback (cloudflared), so tunnel requests are
  `req.secure` and the session cookie gets `Secure`; there is no redirect loop.
- `GET /api/digest/health` reports the URL as `publicUrl`.

Check it:

```bash
cat /var/lib/embified/tunnel-url.txt
journalctl -u embified-tunnel -n 30 --no-pager
curl -sI http://<public-ip>/login | grep -i location
```

**Caveat:** a quick-tunnel URL changes whenever cloudflared restarts or the VM reboots.
`http://<public-ip>/` keeps forwarding to the current one; bookmarks of the old
`trycloudflare.com` address stop working. Quick tunnels have no uptime guarantee
(Cloudflare intends them for testing), so move to a named tunnel once you have a domain.

## Upgrade to a named tunnel (stable URL, needs a domain on Cloudflare)

1. Add your domain to a free Cloudflare account.
2. On the VM run [`scripts/home-box/setup-named-tunnel.sh`](../home-box/setup-named-tunnel.sh):
   `sudo bash /opt/embified/scripts/home-box/setup-named-tunnel.sh vault.example.com`. It runs
   `cloudflared tunnel login` (open the printed link in your browser), creates the tunnel, the DNS
   route, `/etc/cloudflared/config.yml` and the stock `cloudflared` service pointed at `http://127.0.0.1:80`.
3. Pin the origin for the app and stop the quick tunnel:

   ```bash
   sudo systemctl edit embified   # [Service] Environment=EMBIFIED_PUBLIC_URL=https://vault.example.com
   sudo systemctl disable --now embified-tunnel
   sudo systemctl restart embified
   ```

   `EMBIFIED_PUBLIC_URL` wins over the URL file, so http requests to the IP redirect to the domain.
4. Optionally close TCP 80 in the OCI security list once nothing needs plain http.

## Cloud API webhooks

Copy the https origin into the inbox **Official Cloud API** form → *Public HTTPS origin*.
Meta callback = `<origin>/api/whatsapp/webhook`. With a quick tunnel, update it in Meta after
every tunnel restart — or use a named tunnel. Ad-hoc foreground tunnel:
`sudo bash scripts/cloud-api-https/start-quick-tunnel.sh`.

See the public guide at <https://koyguy.github.io/embified/cloud-setup.html>.
