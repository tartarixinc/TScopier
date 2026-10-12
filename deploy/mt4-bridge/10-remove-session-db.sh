#!/usr/bin/env bash
# Run ON THE SERVER as root. Removes the session database entirely.
#
#   bash 10-remove-session-db.sh                 # take the bridges off it
#   REMOVE_DATA=1 bash 10-remove-session-db.sh   # also delete its stored contents
#
# Why: the database kept broker passwords in clear text on disk, and everything
# it provided (surviving a restart) the application already rebuilds on its own.
# Removing it means those passwords exist only in the application's own
# encrypted records.
#
# It refuses to run until 11-check-reconnect.sh has proven that both bridges
# will be recognised when they lose a session. Override only if you are certain:
#   FORCE=1 bash 10-remove-session-db.sh
#
# Safe to re-run. Each bridge is recreated once, so its live sessions drop and
# sign in again — do this in a quiet window.
set -euo pipefail

cd "${DEPLOY_DIR:-/root/mt4-deploy}"

MONGO_CONTAINER="${MONGO_CONTAINER:-mtapi-mongo}"
VOLUME_NAME="${VOLUME_NAME:-mtapi-mongo-data}"
REMOVE_DATA="${REMOVE_DATA:-0}"
PROOF_FILE="${PROOF_FILE:-/root/.mtapi_reconnect_ok}"
FORCE="${FORCE:-0}"

has_db() {
  docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^MongoDB='
}

# The proof is only needed while something is still attached to the database.
# Once every bridge is off it, re-running (for example to drop the stored
# contents) must not be blocked.
needs_proof=0
for c in mtapi mt5rest mt4rest; do
  docker inspect "$c" >/dev/null 2>&1 || continue
  if has_db "$c"; then needs_proof=1; break; fi
done

if [ "$FORCE" != "1" ] && [ "$needs_proof" -eq 1 ] && [ ! -f "$PROOF_FILE" ]; then
  echo "STOP  the bridges have not been proven to recover without the database."
  echo "      Run this first, and only continue if it says BOTH ARE SAFE:"
  echo "          bash 11-check-reconnect.sh"
  echo "      If you have verified this another way:  FORCE=1 bash $0"
  exit 1
fi

http_code() {
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || true)"
  printf '%s' "${c:-000}"
}

# ---- find the bridges -------------------------------------------------------
MT5_NAME=""
MT4_NAME=""
BRIDGES=()
for c in mtapi mt5rest mt4rest; do
  if docker inspect "$c" >/dev/null 2>&1; then
    BRIDGES+=("$c")
    if [ "$c" = "mt4rest" ]; then
      MT4_NAME="$c"
    elif [ -z "$MT5_NAME" ]; then
      MT5_NAME="$c"
    fi
  fi
done
if [ "${#BRIDGES[@]}" -eq 0 ]; then
  echo "FAIL  no bridge container found (looked for: mtapi, mt5rest, mt4rest)"
  exit 1
fi
echo "Bridges found: ${BRIDGES[*]}"

# ---- 1. take each bridge off the database -----------------------------------
for c in "${BRIDGES[@]}"; do
  if ! has_db "$c"; then
    echo "PASS  $c is already off the database"
    continue
  fi
  # Keep the container's own settings, whatever they are.
  IMAGE="$(docker inspect "$c" --format '{{.Config.Image}}')"
  PORTS="$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}' || true)"
  HOST_PORT="$(printf '%s' "$PORTS" | grep -o '"HostPort":"[0-9]*"' | head -1 | tr -dc '0-9' || true)"
  CONTAINER_PORT="$(printf '%s' "$PORTS" | grep -o '"[0-9]*/tcp"' | head -1 | tr -dc '0-9' || true)"
  if [ -z "$HOST_PORT" ]; then
    case "$c" in mt4rest) HOST_PORT=8081 ;; *) HOST_PORT=8080 ;; esac
  fi
  CONTAINER_PORT="${CONTAINER_PORT:-80}"

  echo "Taking $c off the database (live sessions will drop and rebuild)..."
  if ! CONTAINER="$c" IMAGE="$IMAGE" HOST_PORT="$HOST_PORT" CONTAINER_PORT="$CONTAINER_PORT" \
      NETWORK=mtapi-net EXTRA_ENV='MongoDB=' bash install.sh; then
    echo
    echo "FAIL  $c is DOWN and has not been rebuilt."
    echo "      Bring it back with:"
    echo "          CONTAINER=$c IMAGE=$IMAGE HOST_PORT=$HOST_PORT CONTAINER_PORT=$CONTAINER_PORT \\"
    echo "            NETWORK=mtapi-net EXTRA_ENV='MongoDB=' bash $PWD/install.sh"
    echo "      The database container has been left in place."
    exit 1
  fi
done

# ---- 2. remove the database -------------------------------------------------
if docker inspect "$MONGO_CONTAINER" >/dev/null 2>&1; then
  docker rm -f "$MONGO_CONTAINER" >/dev/null
  echo "PASS  database container removed"
else
  echo "PASS  database container already absent"
fi

if [ "$REMOVE_DATA" = "1" ]; then
  if docker volume rm "$VOLUME_NAME" >/dev/null 2>&1; then
    echo "PASS  stored database contents removed"
  else
    echo "NOTE  stored contents not removed (already gone, or still in use)"
  fi
else
  echo "NOTE  stored contents kept. Remove them once everything is confirmed:"
  echo "          REMOVE_DATA=1 bash $0"
fi

# ---- 3. confirm ------------------------------------------------------------
echo
echo "--- waiting for the bridges ---"
# Give a freshly recreated bridge a moment before judging it, otherwise this
# reports failures that are simply "not started yet".
wait_up() {
  for _ in $(seq 1 10); do
    [ "$(http_code "$1")" = "200" ] && return 0
    sleep 2
  done
  return 1
}
port_of() {
  docker inspect "$1" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null \
    | grep -o '"HostPort":"[0-9]*"' | head -1 | tr -dc '0-9' || true
}
MT5_PORT=""
MT4_PORT=""
if [ -n "$MT5_NAME" ]; then MT5_PORT="$(port_of "$MT5_NAME")"; MT5_PORT="${MT5_PORT:-8080}"; fi
if [ -n "$MT4_NAME" ]; then MT4_PORT="$(port_of "$MT4_NAME")"; MT4_PORT="${MT4_PORT:-8081}"; fi

# Waiting is best-effort: the checks below are what decide.
if [ -n "$MT5_NAME" ]; then wait_up "http://127.0.0.1:${MT5_PORT}/health" || true; fi
if [ -n "$MT4_NAME" ]; then wait_up "http://127.0.0.1:${MT4_PORT}/Ping" || true; fi

echo
echo "--- checks ---"
fail=0
for c in "${BRIDGES[@]}"; do
  if has_db "$c"; then
    echo "FAIL  $c still has a database connection"; fail=1
  else
    echo "PASS  $c has no database connection"
  fi
done

if [ -n "$MT5_NAME" ]; then
  [ "$(http_code http://127.0.0.1:${MT5_PORT}/health)" = "200" ] \
    && echo "PASS  MT5 ($MT5_NAME) answers locally" \
    || { echo "FAIL  MT5 ($MT5_NAME) is not answering"; fail=1; }
  [ "$(http_code https://mtapi.tscopier.ai:9443/health)" = "200" ] \
    && echo "PASS  MT5 answers through nginx" \
    || { echo "FAIL  MT5 is not answering through nginx"; fail=1; }
fi

if [ -n "$MT4_NAME" ]; then
  [ "$(http_code http://127.0.0.1:${MT4_PORT}/Ping)" = "200" ] \
    && echo "PASS  MT4 ($MT4_NAME) answers locally" \
    || { echo "FAIL  MT4 ($MT4_NAME) is not answering"; fail=1; }
  [ "$(http_code https://mtapi.tscopier.ai:9443/mt4/Ping)" = "200" ] \
    && echo "PASS  MT4 answers through nginx" \
    || { echo "FAIL  MT4 is not answering through nginx"; fail=1; }
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  echo
  echo "The bridges now sign accounts in again by themselves after a restart."
  echo "That takes up to about four minutes in the background, or happens"
  echo "immediately when the next trade arrives."
  rm -f "$PROOF_FILE" 2>/dev/null || true
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
