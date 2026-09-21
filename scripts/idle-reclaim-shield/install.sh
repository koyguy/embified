#!/usr/bin/env bash
set -euo pipefail
# Install/enable idle-reclaim shield on an Embified vault VM.
ROOT="$(cd "$(dirname "$0")" && pwd)"
install -m 0755 "$ROOT/embified-idle-shield.sh" /usr/local/sbin/embified-idle-shield
install -m 0644 "$ROOT/embified-idle-shield.service" /etc/systemd/system/embified-idle-shield.service
install -m 0644 "$ROOT/embified-idle-shield.timer" /etc/systemd/system/embified-idle-shield.timer
mkdir -p /var/lib/embified
systemctl daemon-reload
systemctl enable --now embified-idle-shield.timer
systemctl start embified-idle-shield.service || true
systemctl list-timers --all | grep embified-idle-shield || true
echo "Installed. Check: journalctl -u embified-idle-shield -n 20 --no-pager"
