#!/usr/bin/env bash
# ONE-TIME — run ON THE SERVER as root. No passphrase needed (a terminal is
# still recommended):  ssh root@<server> 'bash /root/mt4-deploy/09-tls-setup.sh'
#
# Encrypts the traffic between the broker bridges and the session database.
# It keeps the database's existing data location and restart behaviour, so it
# works whether or not 07-luks-setup.sh has been run.
set -euo pipefail

LUKS_DIR="${LUKS_DIR:-/opt/mtapi-mongo}"
export LUKS_DIR
CERT_DIR="$LUKS_DIR/certs"
MONGO_CONTAINER="${MONGO_CONTAINER:-mtapi-mongo}"
PASS_FILE="${PASS_FILE:-/root/.mtapi_mongo_pass}"
COMMON_NAME="${COMMON_NAME:-mtapi-mongo}"

if [ "$(id -u)" -ne 0 ]; then echo "FAIL  run as root"; exit 1; fi
if [ ! -f "$PASS_FILE" ]; then echo "FAIL  $PASS_FILE is missing"; exit 1; fi
SAVED="$(tr -d '\n' < "$PASS_FILE")"
if [ -z "$SAVED" ]; then
  echo "FAIL  $PASS_FILE is empty — refusing to touch the database"
  exit 1
fi

if ! docker ps -a --format '{{.Names}}' | grep -qx "$MONGO_CONTAINER"; then
  echo "FAIL  database container $MONGO_CONTAINER does not exist"
  echo "      Start it first: the runbook step 'Start the session database'"
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq openssl; }

# ---- keep the database exactly where it already is -------------------------
DATA_SOURCE="$(docker inspect "$MONGO_CONTAINER" \
  --format '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' 2>/dev/null \
  | awk -F' [|] ' '$2=="/data/db"{print $1}' | head -1)"
if [ -z "$DATA_SOURCE" ]; then
  echo "FAIL  could not find the database's data directory — not changing anything"
  exit 1
fi

RESTART="$(docker inspect "$MONGO_CONTAINER" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || echo unless-stopped)"
RESTART="${RESTART:-unless-stopped}"

NET="$(docker inspect "$MONGO_CONTAINER" \
  --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
  | awk '{print $1}')"
NET="${NET:-mtapi-net}"

# ---- refuse to run against a locked encrypted area --------------------------
# If step 9 (LUKS) has been done and the volume is not mounted, the host
# directory is empty. Recreating the container on it would start a brand new,
# unencrypted database and report success while the real data sits locked.
if [ -f "$LUKS_DIR/data.img" ] && ! mountpoint -q "$LUKS_DIR/data" 2>/dev/null; then
  echo "FAIL  the encrypted area is locked, so the data directory is empty."
  echo "      Unlock it first:"
  echo "          ssh -t root@<server> 'bash /root/mt4-deploy/08-luks-unlock.sh'"
  echo "      Running this now would start a fresh empty database and report"
  echo "      success while your real sessions stay locked away."
  exit 1
fi

# Keep the data source in the form Docker already understands. A named volume
# must stay a named volume, otherwise 'docker volume rm' can later delete the
# live data directory.
DATA_MOUNT=(-v "$DATA_SOURCE:/data/db")
case "$DATA_SOURCE" in
  */_data)
    VOL="$(basename "$(dirname "$DATA_SOURCE")")"
    if docker volume inspect "$VOL" >/dev/null 2>&1; then
      DATA_MOUNT=(-v "$VOL:/data/db")
    fi
    ;;
esac

# Printed on any failure after the container has been removed, so the operator
# is never left without a working command to paste.
print_restore() {
  echo "The data is safe on its volume; only the container needs rebuilding."
  echo "Restore the database in plain mode by pasting this:"
  echo
  echo "  mv '$CERT_DIR' '${CERT_DIR}.off'"
  echo "  docker rm -f $MONGO_CONTAINER"
  echo "  docker run -d --name $MONGO_CONTAINER --restart=$RESTART --network $NET \\"
  echo "    ${DATA_MOUNT[*]} \\"
  echo "    -e MONGO_INITDB_ROOT_USERNAME=mtapi \\"
  echo "    -e MONGO_INITDB_ROOT_PASSWORD=\"\$(tr -d '\\n' < $PASS_FILE)\" \\"
  echo "    mongo:7"
  echo "  bash $(dirname "$0")/02-check-db.sh"
  echo
  echo "Accounts are safe either way: they sign in again on their own."
}

if mountpoint -q "$LUKS_DIR/data" 2>/dev/null; then
  echo "PASS  database data is on the encrypted area"
else
  echo "NOTE  database data is on $DATA_SOURCE (no encrypted area mounted)"
fi

# ---- certificates ----------------------------------------------------------
# These sit NEXT TO (not inside) the encrypted area, so treat them as sensitive
# files in their own right: private key is 600 and never leaves the server.
#
# The database process runs as an unprivileged user inside the container, so it
# must be able to READ server.pem and ca.crt. Ownership matters as much here as
# the mode does — a root-owned 600 file would make the database fail to start.
MONGO_UID="${MONGO_UID:-999}"
mkdir -p "$CERT_DIR"
chmod 755 "$CERT_DIR"

issue_ca() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
    -subj "/CN=TScopier session database CA" >/dev/null 2>&1
  chmod 600 "$CERT_DIR/ca.key"
}

issue_server() {
  printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\n' "$COMMON_NAME" \
    > "$CERT_DIR/server.ext"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" \
    -subj "/CN=$COMMON_NAME" >/dev/null 2>&1
  openssl x509 -req -in "$CERT_DIR/server.csr" \
    -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
    -out "$CERT_DIR/server.crt" -days 825 \
    -extfile "$CERT_DIR/server.ext" >/dev/null 2>&1
  cat "$CERT_DIR/server.crt" "$CERT_DIR/server.key" > "$CERT_DIR/server.pem"
  rm -f "$CERT_DIR/server.csr" "$CERT_DIR/server.ext" "$CERT_DIR/server.key"
  chmod 600 "$CERT_DIR/server.pem"
}

NEED_CA=0
NEED_SERVER=0
if [ ! -f "$CERT_DIR/ca.crt" ] || [ ! -f "$CERT_DIR/ca.key" ]; then NEED_CA=1; fi
if [ ! -f "$CERT_DIR/server.pem" ]; then NEED_SERVER=1; fi
# Renewal: reissue the server certificate when it is within 30 days of expiry.
if [ "$NEED_SERVER" -eq 0 ] \
   && ! openssl x509 -checkend 2592000 -noout -in "$CERT_DIR/server.pem" >/dev/null 2>&1; then
  NEED_SERVER=1
fi
if [ "$NEED_CA" -eq 1 ]; then
  issue_ca
  NEED_SERVER=1
  echo "PASS  certificate authority created"
fi
if [ "$NEED_SERVER" -eq 1 ]; then
  issue_server
  echo "PASS  server certificate created"
fi

chmod 644 "$CERT_DIR/ca.crt"
chown "$MONGO_UID:$MONGO_UID" "$CERT_DIR/server.pem" "$CERT_DIR/ca.crt" 2>/dev/null || true

if openssl verify -CAfile "$CERT_DIR/ca.crt" "$CERT_DIR/server.pem" >/dev/null 2>&1; then
  echo "PASS  certificate verifies against its own CA"
else
  echo "FAIL  certificate does not verify"
  exit 1
fi
if [ "$(stat -c %U "$CERT_DIR/server.pem" 2>/dev/null)" = "root" ]; then
  echo "FAIL  the database could not be given read access to its certificate"
  exit 1
fi
echo "PASS  the database can read its own certificate"

# ---- restart the database with encryption required -------------------------
docker rm -f "$MONGO_CONTAINER" >/dev/null 2>&1 || true
if ! docker run -d --name "$MONGO_CONTAINER" --restart="$RESTART" \
  --network "$NET" \
  "${DATA_MOUNT[@]}" \
  -v "$CERT_DIR:/certs:ro" \
  -e MONGO_INITDB_ROOT_USERNAME=mtapi \
  -e MONGO_INITDB_ROOT_PASSWORD="$SAVED" \
  mongo:7 \
  --tlsMode requireTLS \
  --tlsCertificateKeyFile /certs/server.pem \
  --tlsCAFile /certs/ca.crt \
  --tlsAllowConnectionsWithoutCertificates >/dev/null; then
  echo "FAIL  the database container could not be recreated (see the error above)."
  echo
  print_restore
  exit 1
fi

echo
echo "--- waiting for the database over the encrypted connection ---"
# This check is deliberately self-contained (it does not go through
# mongo-admin.sh) so a path mismatch here can never lock us out silently.
ping_db() {
  docker exec "$MONGO_CONTAINER" mongosh -u mtapi -p "$SAVED" \
    --authenticationDatabase admin --quiet \
    --tls --tlsCAFile /certs/ca.crt \
    --eval 'db.runCommand({ping:1})' 2>&1
}
ok=0
for _ in $(seq 1 30); do
  if ping_db | grep -q 'ok: 1'; then ok=1; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "FAIL  encrypted connection failed — docker logs $MONGO_CONTAINER --tail 30"
  echo
  print_restore
  exit 1
fi
echo "PASS  database answers over the encrypted connection"

# ---- prove unencrypted access is now refused --------------------------------
# A refused connection is the expected result here, and mongosh exits non-zero
# for it. Without the trailing guard, `set -o pipefail` would abort the script
# at exactly the line the operator is told to watch for.
RAW="$(docker exec "$MONGO_CONTAINER" mongosh -u mtapi -p "$SAVED" \
  --authenticationDatabase admin --quiet --eval 'db.runCommand({ping:1})' 2>&1 \
  | tail -1 || :)"
case "$RAW" in
  '')          echo "FAIL  got no answer at all when probing the plain connection"; exit 1 ;;
  *'ok: 1'*)   echo "FAIL  the database still answers WITHOUT encryption"; exit 1 ;;
  *)           echo "PASS  unencrypted connections are refused" ;;
esac

echo
echo "ALL CHECKS PASSED"
echo
echo "The database now requires an encrypted connection."
echo "Next: the two broker bridges must be pointed at the encrypted address."
echo "      They will drop their current sessions and log in again automatically."
echo
echo "  MT5 bridge:  EXTRA_ENV='MongoDB=...' bash install.sh   (see stage 3 pattern)"
echo "  MT4 bridge:  run only after 04-mt4-bridge.sh"
echo
echo "Until they are updated they cannot reach the database, which is safe:"
echo "accounts simply sign in again."
