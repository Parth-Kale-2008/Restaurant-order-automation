#!/usr/bin/env bash
# Pull the latest code and restart. Run on the VM after pushing to GitHub:
#   /opt/anand-palace/deploy/update.sh
set -euo pipefail
APP_DIR="/opt/anand-palace"

# Git must run as `ubuntu`, NOT via sudo: the read-only deploy key that grants
# access to the private repo lives in ~ubuntu/.ssh. Under root the fetch fails
# with "Permission denied (publickey)".
if [ "$(id -un)" != "ubuntu" ]; then
  echo "Run this as the ubuntu user (the deploy key is ubuntu's), not with sudo." >&2
  exit 1
fi

echo "==> Pulling latest"
git -C "$APP_DIR" fetch --all --prune
git -C "$APP_DIR" reset --hard origin/master

echo "==> Installing dependencies"
cd "$APP_DIR" && npm ci --omit=dev

echo "==> Restarting"
sudo systemctl restart anand-palace
sleep 2
sudo systemctl --no-pager --lines=10 status anand-palace
