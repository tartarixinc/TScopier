#!/bin/sh
set -e

# If Railway provides a WireGuard peer config, install it and bring up wg0
# before starting the app. Uses wireguard-go (userspace) because Railway
# containers usually lack the kernel WireGuard module.
if [ -n "$WG0_CONF" ]; then
  echo "[wg] writing WG0_CONF to /etc/wireguard/wg0.conf"
  mkdir -p /etc/wireguard
  printf '%s\n' "$WG0_CONF" > /etc/wireguard/wg0.conf
  chmod 600 /etc/wireguard/wg0.conf

  if ! ip link show wg0 >/dev/null 2>&1; then
    echo "[wg] bringing up wg0 (userspace wireguard-go)"
    WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go \
      wg-quick up wg0
  fi

  echo "[wg] wg0 status:"
  ip -br addr show wg0 || true
  wg show || true
  echo "[wg] tunnel health:"
  wget -q -O- --timeout=5 http://10.66.0.1:9443/health || \
    echo "[wg] tunnel health check failed (nginx may not be ready yet)"
else
  echo "[wg] WG0_CONF not set — skipping WireGuard"
fi

exec "$@"
