#!/usr/bin/env bash
# Pull the latest code and restart. Run on the VM after pushing to GitHub.
#   ~/update.sh   (or  /opt/anand-palace/deploy/update.sh)
set -euo pipefail
APP_DIR="/opt/anand-palace"

echo "==> Pulling latest"
sudo git -C "$APP_DIR" fetch --all --prune
sudo git -C "$APP_DIR" reset --hard origin/master
sudo chown -R ubuntu:ubuntu "$APP_DIR"

echo "==> Installing dependencies"
cd "$APP_DIR" && npm ci --omit=dev

echo "==> Restarting"
sudo systemctl restart anand-palace
sleep 2
sudo systemctl --no-pager --lines=10 status anand-palace
