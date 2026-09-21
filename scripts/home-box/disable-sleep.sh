#!/usr/bin/env bash
# Best-effort: keep a Debian/Ubuntu home box from suspending.
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target 2>/dev/null || true
if command -v gsettings >/dev/null 2>&1 && [[ -n "${SUDO_USER:-}" ]]; then
  sudo -u "$SUDO_USER" gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
fi
echo "Masked sleep/suspend targets (where supported). Confirm BIOS/OS won’t auto-sleep."
