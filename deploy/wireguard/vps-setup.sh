#!/usr/bin/env bash
# vps-setup.sh — WireGuard server on the Contabo VPS for MTAPI private tunnel.
# Run as root on Ubuntu 22.04: sudo bash vps-setup.sh
#
# Creates wg0 (10.66.0.1/24), opens UDP 51820, and prints the peer config
# for the Railway worker. After this runs, enable the nginx tunnel server
# block (see README.md).
set -euo pipefail

WG_IF="wg0"
WG_PORT="51820"
WG_SUBNET="10.66.0.0/24"
SERVER_IP="10.66.0.1"
SERVER_PRIV_FILE="/etc/wireguard/server_private.key"
SERVER_PUB_FILE="/etc/wireguard/server_public.key"
PEER_NAME="railway-worker"
PEER_DIR="/etc/wireguard/peers"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || error "Run as root: sudo bash vps-setup.sh"

info "Installing WireGuard..."
apt-get update -qq
apt-get install -y -qq wireguard

# --- keys ---
if [[ -f "$SERVER_PRIV_FILE" ]]; then
    warn "Server keys already exist, reusing."
else
    mkdir -p /etc/wireguard
    umask 077
    # tee would echo the private key to stdout — write files directly instead.
    wg genkey > "$SERVER_PRIV_FILE"
    wg pubkey < "$SERVER_PRIV_FILE" > "$SERVER_PUB_FILE"
    info "Generated server keys."
fi
SERVER_PRIV=$(cat "$SERVER_PRIV_FILE")
SERVER_PUB=$(cat "$SERVER_PUB_FILE")

# --- peer keys (one peer = Railway worker) ---
mkdir -p "$PEER_DIR"
PEER_PRIV_FILE="${PEER_DIR}/${PEER_NAME}.private"
PEER_PUB_FILE="${PEER_DIR}/${PEER_NAME}.public"
PEER_PSK_FILE="${PEER_DIR}/${PEER_NAME}.preshared"
PEER_CONF="${PEER_DIR}/${PEER_NAME}.conf"

if [[ -f "$PEER_PRIV_FILE" ]]; then
    warn "Peer ${PEER_NAME} already exists, reusing keys."
else
    umask 077
    wg genkey > "$PEER_PRIV_FILE"
    wg pubkey < "$PEER_PRIV_FILE" > "$PEER_PUB_FILE"
    wg genpsk > "$PEER_PSK_FILE"
    info "Generated peer keys for ${PEER_NAME}."
fi
PEER_PRIV=$(cat "$PEER_PRIV_FILE")
PEER_PUB=$(cat "$PEER_PUB_FILE")
PEER_PSK=$(cat "$PEER_PSK_FILE")

# --- server config ---
# Host-bound only (peer → 10.66.0.1): no MASQUERADE/FORWARD needed.
# Traffic terminates locally on the VPS (INPUT), not forwarded out.
cat > "/etc/wireguard/${WG_IF}.conf" <<EOF
[Interface]
Address = ${SERVER_IP}/24
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_PRIV}

[Peer]
# ${PEER_NAME} (Railway worker)
PublicKey = ${PEER_PUB}
PresharedKey = ${PEER_PSK}
AllowedIPs = 10.66.0.2/32
EOF
chmod 600 "/etc/wireguard/${WG_IF}.conf"

# --- firewall ---
if command -v ufw >/dev/null 2>&1; then
    ufw allow "${WG_PORT}/udp" 2>/dev/null || true
    ufw reload || true
    info "UFW: allowed ${WG_PORT}/udp"
fi

# --- enable + start ---
systemctl enable "wg-quick@${WG_IF}"
systemctl restart "wg-quick@${WG_IF}" || {
    error "wg-quick@${WG_IF} failed to start — check: journalctl -u wg-quick@${WG_IF}"
}

info "WireGuard is up: ${SERVER_IP}/24 on ${WG_IF}, listening :${WG_PORT}/udp"

# --- worker peer config (print path only — private key stays on disk) ---
cat > "$PEER_CONF" <<EOF
# Railway worker peer — place at /etc/wireguard/wg0.conf on the worker host
# (or use wireguard-go userspace if the container has no kernel module).
# Then: MTAPI_BASE_URL=http://${SERVER_IP}:9443 on Railway.
# Verify tunnel first (curl http://${SERVER_IP}:9443/health from the peer),
# THEN flip MTAPI_BASE_URL.

[Interface]
Address = 10.66.0.2/32
PrivateKey = ${PEER_PRIV}

[Peer]
# Contabo VPS (mtapi.tscopier.ai)
PublicKey = ${SERVER_PUB}
PresharedKey = ${PEER_PSK}
Endpoint = REPLACE_WITH_VPS_PUBLIC_IP:${WG_PORT}
AllowedIPs = ${SERVER_IP}/32
PersistentKeepalive = 25
EOF
chmod 600 "$PEER_CONF"

echo ""
echo "============================================="
info "WireGuard server ready"
echo "============================================="
echo ""
echo "  Interface:  ${WG_IF}  ${SERVER_IP}/24"
echo "  Listen:     ${WG_PORT}/udp (UFW allowed)"
echo "  Server pub: (see ${SERVER_PUB_FILE})"
echo "  Peer conf:  ${PEER_CONF}  (contains private key — chmod 600, do not paste to chat)"
echo ""
echo "  Next steps:"
echo "  1. Replace REPLACE_WITH_VPS_PUBLIC_IP in the peer conf with this VPS public IP."
echo "  2. Install the peer conf on the Railway worker host (kernel wg or wireguard-go)."
echo "  3. Verify from peer: curl http://${SERVER_IP}:9443/health (after enabling tunnel conf)."
echo "  4. On VPS: enable the nginx tunnel server block (see deploy/wireguard/README.md)."
echo "  5. Only after step 3 works: set Railway MTAPI_BASE_URL=http://${SERVER_IP}:9443"
echo "     (keep MTAPI_API_KEY + MTAPI_INTERNAL_TOKEN)."
echo ""
echo "  NOTE: Railway containers may lack the kernel WireGuard module."
echo "  If wg-quick fails there, use wireguard-go (userspace) or keep the"
echo "  public HTTPS path (option D alone) until a private path is verified."
echo ""
echo "  With the production wildcard listen 9443 (no IP), nginx still starts if"
echo "  wg0 is down; traffic to ${SERVER_IP}:9443 only reaches the tunnel block once"
echo "  wg0 exists. Keep wg-quick@wg0 enabled; install the tunnel conf only while"
echo "  wg0 is up. Verify with curl after wg-quick up."
echo ""
echo "  Note: private keys are written straight to disk (chmod 600) — not printed."
echo ""
