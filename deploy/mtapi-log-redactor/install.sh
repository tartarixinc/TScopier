#!/usr/bin/env bash
# Install / reinstall the MTAPI container with password-redacting log pipeline.
# Run on the Contabo VPS as root.
#
# Usage:
#   bash install.sh
#   CONTAINER=mtapi IMAGE=timurila/mt5rest HOST_IP=127.0.0.1 HOST_PORT=8080 CONTAINER_PORT=80 bash install.sh
#
# What it does:
#   1. Copies redact.awk + entrypoint.sh to /opt/mtapi-redactor
#   2. Reads current container's Entrypoint/Cmd (or image defaults)
#   3. Recreates the container with --entrypoint wrapper + bind mount
#   4. Binds the host port to HOST_IP (default 127.0.0.1) so only nginx can reach it
#   5. Truncates old Docker logs that may still hold passwords
#   6. Prints verification commands

set -euo pipefail

CONTAINER="${CONTAINER:-mtapi}"
IMAGE="${IMAGE:-timurila/mt5rest}"
HOST_IP="${HOST_IP:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-8080}"
CONTAINER_PORT="${CONTAINER_PORT:-80}"
INSTALL_DIR="${INSTALL_DIR:-/opt/mtapi-redactor}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

for f in redact.awk entrypoint.sh; do
  if [ ! -f "${SCRIPT_DIR}/${f}" ]; then
    echo "Missing ${SCRIPT_DIR}/${f}" >&2
    exit 1
  fi
done

mkdir -p "$INSTALL_DIR"
install -m 0755 "${SCRIPT_DIR}/entrypoint.sh" "${INSTALL_DIR}/entrypoint.sh"
install -m 0644 "${SCRIPT_DIR}/redact.awk" "${INSTALL_DIR}/redact.awk"
echo "Installed redactor → ${INSTALL_DIR}"

# Capture original entrypoint/cmd from existing container or image
ORIG_EP=""
ORIG_CMD=""
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  # Prefer the image's config, not our previous wrapper entrypoint
  IMAGE_REF="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
  ORIG_EP="$(docker inspect "$IMAGE_REF" --format '{{join .Config.Entrypoint " "}}' 2>/dev/null || true)"
  ORIG_CMD="$(docker inspect "$IMAGE_REF" --format '{{join .Config.Cmd " "}}' 2>/dev/null || true)"
  # If image inspect of tag fails, try container's original via image id
  if [ -z "$ORIG_EP$ORIG_CMD" ]; then
    IMG_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
    ORIG_EP="$(docker inspect "$IMG_ID" --format '{{join .Config.Entrypoint " "}}' 2>/dev/null || true)"
    ORIG_CMD="$(docker inspect "$IMG_ID" --format '{{join .Config.Cmd " "}}' 2>/dev/null || true)"
  fi
else
  ORIG_EP="$(docker inspect "$IMAGE" --format '{{join .Config.Entrypoint " "}}' 2>/dev/null || true)"
  ORIG_CMD="$(docker inspect "$IMAGE" --format '{{join .Config.Cmd " "}}' 2>/dev/null || true)"
fi

echo "Original entrypoint: [${ORIG_EP}]"
echo "Original cmd:        [${ORIG_CMD}]"

if [ -z "$ORIG_EP$ORIG_CMD" ]; then
  echo "Could not determine image entrypoint/cmd for ${IMAGE}." >&2
  echo "The usual cause is that the image has never been pulled on this server:" >&2
  echo "  docker pull ${IMAGE}" >&2
  echo "Then re-run. Otherwise set ORIG_ENTRYPOINT / ORIG_CMD manually." >&2
  exit 1
fi

# Optional extra environment for the container, passed as NAME=value.
# Used to hand the bridge its MongoDB connection string:
#   EXTRA_ENV='MongoDB=mongodb://user:pass@mtapi-mongo:27017/mtapi' bash install.sh
# An empty value removes that key instead of setting it — used to take the
# bridge back off the session database:
#   EXTRA_ENV='MongoDB=' bash install.sh
EXTRA_ENV="${EXTRA_ENV:-}"
EXTRA_ARGS=()
EXTRA_KEY=""
if [ -n "$EXTRA_ENV" ]; then
  EXTRA_KEY="${EXTRA_ENV%%=*}"
  if [ -n "${EXTRA_ENV#*=}" ]; then
    EXTRA_ARGS=(-e "$EXTRA_ENV")
  fi
fi

# Preserve env from existing container if present (docker inspect Env minus our
# wrapper keys, and minus any key being set through EXTRA_ENV). Dropping the
# stale copy here rather than passing both: we cannot assume which of two
# duplicate `-e` entries the daemon keeps, and a wrong pick would silently
# point the bridge at the wrong database.
ENV_ARGS=()
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  while IFS= read -r line; do
    case "$line" in
      MTAPI_REDACTOR_DIR=*|ORIG_ENTRYPOINT=*|ORIG_CMD=*) ;;
      '') ;;
      *)
        if [ -n "$EXTRA_KEY" ] && [ "${line%%=*}" = "$EXTRA_KEY" ]; then
          continue
        fi
        ENV_ARGS+=(-e "$line")
        ;;
    esac
  done < <(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
fi

# Always publish host/container ports (overridable via env).
# Bind to HOST_IP (default 127.0.0.1) so only local nginx can reach the bridge.
# Docker published ports bypass UFW — do not rely on `ufw deny` for this.
# Do not try to re-parse `docker port` — malformed -p values fail after
# the old container is already removed, leaving the bridge down.
PORT_ARGS=(-p "${HOST_IP}:${HOST_PORT}:${CONTAINER_PORT}")

# Optional Docker network. Needed when the container must reach another one by
# name (MongoDB on `mtapi-net`) without publishing a port to the host:
#   NETWORK=mtapi-net bash install.sh
NETWORK="${NETWORK:-}"
NETWORK_ARGS=()
if [ -n "$NETWORK" ]; then
  NETWORK_ARGS=(--network "$NETWORK")
fi

echo "Recreating container ${CONTAINER} with log redactor..."

# Capture log path of the current container (for scoped wipe) before removal
OLD_CID=""
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  OLD_CID="$(docker inspect "$CONTAINER" --format '{{.Id}}')"
fi

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  docker rm -f "$CONTAINER" >/dev/null
fi

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  ${NETWORK_ARGS[@]+"${NETWORK_ARGS[@]}"} \
  "${PORT_ARGS[@]}" \
  "${ENV_ARGS[@]}" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
  -e MTAPI_REDACTOR_DIR=/mtapi-redactor \
  -e ORIG_ENTRYPOINT="$ORIG_EP" \
  -e ORIG_CMD="$ORIG_CMD" \
  -v "${INSTALL_DIR}:/mtapi-redactor:ro" \
  --entrypoint /mtapi-redactor/entrypoint.sh \
  "$IMAGE"

# Confirm the container came up and STAYED up before declaring success.
# `docker run -d` returns as soon as the process is spawned, so checking once
# would wave through a container that crashes a second later — settle first,
# then require that it has never restarted.
sleep 3
up=0
status=""
restarts=""
for _ in $(seq 1 5); do
  status="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null || true)"
  # A running container is the requirement. The restart count only adds
  # confidence, so if it cannot be read for any reason we do not treat a
  # healthy, running container as a failure — the caller's own checks decide.
  if [ "$status" = "running" ] && { [ -z "$restarts" ] || [ "$restarts" = "0" ]; }; then
    up=1; break
  fi
  sleep 2
done
if [ "$up" -ne 1 ]; then
  exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER" 2>/dev/null || true)"
  state_err="$(docker inspect -f '{{.State.Error}}' "$CONTAINER" 2>/dev/null || true)"
  echo "FAIL  container ${CONTAINER} did not settle after about 13 seconds."
  echo "      observed: status=[${status}] restarts=[${restarts}] exit=[${exit_code}] error=[${state_err}]"
  echo "      logs so far:"
  docker logs "$CONTAINER" --tail 30 2>&1 | sed 's/^/    /'
  echo
  echo "The previous container has already been removed. Re-run this script to retry."
  exit 1
fi

# The restart policy is part of the contract for this container: without it a
# bridge left down stays down forever (2026-10-08 outage). `docker rm` above
# discards the previous policy, so it must be set here and then verified.
policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null || true)"
if [ "$policy" != "unless-stopped" ]; then
  echo "FAIL  container ${CONTAINER} has restart policy [${policy:-unset}] — expected unless-stopped."
  echo "      Without it the bridge will not come back after a daemon or host restart."
  exit 1
fi

# Wipe historical plaintext passwords only from this container's json log
# (and any leftover of the previous id). Other containers are left alone.
echo "Truncating historical Docker logs for ${CONTAINER}..."
if [ -n "$OLD_CID" ] && [ -f "/var/lib/docker/containers/${OLD_CID}/${OLD_CID}-json.log" ]; then
  truncate -s 0 "/var/lib/docker/containers/${OLD_CID}/${OLD_CID}-json.log" 2>/dev/null || true
fi
NEW_CID="$(docker inspect "$CONTAINER" --format '{{.Id}}' 2>/dev/null || true)"
if [ -n "$NEW_CID" ] && [ -f "/var/lib/docker/containers/${NEW_CID}/${NEW_CID}-json.log" ]; then
  truncate -s 0 "/var/lib/docker/containers/${NEW_CID}/${NEW_CID}-json.log" 2>/dev/null || true
fi

echo
echo "Done. Verify:"
echo "  docker logs ${CONTAINER} --tail 50"
echo "  docker inspect ${CONTAINER} --format '{{json .HostConfig.PortBindings}}'"
echo "  # Expected HostIp 127.0.0.1 (not empty / 0.0.0.0)"
echo "  docker inspect ${CONTAINER} --format '{{.HostConfig.RestartPolicy.Name}}'"
echo "  # Expected unless-stopped"
echo "  curl -s http://127.0.0.1:${HOST_PORT}/health   # Healthy on the VPS"
echo "  curl -m 5 http://<public-ip>:${HOST_PORT}/health  # must FAIL from outside"
echo "  curl -s https://mtapi.tscopier.ai:9443/health     # nginx path still Healthy"
echo "  # Trigger a WRN path or wait; then:"
echo "  docker logs ${CONTAINER} 2>&1 | grep -E \"password|\\('[0-9]+'\" | head"
echo "  # Expected: no plaintext password in second quoted field (should be [REDACTED])"
echo
echo "Note: UFW cannot block Docker-published ports. Keep HOST_IP=127.0.0.1"
echo "      (or add a DOCKER-USER iptables DROP) — do not rely on ufw deny."
