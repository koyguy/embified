#!/usr/bin/env bash
# Idempotent helper: find a freshly attached OCI block volume, format if empty, mount at /data.
set -euo pipefail

MOUNT_POINT="${MOUNT_POINT:-/data}"
STORE_DIR="${STORE_DIR:-/data/store}"
AUTH_DIR_TARGET="${AUTH_DIR_TARGET:-/data/auth}"

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "Refusing to format/mount without CONFIRM=yes"
  echo "Usage: sudo CONFIRM=yes bash $0"
  exit 1
fi

# Prefer the largest unmounted disk that isn't the boot disk
mapfile -t CANDIDATES < <(lsblk -dn -o NAME,TYPE,SIZE,MOUNTPOINT | awk '$2=="disk" && $4=="" {print $1}')
if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
  echo "No unmounted disks found. Attach a block volume in OCI first."
  lsblk
  exit 2
fi

DEV="/dev/${CANDIDATES[-1]}"
echo "Using device $DEV"

# If no filesystem, create ext4
FSTYPE=$(lsblk -dn -o FSTYPE "$DEV" || true)
PART="$DEV"
if [[ -z "${FSTYPE:-}" ]]; then
  # create single partition if whole disk blank
  if ! lsblk -dn -o NAME "$DEV" | grep -q .; then
    true
  fi
  if [[ -z "$(lsblk -dn -o FSTYPE "$DEV")" ]]; then
    echo "Creating GPT + ext4 on $DEV"
    parted -s "$DEV" mklabel gpt mkpart primary ext4 1MiB 100%
    PART="${DEV}1"
    # wait for partition node
    sleep 2
    if [[ ! -b "$PART" ]]; then PART="$DEV"; fi
    mkfs.ext4 -F -L embified-data "$PART"
  fi
else
  PART="$DEV"
fi

mkdir -p "$MOUNT_POINT"
UUID=$(blkid -s UUID -o value "$PART")
if ! mountpoint -q "$MOUNT_POINT"; then
  mount "$PART" "$MOUNT_POINT"
fi

if ! grep -q "$UUID" /etc/fstab 2>/dev/null; then
  echo "UUID=$UUID $MOUNT_POINT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

mkdir -p "$STORE_DIR" "$AUTH_DIR_TARGET"
chmod 755 "$STORE_DIR" "$AUTH_DIR_TARGET"

echo "Mounted. Export these for embified:"
echo "  export DATA_DIR=$STORE_DIR"
echo "  export AUTH_DIR=$AUTH_DIR_TARGET"
echo "  export EMBIFIED_QUOTA_BYTES=214748364800"
df -h "$MOUNT_POINT"
