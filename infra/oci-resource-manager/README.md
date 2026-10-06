# Embified — OCI Resource Manager stack

Provisions one Always Free–oriented vault:

- VCN + public subnet + internet gateway
- Compute (default `VM.Standard.A1.Flex` 1 OCPU / 6 GB)
- ~150 GB block volume (paravirtualized), mounted at `/data`
- cloud-init: Node 22, clone embified, systemd `embified.service`, idle-reclaim shield,
  and `embified-tunnel.service` (free HTTPS via a Cloudflare quick tunnel)

## Deploy with Resource Manager

```bash
cd infra/oci-resource-manager
zip -r ../../embified-orm-stack.zip . -x '*.terraform*' '*.tfstate*' '.git/*'
```

1. OCI Console → **Developer Services** → **Resource Manager** → **Stacks** → **Create stack** → upload the zip.
2. Set compartment, SSH public key, and home region.
3. **Terraform Actions** → **Apply**.
4. Copy `public_ip` from outputs. Wait 5–10 minutes for cloud-init.
5. **Before sharing the IP**, set the inbox password:

```bash
ssh -i <key> ubuntu@<public_ip>
sudo install -d -m 700 /etc/embified
echo 'EMBIFIED_AUTH_PASSWORD=your-strong-password' | sudo tee /etc/embified/auth.env
sudo chmod 600 /etc/embified/auth.env
sudo systemctl restart embified
```

6. Open `http://<public_ip>/login` (inbox) and link WhatsApp. Once the tunnel is up, that
   address 302s to `https://<random>.trycloudflare.com/login`, so the password is sent over TLS.
   The current URL is in `/var/lib/embified/tunnel-url.txt` and `publicUrl` of `/api/digest/health`;
   it changes when the tunnel restarts. Details and the named-tunnel upgrade:
   [`scripts/cloud-api-https/README.md`](../../scripts/cloud-api-https/README.md).

## Local Terraform (optional)

```bash
export TF_VAR_compartment_ocid=ocid1.compartment...
export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
export TF_VAR_region=ap-hyderabad-1
terraform init && terraform plan && terraform apply
```

## Layout on the VM

| Path | Purpose |
| --- | --- |
| `/data/store` | `DATA_DIR` (messages/media) |
| `/data/auth_info` | `AUTH_DIR` (Baileys session) |
| `/opt/embified` | App checkout |
| `/etc/embified/auth.env` | `EMBIFIED_AUTH_PASSWORD` (optional until set) |
| `/usr/local/sbin/embified-update` | Pull `main`, rebuild, restart |
| `embified-tunnel.service` + `/usr/local/sbin/embified-tunnel-run` | Cloudflare quick tunnel → `http://127.0.0.1:80` |
| `/var/lib/embified/tunnel-url.txt` | Current `https://*.trycloudflare.com` origin |

Always Free idle reclaim still applies — keep light traffic or a digest ping (product backlog).
