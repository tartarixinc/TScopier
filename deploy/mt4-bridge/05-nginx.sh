#!/usr/bin/env bash
# Stage 5 — run ON THE SERVER as root. Adds the MT4 path to nginx and reloads.
# Backs up first and restores automatically if the config does not validate.
set -euo pipefail

SITE=/etc/nginx/conf.d/mtapi-tscopier.conf
SRC=/root/mt4-deploy/mtapi-tscopier.conf
BACKUP="${SITE}.bak-$(date +%Y%m%d-%H%M)"

if ! grep -q 'upstream mt4_backend' "$SRC"; then
  echo "FAIL  $SRC has no MT4 upstream — it is an old copy."
  echo "      On your own machine run:  bash deploy/mt4-bridge/01-copy-files.sh"
  exit 1
fi

http_code() {
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || true)"
  printf '%s' "${c:-000}"
}

if grep -q 'upstream mt4_backend' "$SITE"; then
  echo "Status : nginx already has the MT4 path — not copying again"
else
  cp -a "$SITE" "$BACKUP"
  echo "Backup : $BACKUP"
  cp "$SRC" "$SITE"

  if ! nginx -t; then
    echo
    echo "FAIL  nginx rejected the new config — restoring the backup."
    cp -a "$BACKUP" "$SITE"
    nginx -t
    systemctl reload nginx
    echo "Rolled back. The previous config is live again."
    exit 1
  fi

  systemctl reload nginx
  echo "PASS  nginx accepted the config and reloaded"
fi

# A reload is graceful: the old workers keep serving until they drain, so for a
# moment a request can still be answered from the previous configuration — which
# has no MT4 path at all, and would look like a failure. Let it settle so the
# checks below judge the new config and not the old one.
sleep 3

echo
echo "--- checks ---"
fail=0

CODE="$(http_code https://mtapi.tscopier.ai:9443/mt4/Ping)"
if [ "$CODE" = "200" ]; then echo "PASS  /mt4/Ping -> 200"; else echo "FAIL  /mt4/Ping -> $CODE"; fail=1; fi

CODE="$(http_code https://mtapi.tscopier.ai:9443/mt4/AccountSummary)"
if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  echo "PASS  /mt4/AccountSummary without credentials -> $CODE (blocked)"
else
  echo "FAIL  /mt4/AccountSummary without credentials -> $CODE (must be 401 or 403)"
  fail=1
fi

CODE="$(http_code https://mtapi.tscopier.ai:9443/health)"
if [ "$CODE" = "200" ]; then echo "PASS  MT5 /health still -> 200"; else echo "FAIL  MT5 /health -> $CODE"; fail=1; fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
