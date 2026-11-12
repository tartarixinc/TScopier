#!/usr/bin/env bash
# Ops check: Discord Railway must use the same TRADE_WORKER_URL + WORKER_INTERNAL_TOKEN
# as the Telegram listener / trade worker. Run from a shell that has those values.
set -euo pipefail

BASE_URL="${TRADE_WORKER_URL:-https://tscopier-worker-production.up.railway.app}"
BASE_URL="${BASE_URL%/}"
TOKEN="${WORKER_INTERNAL_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "Set WORKER_INTERNAL_TOKEN (same as trade worker) then re-run."
  exit 1
fi

echo "Probing ${BASE_URL}/internal/dispatch-ping ..."
code=$(curl -sS -o /tmp/discord-dispatch-ping.json -w '%{http_code}' \
  -H "x-internal-token: ${TOKEN}" \
  "${BASE_URL}/internal/dispatch-ping" || true)
echo "HTTP ${code}"
head -c 300 /tmp/discord-dispatch-ping.json 2>/dev/null || true
echo
if [[ "$code" != "200" ]]; then
  echo "FAIL: Discord listener cannot push with this URL/token pair."
  echo "On Railway Discord service set:"
  echo "  TRADE_WORKER_URL=${BASE_URL}"
  echo "  WORKER_INTERNAL_TOKEN=<same as trade worker>"
  exit 1
fi
echo "OK: dispatch-ping accepted — wire these vars on WORKER_ROLE=discord_listener and redeploy."
