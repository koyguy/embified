# Oracle Always Free — 200 GB WhatsApp vault layout

Goal: use nearly all of the **200 GB Always Free block/boot** allowance for embified chat + media.

## Recommended layout

| Volume | Size | Mount | Purpose |
| --- | --- | --- | --- |
| Boot | ~47–50 GB | `/` | OS + Node/Docker |
| Block (data) | ~150 GB | `/data` | `DATA_DIR` + `AUTH_DIR` (the vault) |

`EMBIFIED_QUOTA_BYTES=214748364800` (200 GiB) is the product meter ceiling shown in `/api/disk` and `/vault`.

## Checklist (console)

1. OCI Console → **Block Storage → Block Volumes → Create**
   - Size: **150 GB** (or remainder to 200 GB minus boot)
   - AVPU: Balanced / Always Free eligible
   - Same AD as `embified-free`
2. **Attach** to the embified instance (iSCSI or paravirtualized).
3. SSH to the instance and run:

```bash
sudo CONFIRM=yes bash scripts/oci-always-free/mount-data-volume.sh
```

4. Point embified at the vault (systemd/docker env):

```bash
export DATA_DIR=/data/store
export AUTH_DIR=/data/auth
export EMBIFIED_QUOTA_BYTES=214748364800
```

5. Restart embified. Open `/vault` and `/api/disk` — mount free space should jump.

## Migrate existing data

If you already have `./data` and `./auth_info` on boot disk:

```bash
sudo rsync -aHAX ./data/ /data/store/
sudo rsync -aHAX ./auth_info/ /data/auth/
# then switch env and restart
```

## Stay free

- Keep total boot + block ≤ **200 GB**
- Keep shape Always Free (e.g. `VM.Standard.E2.1.Micro` or A1 within tenancy free OCPU/RAM)
- Outbound ≤ **10 TB/month** (chat traffic is tiny)
- Avoid 7-day full idle reclaim: linked WhatsApp + occasional digests help
