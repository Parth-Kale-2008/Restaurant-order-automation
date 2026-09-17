#!/usr/bin/env bash
# Provision Anand Palace on a fresh Oracle Cloud "Always Free" Ubuntu VM.
#
# Run ON THE VM as the default `ubuntu` user:
#   curl -fsSL https://raw.githubusercontent.com/Parth-Kale-2008/anand-palace/master/deploy/setup-oracle.sh -o setup.sh
#   chmod +x setup.sh
#   ./setup.sh yourdomain.com          # with a domain -> gets free HTTPS
#   ./setup.sh                         # no domain    -> plain http on the public IP
#
# Idempotent: safe to re-run.

set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/Parth-Kale-2008/anand-palace.git"
APP_DIR="/opt/anand-palace"
ENV_FILE="/etc/anand-palace.env"
NODE_MAJOR=22

log() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
log "Installing Node ${NODE_MAJOR}, nginx, git, certbot"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git nginx

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

# ---------------------------------------------------------------------------
# THE ORACLE GOTCHA. Oracle's Ubuntu images ship an iptables ruleset that REJECTs
# everything except SSH. You can open 80/443 in the VCN Security List and the site
# still will not load until these rules exist too. This is the single most common
# reason an Oracle deploy appears dead.
log "Opening ports 80 and 443 in the VM firewall"
sudo iptables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || \
  sudo iptables -I INPUT 6 -p tcp --dport 80  -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || \
  sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT

# Persist across reboot, or the rules vanish and the site dies on next restart.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent netfilter-persistent
sudo netfilter-persistent save

# ---------------------------------------------------------------------------
log "Fetching application into ${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
  sudo git -C "$APP_DIR" fetch --all --prune
  sudo git -C "$APP_DIR" reset --hard origin/master
else
  sudo rm -rf "$APP_DIR"
  sudo git clone "$REPO" "$APP_DIR"
fi
sudo chown -R ubuntu:ubuntu "$APP_DIR"

log "Installing production dependencies"
cd "$APP_DIR"
# puppeteer-core is a devDependency used only by the visual-verify scripts.
npm ci --omit=dev

# data/ holds db.json + secrets.json. On a VM this disk PERSISTS, which is exactly
# what Render's ephemeral filesystem could not give you.
mkdir -p "${APP_DIR}/data"

# ---------------------------------------------------------------------------
log "Writing ${ENV_FILE}"
if [ -f "$ENV_FILE" ]; then
  echo "    exists already - leaving your secrets untouched"
else
  if [ -n "$DOMAIN" ]; then PUBLIC_URL="https://${DOMAIN}"
  else PUBLIC_URL="http://$(curl -fsS --max-time 5 ifconfig.me || echo REPLACE_WITH_YOUR_IP)"; fi

  sudo tee "$ENV_FILE" >/dev/null <<ENVEOF
# Anand Palace configuration. Root-owned, mode 0640.
NODE_ENV=production
PORT=3000

# Table QR codes encode this. Getting it wrong means every printed QR is dead,
# so settle it BEFORE you print anything.
PUBLIC_URL=${PUBLIC_URL}

# Fixed so managers stay logged in across restarts.
JWT_SECRET=$(openssl rand -hex 32)
COOKIE_SECRET=$(openssl rand -hex 32)

# CHANGE THESE. Defaults in code are anand123 / superadmin.
MANAGER_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=' | head -c 14)
ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=' | head -c 14)

# Optional here. The VM disk persists, so db.json survives restarts on its own.
# Set this only if you also want off-box backups / a second server later.
# MONGODB_URI=

# Online payments. Left blank, orders are recorded but not charged.
# RAZORPAY_KEY_ID=
# RAZORPAY_KEY_SECRET=
ENVEOF
  sudo chmod 0640 "$ENV_FILE"
  sudo chown root:ubuntu "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
log "Installing systemd service"
sudo cp "${APP_DIR}/deploy/anand-palace.service" /etc/systemd/system/anand-palace.service
sudo systemctl daemon-reload
sudo systemctl enable anand-palace
sudo systemctl restart anand-palace

# ---------------------------------------------------------------------------
log "Configuring nginx"
sudo cp "${APP_DIR}/deploy/nginx-anand-palace.conf" /etc/nginx/sites-available/anand-palace
if [ -n "$DOMAIN" ]; then
  sudo sed -i "s/server_name _;/server_name ${DOMAIN};/" /etc/nginx/sites-available/anand-palace
fi
sudo ln -sf /etc/nginx/sites-available/anand-palace /etc/nginx/sites-enabled/anand-palace
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# ---------------------------------------------------------------------------
if [ -n "$DOMAIN" ]; then
  log "Requesting a free Let's Encrypt certificate for ${DOMAIN}"
  sudo apt-get install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
       --register-unsafely-without-email --redirect
  # certbot installs a systemd timer that renews automatically.
fi

# ---------------------------------------------------------------------------
log "Done"
sudo systemctl --no-pager --lines=15 status anand-palace || true
echo
echo "  Credentials were generated into ${ENV_FILE}. Read them with:"
echo "      sudo grep PASSWORD ${ENV_FILE}"
echo
if [ -n "$DOMAIN" ]; then echo "  Manager : https://${DOMAIN}/manager"; echo "  Admin   : https://${DOMAIN}/admin";
else echo "  Manager : http://$(curl -fsS --max-time 5 ifconfig.me || echo YOUR_IP)/manager"; fi
echo
echo "  Next: open /admin -> Tables & QR -> REPRINT the QR codes so they encode the new URL."
echo
