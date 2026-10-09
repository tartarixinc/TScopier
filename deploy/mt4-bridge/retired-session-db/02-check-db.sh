#!/usr/bin/env bash
# Stage 2 — run ON THE SERVER as root. Checks the session database only.
# Prints PASS/FAIL lines. Never prints the password.
set -uo pipefail

pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1  —  $2"; fail=$((fail + 1)); }

PASS_FILE="${PASS_FILE:-/root/.mtapi_mongo_pass}"

if [ -f "$PASS_FILE" ]; then
  ok "password file exists ($PASS_FILE)"
else
  bad "password file exists" "missing"
fi

SAVED=""
if [ -f "$PASS_FILE" ]; then
  SAVED="$(tr -d '\n' < "$PASS_FILE" 2>/dev/null || true)"
fi
if [ -n "$SAVED" ]; then
  ok "password file is not empty"
else
  bad "password file is not empty" "file is empty"
fi

if docker ps --format '{{.Names}}' | grep -qx mtapi-mongo; then
  ok "database container is running"
else
  bad "database container is running" "not running — docker logs mtapi-mongo --tail 30"
fi

FROM_CONTAINER="$(docker inspect mtapi-mongo --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | sed -n 's/^MONGO_INITDB_ROOT_PASSWORD=//p' | tr -d '\n')"
if [ -n "$FROM_CONTAINER" ] && [ "$FROM_CONTAINER" = "$SAVED" ]; then
  ok "password file matches the container"
else
  bad "password file matches the container" "mismatch — stage 1 was pasted out of order"
fi

ANSWER="$(bash "${ADMIN:-$(dirname "$0")/mongo-admin.sh}" --quiet --eval 'db.runCommand({ping:1})' 2>&1 | tail -1)"
case "$ANSWER" in
  *'ok: 1'*) ok "database answers using the saved password" ;;
  *)         bad "database answers using the saved password" "$ANSWER" ;;
esac

WRONG="$(MONGO_ADMIN_PASS='not-the-real-password' bash "${ADMIN:-$(dirname "$0")/mongo-admin.sh}" \
  --quiet --eval 'db.runCommand({ping:1})' 2>&1 | tail -1)"
case "$WRONG" in
  *[Aa]uth*|*[Ee]rror*|*Unauthorized*) ok "database rejects a wrong password (authentication is on)" ;;
  *) bad "database rejects a wrong password" "a wrong password was accepted: $WRONG" ;;
esac

if docker network inspect mtapi-net >/dev/null 2>&1; then
  ok "network mtapi-net exists"
else
  bad "network mtapi-net exists" "missing"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
