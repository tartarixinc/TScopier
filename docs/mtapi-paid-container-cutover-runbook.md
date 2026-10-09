# MTAPI paid container cutover — runbook

**Status:** ready to run. Written 2026-09-30.
**Purpose:** replace the trial MTAPI Docker image with the licensed one, on our
own Contabo VPS, with no data loss and no password re-entry for customers.

**Companion documents:** `docs/mtapi-hosting.md` (where it runs and what it
costs), `docs/mtapi-conformance-sanitized.md` (the 13-step behaviour check),
`docs/mtapi-credentials.md` (the three secrets), and the incident report
`docs/incidents/incident-2026-09-23-mtapi-docker-password-logs.md` (why the log
redactor must survive this cutover).

---

## 1. What changes and what does not

### Changes

| Item | Effect |
|------|--------|
| Container image | Trial build → licensed build, same container name, same port |
| Every live session | Dies with the container — expected, not a fault |
| Session recovery | Starts working: `CheckConnect` / `ConnectByToken` fail on the trial (no MongoDB), so every recovery today falls through to a full re-authentication |
| Session capacity | Trial is effectively single-session; the paid build must be configured for ≥150 for real volume |

### Does not change

| Item | Why |
|------|-----|
| `MTAPI_BASE_URL`, `MTAPI_API_KEY`, `MTAPI_INTERNAL_TOKEN` | Same host and port, so the values stay as they are — set in Supabase edge **and** Railway, identical in both |
| Customer passwords | Already stored encrypted; every account holds one and auto-reconnect is enabled, so nobody is asked to type anything |
| Our data | Trades, logs, channels, history live in our database or on the broker's server. The bridge holds no business data |
| nginx and its secrets | `X-MTAPI-Key` and `X-Internal-Token` are ours, in front of the container; the licence is between us and the vendor |

---

## 2. Before the window

1. **Get the answers in writing from the vendor:** licence key format, whether
   the paid build needs MongoDB, what `MaxSessions` it allows, and whether the
   trial had a time cap.
2. **Confirm the redactor files are on hand** — `deploy/mtapi-log-redactor/`
   (`install.sh`, `entrypoint.sh`, `redact.awk`, `test.sh`). They are still
   uncommitted in some checkouts; take a copy to the VPS first. This is the
   control that stops broker passwords reaching Docker logs.
3. **Turn the maintenance banner on** (staging database, dashboard SQL — the
   agent's token is read-only):

   ```sql
   UPDATE app_settings
   SET enabled = true,
       message = 'Scheduled maintenance: the broker bridge is being upgraded. Signal copying may be paused briefly. Your trades, settings and history are safe.'
   WHERE key = 'banner_message';
   ```

4. **Record the baseline** so the "nothing is missing" check afterwards has
   something to compare against (queries in section 5).

5. **Publish every edge function from the shipping branch and check its
   freshness** — section 9. Nothing deploys them automatically, and this bit
   us twice on 2026-10-01.

---

## 3. Cutover (Contabo VPS, as root)

```bash
# from your machine: copy the redactor across
VPS_IP=13.140.44.122
scp deploy/mtapi-log-redactor/* root@${VPS_IP}:/tmp/mtapi-redactor/

# on the VPS
ssh root@${VPS_IP}
cd /tmp/mtapi-redactor
docker pull <PAID_IMAGE>                        # image name from the vendor
IMAGE=<PAID_IMAGE> bash install.sh
```

`install.sh` removes the old container, starts the new image with the redactor
entrypoint, keeps the port on `127.0.0.1:8080`, preserves the container's
environment, waits for it to settle, and refuses to report success if it
restarts.

If the paid build needs extra environment — a licence key or a MongoDB
connection string — pass one per run:

```bash
IMAGE=<PAID_IMAGE> EXTRA_ENV='MTAPI_LICENCE=...' bash install.sh
IMAGE=<PAID_IMAGE> EXTRA_ENV='MongoDB=mongodb://user:pass@mtapi-mongo:27017/mtapi' NETWORK=mtapi-net bash install.sh
```

Each run keeps the environment already on the container, so keys accumulate
instead of replacing each other.

---

## 4. Verify on the VPS

```bash
docker inspect mtapi --format '{{json .HostConfig.PortBindings}}'   # HostIp must be 127.0.0.1
curl -s http://127.0.0.1:8080/health                                # answers locally
curl -s https://mtapi.tscopier.ai:9443/health                       # answers through nginx
docker logs mtapi 2>&1 | grep -E "password|\('[0-9]+'" | head       # second field must be [REDACTED]
```

Wipe anything written before the swap — old log files still hold plaintext:

```bash
CID=$(docker inspect mtapi --format '{{.Id}}')
truncate -s 0 "/var/lib/docker/containers/${CID}/${CID}-json.log"
```

If the port ever has to be closed: **do not use `ufw deny 8080`** — Docker
published ports bypass UFW. The bind to `127.0.0.1` is the protection.

---

## 5. Verify on our side

### 5.1 Secrets still present (values must not have changed)

```bash
supabase secrets list --project-ref axdcledcyhyvzrnfkwat
```
Expect digests for `BROKER_CREDENTIALS_ENCRYPTION_KEY`, `MTAPI_BASE_URL`,
`MTAPI_API_KEY`, `MTAPI_INTERNAL_TOKEN`. The Railway worker side cannot be read
through the API — check those in the Railway dashboard. If the endpoint ever
changes, the three values must be updated in **both** places, identical.

### 5.2 Every account reconnects by itself

Watch the worker logs for `health recovery failed`. Accounts hold an encrypted
password and auto-reconnect is enabled, so no customer is asked for anything.
Anything still disconnected after a few minutes needs a manual Reconnect —
which now opens the two-stage dialog.

### 5.3 Nothing went missing

Run these before the cutover, then again after, and compare every number:

```sql
SELECT
  (SELECT count(*) FROM trades) AS trades,
  (SELECT count(*) FROM trade_execution_logs) AS trade_execution_logs,
  (SELECT count(*) FROM trade_channel_attributions) AS channel_attributions,
  (SELECT count(*) FROM broker_accounts) AS broker_accounts,
  (SELECT count(*) FROM broker_channel_trading_configs) AS channel_configs;

SELECT broker_account_id, status, count(*) AS n
FROM trades GROUP BY 1, 2 ORDER BY 1, 2;

SELECT id, label, platform, provider, is_active, copier_mode, account_login,
       broker_server, signal_channel_ids, default_lot_size
FROM broker_accounts ORDER BY created_at;
```

Everything must be identical except the connection columns
(`provider`, `mtapi_status`, `mtapi_session_id`, `broker_password_encrypted`,
`auto_reconnect_enabled`).

Broker-side closed history is not in our database: open the Trades page on one
account before the cutover and compare it afterwards.

### 5.4 Conformance re-check

Run the 13 steps from `docs/mtapi-conformance-sanitized.md` against the paid
build — connect, account summary, open, modify, close, verify. Behaviour can
differ between trial and licensed builds; this suite is what caught the
token-quote wrapping bug originally. Needs a broker login, so it is done by
hand.

### 5.5 Turn the banner off

```sql
UPDATE app_settings SET enabled = false WHERE key = 'banner_message';
```

---

## 6. Rollback

The trial image is still on the server. To go back:

```bash
cd /tmp/mtapi-redactor
IMAGE=timurila/mt5rest bash install.sh
```

Same procedure, same redactor, same verification. Nothing in our database
depends on which image is running.

---

## 7. Who runs what

| Step | Owner |
|------|-------|
| Vendor answers, image pull, `install.sh`, VPS verification | VPS operator |
| Banner SQL on / off | Anyone with dashboard access |
| Secrets check, reconnect watch, baseline diff | Agent (read-only queries) |
| Conformance re-check | Together — needs a broker login |
| Record the result in `docs/PROJECT_MEMORY.md` | Agent, after the cutover |

---

## 8. After the cutover

1. Record it in `docs/PROJECT_MEMORY.md` with both halves: plain English for a
   non-technical reader, and the technical root cause/detail for the next
   engineer.
2. Then — and only then — start switching real accounts. The paid build is what
   makes session recovery reliable enough for customers' money to be moving.

---

## 9. Edge functions — publish and verify (production gate)

**Nothing in this project deploys edge functions automatically.** CI contains
only `docs-ci.yml` and `worker-ci.yml`; Netlify builds the frontend; Railway
deploys the worker. A function changes only when someone runs
`supabase functions deploy <name>` — and that command uploads the files on
disk, **not git HEAD**, so running it from an out-of-date folder silently
publishes old code.

Two incidents on 2026-10-01 (full detail in `docs/PROJECT_MEMORY.md`):

- staging `fxsocket-broker` was last published 2026-07-24 while git kept
  changing it through 2026-09-22 — its reconnect fix reached production the
  day it landed but never reached staging;
- staging `mtapi-broker` was published 2026-09-30 from an out-of-date checkout
  and was missing code written nine days earlier. Customer-visible symptom:
  `Unknown action: reconnect`.

### Before any production wave

1. From a **clean checkout of the shipping branch**, publish everything in one
   pass:

   ```bash
   npx supabase functions deploy --use-api --project-ref <prod-ref>
   ```

2. Verify freshness — for every function, the server timestamp must be at or
   after the last git change to its directory:

   ```bash
   npx supabase functions list --project-ref <prod-ref>
   git log -1 --format=%ci -- supabase/functions/<name>
   ```

   Known stale on production as of 2026-10-01: `execute-trade` (2026-07-13).

3. Resolve the orphan: `trade-pipeline-explainer` exists only on the server
   (no copy anywhere in git history) — recover it into the repo or retire it.

4. Record what was published, with timestamps, in `docs/PROJECT_MEMORY.md`.

### To stop this recurring

- a `deploy:functions` npm script that publishes all functions from the repo
  root (as done manually on 2026-10-01: 43 functions to staging);
- a drift check in CI that fails when a function's last git change is newer
  than its server deploy (compare `functions list` against `git log` per
  function directory).
