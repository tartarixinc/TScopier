#!/usr/bin/env bash
# Runs an administrative query against the session database.
#   ./mongo-admin.sh --eval 'db.runCommand({ping:1})'
#
# TLS options are added automatically once 09-tls-setup.sh has been run, so
# callers never need to know whether encryption is on. The password is read
# from the root-only file and is never printed.
#
# To test a deliberately WRONG password (stage 2 does this):
#   MONGO_ADMIN_PASS='nope' ./mongo-admin.sh --eval 'db.runCommand({ping:1})'
set -uo pipefail

MONGO_CONTAINER="${MONGO_CONTAINER:-mtapi-mongo}"
PASS_FILE="${PASS_FILE:-/root/.mtapi_mongo_pass}"
LUKS_DIR="${LUKS_DIR:-/opt/mtapi-mongo}"
CERT_DIR="${CERT_DIR:-$LUKS_DIR/certs}"

SAVED="$(tr -d '\n' < "$PASS_FILE" 2>/dev/null || true)"
if [ -z "$SAVED" ]; then
  echo "FAIL  no database password in $PASS_FILE" >&2
  exit 1
fi
PW="${MONGO_ADMIN_PASS:-$SAVED}"

# The certificate lives on the host; mongosh runs inside the container, so the
# path below is the in-container mount path. Both files are required — a CA
# without its server certificate means a half-written directory.
EXTRA=()
if [ -f "$CERT_DIR/ca.crt" ] && [ -f "$CERT_DIR/server.pem" ]; then
  EXTRA=(--tls --tlsCAFile /certs/ca.crt)
fi

docker exec "$MONGO_CONTAINER" mongosh -u mtapi -p "$PW" \
  --authenticationDatabase admin --quiet "${EXTRA[@]}" "$@"
