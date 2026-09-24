#!/bin/sh

# WireGuard is best-effort: Railway containers often lack NET_ADMIN, so
# tunnel bring-up must never block or crash the app. On failure we log and
# continue on the public HTTPS path (option D: X-Internal-Token).
if [ -n "$WG0_CONF" ]; then
  echo "[wg] writing WG0_CONF to /etc/wireguard/wg0.conf"
  mkdir -p /etc/wireguard
  printf '%s\n' "$WG0_CONF" > /etc/wireguard/wg0.conf
  chmod 600 /etc/wireguard/wg0.conf

  if ! ip link show wg0 >/dev/null 2>&1; then
    echo "[wg] bringing up wg0 (userspace wireguard-go)"
    if WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go \
      wg-quick up wg0; then
      echo "[wg] wg0 is up"
      echo "[wg] tunnel health:"
      wget -q -O- --timeout=5 http://10.66.0.1:9443/health || \
        echo "[wg] tunnel health check failed"
    else
      echo "[wg] WireGuard unavailable (expected without NET_ADMIN) — continuing on public HTTPS"
    fi
  else
    echo "[wg] wg0 already present"
  fi
else
  echo "[wg] WG0_CONF not set — skipping WireGuard"
fi

exec "$@"
