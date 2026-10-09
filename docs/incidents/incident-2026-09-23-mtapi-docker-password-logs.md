# Incident 2026-09-23 — Broker password visible in MTAPI Docker logs

- **Severity:** High (credential exposure on shared host)
- **Status:** Open — password rotation only; redactor installed; public `:8080` closed (localhost bind)
- **Detected:** 2026-09-23, user review of `docker logs mtapi` on Contabo VPS `13.140.44.122`
- **Component:** MTAPI bridge container `mtapi` (`timurila/mt5rest`)
- **Affected credential:** demo login `476205231` (Exness-MT5Trial9); password value omitted

## Plain English

While checking the MTAPI bridge logs, a broker account password appeared in clear text.
TScopier application code did not write it. The third-party MTAPI program prints account
number and password on warning paths (for example when a symbol name is wrong). Anyone
with root on the server — or anyone who pastes the logs into a ticket — can read the
password. Change the broker password, wipe the old log files, and keep port 8080 closed
to the public internet.

## Root cause (technical)

- `timurila/mt5rest` logs `(login, password, ip, …)` tuples on WRN/ERR (e.g. `SymbolParams` failure).
- Docker `json-file` logs retain plaintext under `/var/lib/docker/containers/*/*-json.log`.
- Port 8080 internet-reachable (scanner traffic in the same log dump) — separate hardening gap.
- Not caused by edge/worker logging: passwords are AES-256-GCM in DB, stripped from API responses,
  Sentry redacts `broker_password`; nginx already uses redacted access log (no query string).
- Known related limitation: worker `mtapiProvider` warns that `ConnectEx` puts password in URL query;
  nginx access log no longer records query strings.

## Evidence (redacted)

```
[08:18:40 WRN] ('476205231' '<REDACTED>' '96.0.46.31' '443' '' '5c6d8eb6-…')  <Symbol not found: XAUUSD>
```

## Immediate fix (ops on VPS)

| Step | Status |
|------|--------|
| 1. Rotate password for `476205231` in broker portal; reconnect in TScopier | **Open** |
| 2. Install log redactor (`deploy/mtapi-log-redactor/install.sh`) — recreates container and truncates this container’s json logs | **Done** (2026-09-23) |
| 3. Close public `:8080` — `ufw deny` alone is not enough (Docker bypasses UFW). Bind `127.0.0.1:8080` | **Done** (2026-09-23: container recreated with `-p 127.0.0.1:8080:80`; external probe times out; `:9443` still Healthy) |
| 4. Verify old password absent from new logs after rotation | **Open** |

Scoped log wipe (only this container, if needed again):
`CID=$(docker inspect mtapi --format '{{.Id}}'); truncate -s 0 "/var/lib/docker/containers/${CID}/${CID}-json.log"`

## Files

- Scratchpad: `docs/scratchpads/scratchpad-mtapi-password-in-logs-2026-09-23.md`
- Report: `docs/incidents/incident-2026-09-23-mtapi-docker-password-logs.md` / `.html` / `.pdf`

## Follow-ups

- [ ] User rotates password for `476205231` and reconnects (closes incident)
- [x] Redactor installed on VPS (`install.sh`); container recreated with filter; historical json logs truncated
- [x] Close public `:8080` with localhost bind (2026-09-23: external probe times out; `:9443` still Healthy). Note: UFW alone does not block Docker ports.
- [ ] After rotation: confirm new `docker logs mtapi` has no plaintext password (and any WRN shows `[REDACTED]`)
- [ ] Long-term: MTAPI log verbosity / upstream redaction
- [x] Revisit IP allowlist when worker egress is stable — **enabled 2026-09-24** (geo from access-log IPs; `if ($allowed_ip=0)` active; worker 200 / outsider 403 / health open)
- [ ] Same image will host production sessions — demo leak is a process warning, not “demo-only”

## Deploy state

No app deploy for containment. Redactor installed on VPS; package still uncommitted on `migration`. Migration Trades MTAPI UI work continues separately.
