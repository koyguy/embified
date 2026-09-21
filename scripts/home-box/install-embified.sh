#!/usr/bin/env bash
# Install Embified on a home Linux box (systemd + localhost:80).
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo."
  exit 1
fi

APP_DIR="${EMBIFIED_APP_DIR:-/opt/embified}"
DATA_DIR="${EMBIFIED_DATA_DIR:-/var/lib/embified/data}"
AUTH_DIR="${EMBIFIED_AUTH_DIR:-/var/lib/embified/auth}"
REPO_URL="${EMBIFIED_REPO:-https://github.com/koyguy/embified.git}"
REF="${EMBIFIED_REF:-main}"
PORT="${PORT:-80}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "$(dirname "$APP_DIR")" "$DATA_DIR" "$AUTH_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$REF"
  git -C "$APP_DIR" reset --hard "origin/$REF"
fi

cd "$APP_DIR"
npm ci
npm run build

if [[ ! -f /etc/embified/auth.env ]]; then
  mkdir -p /etc/embified
  if [[ -n "${EMBIFIED_AUTH_PASSWORD:-}" ]]; then
    PASS="$EMBIFIED_AUTH_PASSWORD"
  else
    PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
    echo "Generated vault password (save it): $PASS"
  fi
  umask 077
  printf 'EMBIFIED_AUTH_PASSWORD=%s\n' "$PASS" > /etc/embified/auth.env
  chmod 600 /etc/embified/auth.env
fi

cat > /etc/systemd/system/embified.service <<UNIT
[Unit]
Description=Embified WhatsApp vault (home box)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA_DIR
Environment=AUTH_DIR=$AUTH_DIR
EnvironmentFile=-/etc/embified/auth.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now embified

echo
echo "Embified listening on 127.0.0.1:$PORT"
echo "Next: sudo bash $APP_DIR/scripts/home-box/install-cloudflared.sh"
echo "Then:  sudo bash $APP_DIR/scripts/home-box/setup-named-tunnel.sh vault.example.com"
echo "Or:    sudo bash $APP_DIR/scripts/home-box/start-quick-tunnel.sh"
