#!/usr/bin/env bash
# ONE-TIME — run ON THE SERVER as root, WITH A TERMINAL:
#   ssh -t root@<server> 'bash /root/mt4-deploy/07-luks-setup.sh'
#
# Moves the session database onto an encrypted disk area (LUKS).
# You will choose a passphrase. It is never stored — after every host reboot
# the database stays locked until someone runs 08-luks-unlock.sh.
set -euo pipefail

LUKS_DIR="${LUKS_DIR:-/opt/mtapi-mongo}"
IMAGE_FILE="$LUKS_DIR/data.img"
MOUNT_POINT="$LUKS_DIR/data"
MAPPER="${MAPPER:-mtapi-mongo}"
VOLUME_NAME="${VOLUME_NAME:-mtapi-mongo-data}"
MONGO_CONTAINER="${MONGO_CONTAINER:-mtapi-mongo}"
MONGO_UID="${MONGO_UID:-999}"
PASS_FILE="${PASS_FILE:-/root/.mtapi_mongo_pass}"

if [ "$(id -u)" -ne 0 ]; then
  echo "FAIL  run as root"
  exit 1
fi

if [ ! -c /dev/tty ]; then
  echo "FAIL  this needs a real terminal so you can type the passphrase."
  echo "      Run it as:  ssh -t root@<server> 'bash /root/mt4-deploy/07-luks-setup.sh'"
  exit 1
fi

if [ ! -f "$PASS_FILE" ]; then
  echo "FAIL  $PASS_FILE is missing"
  exit 1
fi
SAVED="$(tr -d '\n' < "$PASS_FILE")"
if [ -z "$SAVED" ]; then
  echo "FAIL  $PASS_FILE is empty — refusing to touch the database"
  exit 1
fi

if ! command -v cryptsetup >/dev/null 2>&1; then
  echo "Installing cryptsetup..."
  apt-get update -qq
  apt-get install -y -qq cryptsetup
fi

mkdir -p "$LUKS_DIR"

echo
echo "This creates a 2 GB encrypted container at $IMAGE_FILE"
echo "You will be asked to choose a PASSPHRASE — write it down somewhere safe."
echo "It cannot be recovered if lost; the sessions in it would be lost too"
echo "(sessions are re-creatable, so nothing else is at risk)."
echo

if [ ! -f "$IMAGE_FILE" ]; then
  fallocate -l 2G "$IMAGE_FILE"
  chmod 600 "$IMAGE_FILE"
  echo "PASS  created $IMAGE_FILE (2 GB)"
fi

if ! cryptsetup isLuks "$IMAGE_FILE" 2>/dev/null; then
  cryptsetup luksFormat --type luks2 --batch-mode "$IMAGE_FILE"
  echo "PASS  encrypted container formatted"
fi

if [ ! -e "/dev/mapper/$MAPPER" ]; then
  cryptsetup open "$IMAGE_FILE" "$MAPPER"
  echo "PASS  encrypted container opened"
fi

# Only format a brand-new volume. Re-running setup must never wipe data that
# is already on the encrypted area, so never format something currently mounted.
if ! blkid "/dev/mapper/$MAPPER" 2>/dev/null | grep -q ext4 \
   && [ ! -f "$LUKS_DIR/.migrated" ] \
   && ! mountpoint -q "$MOUNT_POINT"; then
  mkfs.ext4 -F "/dev/mapper/$MAPPER" >/dev/null
  echo "PASS  filesystem created"
fi

mkdir -p "$MOUNT_POINT"
if ! mountpoint -q "$MOUNT_POINT"; then
  mount "/dev/mapper/$MAPPER" "$MOUNT_POINT"
  echo "PASS  mounted at $MOUNT_POINT"
fi

# Move the existing data onto the encrypted area exactly once.
if [ ! -f "$LUKS_DIR/.migrated" ]; then
  SRC="${DOCKER_VOLUME_DIR:-/var/lib/docker/volumes}/$VOLUME_NAME/_data"
  if [ ! -d "$SRC" ]; then
    echo "FAIL  the original data was not found at $SRC"
    echo "      Refusing to mark the migration as done. Check DOCKER_VOLUME_DIR."
    exit 1
  fi
  # lost+found is created by mkfs itself, so it does not count as content.
  if [ -n "$(find "$MOUNT_POINT" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)" ]; then
    echo "FAIL  the encrypted area is not empty but the migration marker is missing"
    echo "      Refusing to copy the old data over it. Inspect $MOUNT_POINT first."
    exit 1
  fi

  NEED_KB="$(du -sk "$SRC" | awk '{print $1}')"
  AVAIL_KB="$(df -P "$MOUNT_POINT" | awk 'NR==2{print $4}')"
  if [ "$NEED_KB" -ge "$AVAIL_KB" ]; then
    echo "FAIL  not enough room on the encrypted area for the existing data"
    echo "      needs ${NEED_KB} KB, has ${AVAIL_KB} KB — enlarge $IMAGE_FILE first"
    exit 1
  fi

  echo
  echo "Stopping the database to move its data onto the encrypted area..."
  # If anything fails from here until the data is moved, say plainly what to do.
  trap 'echo; echo "FAIL — the database is stopped and the data may be only partly copied."; echo "      Bring the original back first:  docker start '"$MONGO_CONTAINER"'"; echo "      A partial copy is refused on re-run, so nothing is overwritten."; echo "      To retry, empty '"$MOUNT_POINT"' and run this script again."' ERR
  if docker inspect -f '{{.State.Running}}' "$MONGO_CONTAINER" 2>/dev/null | grep -q true; then
    if ! docker stop "$MONGO_CONTAINER" >/dev/null; then
      echo "FAIL  the database would not stop — nothing has been copied"
      exit 1
    fi
  fi
  cp -a "$SRC/." "$MOUNT_POINT/"
  chown -R "$MONGO_UID:$MONGO_UID" "$MOUNT_POINT"
  touch "$LUKS_DIR/.migrated"
  echo "PASS  data moved"
fi
trap - ERR

# Keep encryption in step with whatever the certificates say, so a re-run here
# can never quietly turn transport encryption back off. Both files are required:
# one without the other means a half-written certificate directory.
TLS_MOUNT=()
TLS_ARGS=()
PING_TLS=()
if [ -f "$LUKS_DIR/certs/server.pem" ] && [ -f "$LUKS_DIR/certs/ca.crt" ]; then
  echo "NOTE  TLS certificates exist — the new container keeps encryption on"
  TLS_MOUNT=(-v "$LUKS_DIR/certs:/certs:ro")
  TLS_ARGS=(--tlsMode requireTLS --tlsCertificateKeyFile /certs/server.pem
            --tlsCAFile /certs/ca.crt --tlsAllowConnectionsWithoutCertificates)
  PING_TLS=(--tls --tlsCAFile /certs/ca.crt)
fi

CURRENT="$(docker inspect "$MONGO_CONTAINER" \
  --format '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' 2>/dev/null \
  | awk -F' [|] ' '$2=="/data/db"{print $1}' | head -1 || true)"

if [ "$CURRENT" = "$MOUNT_POINT" ]; then
  # Already correct — leave the running container alone. This is what makes a
  # re-run after step 11 harmless: nothing is torn down, TLS survives.
  echo "PASS  database already uses the encrypted area — container left untouched"
else
  # Auto-start is deliberately off: after a reboot it must not come up on an
  # empty, unencrypted directory.
  docker rm -f "$MONGO_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$MONGO_CONTAINER" --restart=no \
    --network mtapi-net \
    -v "$MOUNT_POINT:/data/db" \
    "${TLS_MOUNT[@]}" \
    -e MONGO_INITDB_ROOT_USERNAME=mtapi \
    -e MONGO_INITDB_ROOT_PASSWORD="$SAVED" \
    mongo:7 "${TLS_ARGS[@]}" >/dev/null
fi

echo
echo "--- waiting for the database ---"
PING_ARGS=(--quiet "${PING_TLS[@]}")
for _ in $(seq 1 30); do
  if docker exec "$MONGO_CONTAINER" mongosh -u mtapi -p "$SAVED" \
      --authenticationDatabase admin "${PING_ARGS[@]}" --eval 'db.runCommand({ping:1})' 2>&1 \
      | grep -q "ok: 1"; then
    break
  fi
  sleep 2
done

if docker exec "$MONGO_CONTAINER" mongosh -u mtapi -p "$SAVED" \
    --authenticationDatabase admin "${PING_ARGS[@]}" --eval 'db.runCommand({ping:1})' 2>&1 \
    | grep -q "ok: 1"; then
  echo "PASS  database answers on the encrypted area"
else
  echo "FAIL  database did not answer — docker logs $MONGO_CONTAINER --tail 30"
  exit 1
fi

if docker inspect "$MONGO_CONTAINER" --format '{{range .Mounts}}{{println .Source}}{{end}}' \
    | grep -q "^$MOUNT_POINT$"; then
  echo "PASS  database is using $MOUNT_POINT"
else
  echo "FAIL  database is not mounted on the encrypted area"
  exit 1
fi

echo
echo "ALL CHECKS PASSED"
echo
echo "IMPORTANT — how this behaves from now on:"
echo "  * The data is encrypted while the server is off or the volume is locked."
echo "  * After a REBOOT the database stays locked until someone runs:"
echo "        ssh -t root@<server> 'bash /root/mt4-deploy/08-luks-unlock.sh'"
echo "  * Until then, broker accounts simply log in again automatically."
echo "  * Do not copy $IMAGE_FILE without the passphrase."
echo "  * The old, unencrypted copy in the Docker volume is still present:"
echo "        ${DOCKER_VOLUME_DIR:-/var/lib/docker/volumes}/$VOLUME_NAME"
echo "    Remove it once you have confirmed everything works:"
echo "        docker volume rm $VOLUME_NAME"
