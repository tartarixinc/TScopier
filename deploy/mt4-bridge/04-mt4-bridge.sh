#!/usr/bin/env bash
# Stage 4 — run ON THE SERVER as root. Installs the MT4 bridge.
#
# The bridge keeps NO session database. After a restart, accounts sign in again
# on their own from the encrypted records held by the application, so nothing
# is stored in clear text next to the containers.
#
# Safe to re-run: an already-correct container is left alone.
set -euo pipefail

cd "${DEPLOY_DIR:-/root/mt4-deploy}"

CONTAINER="${CONTAINER:-mt4rest}"
IMAGE="${IMAGE:-timurila/mt4rest}"
HOST_PORT="${HOST_PORT:-8081}"

echo "Container : $CONTAINER"
echo "Image     : $IMAGE"
echo "Port      : 127.0.0.1:${HOST_PORT}"

# The installer reads the image's own startup command, which means the image has
# to be present. On a server that has never run MT4 it will not be.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image not present locally — pulling it (first time only, may take a while)..."
  if ! docker pull "$IMAGE"; then
    echo
    echo "FAIL  could not pull $IMAGE."
    echo "      Check the name and that the server can reach Docker Hub."
    exit 1
  fi
  echo "PASS  image pulled"
fi

# Install if absent; rebuild if it somehow carries a database connection from
# an earlier attempt.
NEEDS_INSTALL=0
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  NEEDS_INSTALL=1
  echo "Status    : installing"
elif docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^MongoDB='; then
  NEEDS_INSTALL=1
  echo "Status    : recreating without a database connection"
else
  echo "Status    : already installed — not recreating"
fi
echo

if [ "$NEEDS_INSTALL" -eq 1 ]; then
  export CONTAINER IMAGE HOST_PORT NETWORK=mtapi-net
  # An empty value removes the setting, so no database is attached.
  export EXTRA_ENV='MongoDB='
  if ! bash install.sh; then
    echo
    echo "FAIL  the MT4 container did not come up (see the error above)."
    echo "      Re-run this script — it is safe and converges:  bash $0"
    exit 1
  fi
  echo
fi

http_code() {
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || true)"
  printf '%s' "${c:-000}"
}

echo "--- waiting for the bridge to start ---"
for _ in $(seq 1 45); do
  [ "$(http_code http://127.0.0.1:${HOST_PORT}/Ping)" = "200" ] && break
  sleep 2
done
echo

echo "--- checks ---"
fail=0
pending=0

CODE="$(http_code http://127.0.0.1:${HOST_PORT}/Ping)"
if [ "$CODE" = "200" ]; then echo "PASS  local /Ping -> 200"; else echo "FAIL  local /Ping -> $CODE"; fail=1; fi

CODE="$(http_code https://mtapi.tscopier.ai:9443/mt4/Ping)"
if [ "$CODE" = "200" ]; then
  echo "PASS  through nginx /mt4/Ping -> 200"
elif [ "$CODE" = "404" ] || [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  # Before stage 5 the request falls through to the MT5 location, which answers
  # an unauthenticated probe with 401/403 rather than 404.
  echo "WAIT  nginx does not serve the MT4 path yet — run stage 5"; pending=1
else
  echo "FAIL  through nginx /mt4/Ping -> $CODE"; fail=1
fi

BINDING="$(docker inspect "$CONTAINER" --format '{{json .HostConfig.PortBindings}}')"
case "$BINDING" in
  *'"HostIp":"127.0.0.1"'*) echo "PASS  port bound to 127.0.0.1 only" ;;
  *) echo "FAIL  port binding: $BINDING"; fail=1 ;;
esac

CODE="$(http_code http://13.140.44.122:${HOST_PORT}/Ping)"
if [ "$CODE" = "000" ]; then
  echo "PASS  port ${HOST_PORT} is not reachable from outside"
else
  # Any answer at all — even a refusal — means something is listening there.
  echo "FAIL  port ${HOST_PORT} answers from the internet ($CODE) — it must not"
  fail=1
fi

# The bridge must come back by itself after a daemon or host restart. Without
# this policy a bridge left down stays down (2026-10-08 outage).
POLICY="$(docker inspect "$CONTAINER" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || true)"
if [ "$POLICY" = "unless-stopped" ]; then
  echo "PASS  restart policy is unless-stopped"
else
  echo "FAIL  restart policy is [${POLICY:-unset}] — expected unless-stopped"
  fail=1
fi

# Read the container's configuration, not its running processes: `docker exec
# env` says nothing if the bridge happens not to ship an `env` command.
if docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^MongoDB='; then
  echo "FAIL  the bridge still has a database connection — run 10-remove-session-db.sh"
  fail=1
else
  echo "PASS  no database connection (as intended)"
fi

echo
if [ "$fail" -eq 0 ]; then
  if [ "$pending" -eq 1 ]; then
    echo "ALL CHECKS PASSED — except nginx, which still needs stage 5"
  else
    echo "ALL CHECKS PASSED"
  fi
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
