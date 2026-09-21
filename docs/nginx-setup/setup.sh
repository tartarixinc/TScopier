#!/usr/bin/env bash
# setup.sh — One-shot setup for MTAPI nginx on Contabo VPS
# Run as root on Ubuntu 22.04: sudo bash setup.sh
set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────
DOMAIN="mtapi.tscopier.ai"
PORT="9443"
MTAPI_CONTAINER_PORT="8080"

# ─── Colors ───────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Pre-flight checks ───────────────────────────────────────────
[[ $EUID -eq 0 ]] || error "Run as root: sudo bash setup.sh"

info "Starting MTAPI nginx setup for ${DOMAIN}"

# ─── 1. System update ────────────────────────────────────────────
info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# ─── 2. Install nginx + certbot ──────────────────────────────────
info "Installing nginx and certbot..."
apt-get install -y -qq nginx certbot python3-certbot-nginx ufw

# ─── 3. Generate API key ─────────────────────────────────────────
KEYFILE="/root/.mtapi_api_key"
if [[ -f "$KEYFILE" ]]; then
    API_KEY=$(cat "$KEYFILE")
    warn "Existing API key found at ${KEYFILE}, reusing it."
else
    API_KEY=$(openssl rand -base64 48 | tr -d '=+/' | head -c 64)
    echo "$API_KEY" > "$KEYFILE"
    chmod 600 "$KEYFILE"
    info "Generated new API key → ${KEYFILE}"
fi

# ─── 4. Write main nginx.conf ───────────────────────────────────
info "Writing main nginx.conf..."
export MTAPI_API_KEY="$API_KEY"
envsubst '$MTAPI_API_KEY' < /tmp/nginx-setup/nginx.conf > /etc/nginx/nginx.conf
rm -f /etc/nginx/sites-enabled/default

# ─── 5. Write temporary HTTP-only config (for certbot) ──────────
info "Writing temporary HTTP config for certbot verification..."
cat > /etc/nginx/conf.d/mtapi-tscopier.conf <<HTTPEOF
upstream mtapi_backend {
    server 127.0.0.1:${MTAPI_CONTAINER_PORT};
    keepalive 16;
}

server {
    listen 80;
    server_name ${DOMAIN};

    # Let's Encrypt challenge files
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://mtapi_backend;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
HTTPEOF

# ─── 6. Test + start nginx (HTTP only) ──────────────────────────
info "Testing HTTP nginx config..."
nginx -t || error "Nginx config test failed"

info "Starting nginx (HTTP only)..."
systemctl enable nginx
systemctl restart nginx

# ─── 7. Obtain SSL certificate ───────────────────────────────────
info "Ensuring port 80 is open for certbot challenge..."
ufw allow 80/tcp 2>/dev/null || true

info "Obtaining Let's Encrypt certificate for ${DOMAIN}..."
certbot certonly \
    --webroot \
    --webroot-path /var/www/html \
    --non-interactive \
    --agree-tos \
    --email "admin@tscopier.ai" \
    -d "${DOMAIN}"

# ─── 8. Write final HTTPS config ────────────────────────────────
info "Writing final HTTPS nginx config..."
envsubst '$MTAPI_API_KEY' < /tmp/nginx-setup/mtapi-tscopier.conf > /etc/nginx/conf.d/mtapi-tscopier.conf

# ─── 9. Test + restart nginx (HTTPS) ────────────────────────────
info "Testing HTTPS nginx config..."
nginx -t || error "Nginx config test failed after SSL"

info "Restarting nginx with SSL..."
systemctl restart nginx

# ─── 9b. Tighten firewall (remove port 80, keep only SSH + 9443) ──
info "Tightening firewall (removing port 80)..."
ufw delete allow 80/tcp 2>/dev/null || true
ufw reload

info "Firewall rules:"
ufw status

# ─── 11. Set up cert auto-renewal ────────────────────────────────
info "Setting up cert auto-renewal..."
cat > /etc/cron.d/certbot-renew <<'EOF'
# Renew Let's Encrypt certs twice daily
0 0,12 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"
EOF

# ─── 12. Install fail2ban ───────────────────────────────────────
info "Installing fail2ban..."
apt-get install -y -qq fail2ban

cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
action = ufw[name=HTTP, port=9443, protocol=tcp]
logpath = /var/log/nginx/error.log
maxretry = 10
EOF

systemctl enable fail2ban
systemctl restart fail2ban

# ─── Done ─────────────────────────────────────────────────────────
echo ""
echo "============================================="
info "Setup complete!"
echo "============================================="
echo ""
echo "  Domain:    https://${DOMAIN}:${PORT}"
echo "  API Key:   ${API_KEY}"
echo "  API Key saved to: ${KEYFILE}"
echo ""
echo "  Test with:"
echo "    curl -k https://${DOMAIN}:${PORT}/health"
echo "    curl -k -H 'Authorization: Bearer ${API_KEY}' https://${DOMAIN}:${PORT}/"
echo ""
echo "  Firewall:"
ufw status
echo ""
echo "  Next steps:"
echo "  1. Copy the API key to Railway env vars as MTAPI_API_KEY"
echo "  2. Set MTAPI_URL=https://${DOMAIN}:${PORT} in Railway"
echo "  3. Start the MTAPI Docker container if not already running"
echo ""
