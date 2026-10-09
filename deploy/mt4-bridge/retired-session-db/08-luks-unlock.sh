#!/usr/bin/env bash
# Run AFTER A HOST REBOOT, as root, WITH A TERMINAL:
#   ssh -t root@<server> 'bash /root/mt4-deploy/08-luks-unlock.sh'
#
# Unlocks the encrypted area and brings the session database back up.
# Until this has been run, broker accounts simply log in again automatically.
set -euo pipefail

LUKS_DIR="${LUKS_DIR:-/opt/mtapi-mongo}"
export LUKS_DIR
IMAGE_FILE="$LUKS_DIR/data.img"
MOUNT_POINT="$LUKS_DIR/data"
MAPPER="${MAPPER:-mtapi-mongo}"
MONGO_CONTAINER="${MONGO_CONTAINER:-mtapi-mongo}"
PASS_FILE="${PASS_FILE:-/root/.mtapi_mongo_pass}"
export PASS_FILE
ADMIN="${ADMIN:-$(dirname "$0")/mongo-admin.sh}"

if [ "$(id -u)" -ne 0 ]; then echo "FAIL  run as root"; exit 1; fi
if [ ! -c /dev/tty ]; then
  echo "FAIL  this needs a real terminal so you can type the passphrase."
  echo "      Run it as:  ssh -t root@<server> 'bash /root/mt4-deploy/08-luks-unlock.sh'"
  exit 1
fi

if [ ! -f "$IMAGE_FILE" ]; then
  echo "FAIL  no encrypted container at $IMAGE_FILE"
  echo "      Nothing to unlock — run 07-luks-setup.sh first."
  exit 1
fi

command -v cryptsetup >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq cryptsetup; }

if [ ! -e "/dev/mapper/$MAPPER" ]; then
  echo "Type the passphrase you chose when the volume was created."
  cryptsetup open "$IMAGE_FILE" "$MAPPER"
  echo "PASS  encrypted container opened"
else
  echo "PASS  encrypted container was already open"
fi

mkdir -p "$MOUNT_POINT"
if ! mountpoint -q "$MOUNT_POINT"; then
  mount "/dev/mapper/$MAPPER" "$MOUNT_POINT"
  echo "PASS  mounted at $MOUNT_POINT"
else
  echo "PASS  already mounted at $MOUNT_POINT"
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$MONGO_CONTAINER"; then
  if docker ps --format '{{.Names}}' | grep -qx "$MONGO_CONTAINER"; then
    echo "PASS  database container was already running"
  else
    docker start "$MONGO_CONTAINER" >/dev/null
    echo "PASS  database container started"
  fi
else
  echo "FAIL  database container $MONGO_CONTAINER is missing"
  echo "      Re-run 07-luks-setup.sh"
  exit 1
fi

echo
echo "--- waiting for the database ---"
ok=0
for _ in $(seq 1 30); do
  if bash "$ADMIN" --quiet --eval 'db.runCommand({ping:1})' 2>&1 | grep -q 'ok: 1'; then
    ok=1; break
  fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "FAIL  database did not answer — docker logs $MONGO_CONTAINER --tail 30"
  exit 1
fi
echo "PASS  database answers with the saved password"

if ! mountpoint -q "$MOUNT_POINT"; then
  echo "FAIL  the encrypted area is not mounted"
  exit 1
fi
echo "PASS  the encrypted area is mounted"

# The host path being mounted is not enough. A container started before the
# volume was unlocked binds the same path but a DIFFERENT underlying
# filesystem, so comparing path strings proves nothing — compare devices.
HOST_DEV="$(stat -c %d "$MOUNT_POINT")"
con_dev() {
  docker exec "$MONGO_CONTAINER" stat -c %d /data/db 2>/dev/null || true
}
CON_DEV="$(con_dev)"
if [ "$CON_DEV" != "$HOST_DEV" ]; then
  echo "NOTE  the database is not seeing the encrypted area — restarting it"
  docker restart "$MONGO_CONTAINER" >/dev/null || true
  sleep 3
  CON_DEV="$(con_dev)"
fi
if [ "$CON_DEV" != "$HOST_DEV" ]; then
  echo "FAIL  the database is not using $MOUNT_POINT"
  echo "      The container may have been started while the volume was locked."
  echo "      Stop it, run this script again, then start it:"
  echo "          docker stop $MONGO_CONTAINER && bash $0 && docker start $MONGO_CONTAINER"
  exit 1
fi
echo "PASS  the database is using $MOUNT_POINT"

echo
echo "ALL CHECKS PASSED"
echo
echo "The broker connections resume on their own within a few minutes."
echo "To confirm from your machine:  python3 verify.py resume"
