#!/usr/bin/env bash
# Stage 3 — run ON THE SERVER as root.
# Puts the existing MT5 bridge onto the session database.
# Safe to re-run: if the container already has the database connection it is
# left alone and only the checks run.
set -euo pipefail

cd /root/mt4-deploy

PASS_FILE="${PASS_FILE:-/root/.mtapi_mongo_pass}"
if [ ! -f "$PASS_FILE" ]; then
  echo "FAIL  no database password in $PASS_FILE"
  exit 1
fi
SAVED="$(tr -d '\n' < "$PASS_FILE")"
if [ -z "$SAVED" ]; then
  echo "FAIL  the password file $PASS_FILE is empty"
  exit 1
fi

# Find the MT5 container that already exists so we replace the right one.
CONTAINER=""
for candidate in mtapi mt5rest; do
  if docker inspect "$candidate" >/dev/null 2>&1; then
    CONTAINER="$candidate"
    break
  fi
done
if [ -z "$CONTAINER" ]; then
  echo "FAIL  no existing MT5 container found (looked for: mtapi, mt5rest)"
  echo "      Find it with:  docker ps --format '{{.Names}}  {{.Image}}'"
  echo "      Then re-run as: CONTAINER=<name> bash 03-mt5-bridge.sh"
  exit 1
fi

IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
echo "Container : $CONTAINER"
echo "Image     : $IMAGE"

ALREADY_SET=0
if docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^MongoDB='; then
  ALREADY_SET=1
  echo "Status    : already connected to the database — not recreating"
else
  echo "Status    : recreating (live sessions will drop and rebuild)"
fi
echo

if [ "$ALREADY_SET" -eq 0 ]; then
  export CONTAINER IMAGE NETWORK=mtapi-net
  export EXTRA_ENV="MongoDB=mongodb://mtapi:${SAVED}@mtapi-mongo:27017"
  bash install.sh
  echo
fi

# Never fail the script because a request was early or timed out — always
# report the code instead.
http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || echo 000
}

echo "--- waiting for the bridge to start ---"
for _ in $(seq 1 45); do
  [ "$(http_code http://127.0.0.1:8080/health)" = "200" ] && break
  sleep 2
done
echo

echo "--- checks ---"
fail=0

CODE="$(http_code http://127.0.0.1:8080/health)"
if [ "$CODE" = "200" ]; then echo "PASS  local /health -> 200"; else echo "FAIL  local /health -> $CODE"; fail=1; fi

CODE="$(http_code https://mtapi.tscopier.ai:9443/health)"
if [ "$CODE" = "200" ]; then echo "PASS  through nginx /health -> 200"; else echo "FAIL  through nginx /health -> $CODE"; fail=1; fi

BINDING="$(docker inspect "$CONTAINER" --format '{{json .HostConfig.PortBindings}}')"
case "$BINDING" in
  *'"HostIp":"127.0.0.1"'*) echo "PASS  port bound to 127.0.0.1 only" ;;
  *) echo "FAIL  port binding: $BINDING"; fail=1 ;;
esac

if docker exec "$CONTAINER" env 2>/dev/null | grep -q '^MongoDB='; then
  echo "PASS  database connection is set on the container"
else
  echo "FAIL  database connection not found on the container"; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
