# MTAPI Docker log redactor

Stops the third-party MTAPI bridge (`timurila/mt5rest`) from writing **broker passwords** into Docker logs.

**Incident:** `docs/incidents/incident-2026-09-23-mtapi-docker-password-logs.md`

## What it does

| Layer | Without redactor | With redactor |
|-------|------------------|---------------|
| Container process | Writes `('login' 'PASSWORD' …)` on WRN | Same process |
| stdout → Docker | Plaintext password in `json-file` logs | `('login' '[REDACTED]' …)` |
| nginx access log | Already redacted (no query string) | Unchanged |

The MTAPI **binary** still logs the password internally; this wrapper filters **before** Docker persists the line. It is the practical permanent fix until upstream stops logging secrets.

## Files

| File | Role |
|------|------|
| `redact.awk` | Line filter: connection tuples, `password=…`, JSON `password` fields |
| `entrypoint.sh` | Container entrypoint: runs original MTAPI cmd through the filter |
| `install.sh` | VPS install: copy files, recreate container, wipe old logs |
| `test.sh` | Local unit tests for `redact.awk` |

## Local test (no Docker)

```bash
bash deploy/mtapi-log-redactor/test.sh
```

## Install on Contabo VPS

From your machine (repo checked out):

```bash
VPS_IP=13.140.44.122
scp deploy/mtapi-log-redactor/* root@${VPS_IP}:/tmp/mtapi-redactor/
```

SSH and run:

```bash
ssh root@${VPS_IP}
cd /tmp/mtapi-redactor
bash install.sh
# defaults: CONTAINER=mtapi IMAGE=timurila/mt5rest HOST_IP=127.0.0.1 HOST_PORT=8080 CONTAINER_PORT=80
# The container listens only on localhost; nginx (9443) is the public entry.
```

If the container name differs:

```bash
CONTAINER=mt5rest HOST_IP=127.0.0.1 HOST_PORT=5000 CONTAINER_PORT=80 bash install.sh
```

### Verify

```bash
docker inspect mtapi --format '{{json .HostConfig.PortBindings}}'
# HostIp must be 127.0.0.1 — empty HostIp means still public

curl -s http://127.0.0.1:8080/health
# From another machine (must fail):
#   curl -m 5 http://13.140.44.122:8080/health

curl -s https://mtapi.tscopier.ai:9443/health

docker logs mtapi --tail 50
# Force or wait for a WRN path, then:
docker logs mtapi 2>&1 | grep -E "password|\('[0-9]+'" | head
# Second quoted field must be [REDACTED], never a real password
```

Also wipe any logs written **before** install (scope to this container only):

```bash
CID=$(docker inspect mtapi --format '{{.Id}}')
truncate -s 0 "/var/lib/docker/containers/${CID}/${CID}-json.log"
```

**Do not use `ufw deny 8080` to close this port** — Docker published ports bypass UFW. Use `HOST_IP=127.0.0.1` (install default) or a `DOCKER-USER` iptables rule.

## Limitations

- **Rotated passwords** still need host access to read old json logs — truncate after every exposure.
- If the image entrypoint changes on upgrade, re-run `install.sh`.
- Signal handling is best-effort (TERM forwarded via pgrep); fine for `--restart always`.
- Does **not** protect against someone with root running `docker exec` and reading process memory.

## Related secrets (not this redactor)

See `docs/mtapi-credentials.md` for `BROKER_CREDENTIALS_ENCRYPTION_KEY`, `MTAPI_BASE_URL`, and `MTAPI_API_KEY`.
