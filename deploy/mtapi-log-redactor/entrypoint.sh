#!/bin/sh
# Wrapper entrypoint for timurila/mt5rest (container name: mtapi).
# Starts the real MTAPI process and streams its stdout/stderr through redact.awk
# so broker passwords never reach Docker's json-file logs.
#
# Usage (install rewrites ORIG_CMD on the host bind-mount):
#   /mtapi-redactor/entrypoint.sh
#
# Env:
#   MTAPI_REDACTOR_DIR  — directory containing redact.awk (default /mtapi-redactor)
#   ORIG_ENTRYPOINT     — original image entrypoint (space-separated words)
#   ORIG_CMD            — original image CMD (space-separated words)

set -eu

DIR="${MTAPI_REDACTOR_DIR:-/mtapi-redactor}"
AWK_SCRIPT="${DIR}/redact.awk"

# Defaults match a typical mt5rest image; install.sh overwrites via env from docker run -e
ORIG_ENTRYPOINT="${ORIG_ENTRYPOINT:-}"
ORIG_CMD="${ORIG_CMD:-}"

if [ ! -f "$AWK_SCRIPT" ]; then
  # Fail closed: starting unredacted would re-introduce the incident.
  echo "[mtapi-redactor] missing ${AWK_SCRIPT} — refusing to start (fail closed)" >&2
  exit 1
fi

# Build the original command.
# Docker passes the image CMD as "$@" when an ENTRYPOINT is overridden only
# if args are appended — we replace entrypoint entirely, so "$@" is empty.
# Prefer ORIG_ENTRYPOINT + ORIG_CMD from env; if "$@" was provided use that
# as CMD only when ORIG_CMD is unset (avoids duplicating CMD after ENTRYPOINT).
if [ -n "$ORIG_ENTRYPOINT" ]; then
  if [ $# -gt 0 ]; then
    # shellcheck disable=SC2086
    set -- $ORIG_ENTRYPOINT "$@"
  else
    # shellcheck disable=SC2086
    set -- $ORIG_ENTRYPOINT ${ORIG_CMD:-}
  fi
elif [ $# -eq 0 ] && [ -n "$ORIG_CMD" ]; then
  # shellcheck disable=SC2086
  set -- $ORIG_CMD
fi

if [ $# -eq 0 ]; then
  echo "[mtapi-redactor] no original command configured" >&2
  exit 1
fi

# Run child with stdout+stderr piped through awk redactor.
# - stdbuf -oL -eL: line-buffer so logs appear promptly (if stdbuf exists).
# - Child PID tracked for signal forwarding.

child_pid=""
redact() {
  if command -v stdbuf >/dev/null 2>&1; then
    stdbuf -oL -eL "$@" 2>&1
  else
    "$@" 2>&1
  fi
}

forward() {
  sig="$1"
  if [ -n "$child_pid" ]; then
    kill -"$sig" "$child_pid" 2>/dev/null || true
  fi
}

trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP

# Start redactor pipeline in background: child | awk > docker stdout
# awk's own output is line-buffered too, otherwise its 4 KB buffer swallows the
# first burst of startup lines and `docker logs` looks empty for minutes — which
# makes a healthy container look broken.
(
  if command -v stdbuf >/dev/null 2>&1; then
    redact "$@" | stdbuf -oL -eL awk -f "$AWK_SCRIPT"
  else
    redact "$@" | awk -f "$AWK_SCRIPT"
  fi
) &
pipeline_pid=$!

# Also need the child's PID for signals — redact runs "$@" inside subshell.
# Best-effort: find the MTAPI/dotnet process
sleep 0.2 2>/dev/null || true
child_pid=$(pgrep -f "${1##*/}" 2>/dev/null | head -1 || true)
if [ -z "$child_pid" ]; then
  child_pid=$(pgrep -f 'mt5rest|dotnet' 2>/dev/null | head -1 || true)
fi

wait "$pipeline_pid"
exit $?
