#!/usr/bin/env bash
# Stage 1 — run on YOUR machine. Copies the deployment files to the server.
set -euo pipefail

VPS_IP="${VPS_IP:-13.140.44.122}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# A private staging directory: a predictable name in /tmp could be pre-created
# by another user on this machine, and these files are run as root on the server.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$REPO"/deploy/mtapi-log-redactor/*.sh "$STAGE"/
cp "$REPO"/deploy/mtapi-log-redactor/*.awk "$STAGE"/
cp "$REPO"/deploy/mt4-bridge/*.sh "$STAGE"/
cp "$REPO"/deploy/mt4-bridge/*.py "$STAGE"/ 2>/dev/null || true
cp "$REPO"/docs/nginx-setup/mtapi-tscopier.conf "$STAGE"/

echo "Staged locally:"
ls -1 "$STAGE" | sed 's/^/    /'

ssh "root@${VPS_IP}" 'mkdir -p /root/mt4-deploy'
scp "$STAGE"/* "root@${VPS_IP}:/root/mt4-deploy/" >/dev/null

echo
echo "Files now on the server:"
ssh "root@${VPS_IP}" 'ls -1 /root/mt4-deploy' | sed 's/^/    /'

echo
if ssh "root@${VPS_IP}" 'test -f /root/mt4-deploy/install.sh && test -f /root/mt4-deploy/mtapi-tscopier.conf'; then
  echo "PASS  required files are on the server"
else
  echo "FAIL  files missing on the server"
  exit 1
fi
