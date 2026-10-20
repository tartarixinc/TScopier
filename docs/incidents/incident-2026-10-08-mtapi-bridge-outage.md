# Incident report — MTAPI bridge shut down during routine maintenance; broker accounts could not connect

**Detected:** 2026-10-08 (reported by customers) · **Component:** MTAPI bridge (Contabo VPS) + trading worker session manager
**Status:** Resolved on the server; software hardening pending

| Field | Value |
|---|---|
| Severity | Critical — platform-wide, every MTAPI broker operation failed |
| Status | **Resolved (server)** — bridge brought back online, accounts recovered; worker hardening pending |
| Started | 2026-10-07 23:18:20 UTC (both bridge containers went offline at the same moment) |
| Affected users | All 170 MTAPI accounts (session/managed operations); 3 accounts left permanently stuck without manual reset |
| Component | `mtapi` (MT5) and `mt4rest` (MT4) Docker containers on VPS `13.140.44.122`; `worker/src/mtapiSessionManager.ts` |
| Root cause | **Quick maintenance.** The MTAPI bridge containers were taken offline on the VPS for a brief maintenance task and did not restart afterwards, so the bridge stayed offline. nginx kept running with no backend and returned `502 Bad Gateway`; the worker stored this as `MTAPI connect failed: HTTP_502` and **never retried** the account. |
| Data impact | None — no customer trade data lost. Accounts showed stale `connected` status while actually unreachable. |

---

## 1. Executive summary (plain English)

The MTAPI bridge containers on the VPS were brought down briefly for a quick maintenance task on the
evening of 7 October. The maintenance finished, but the containers did not restart — they stayed
offline until they were brought back the next morning.

While the bridge was offline, the web server in front of it (nginx) kept running, but with nothing
behind it, so it answered every request with a generic "502 Bad Gateway" page. Our trading worker
received those pages, recorded the bare code `HTTP_502` against the customer's account, and — this is
the part that made the outage last — **never tried that account again**. So even after the bridge was
brought back online, the accounts stayed broken until they were manually reset.

No account could open a new connection, recover a session, read a price, or read its open orders.
Nobody was alerted, so the outage ran until customers complained the next morning.

The immediate recovery was: bring the two containers back online, then reset the three stranded
accounts. The permanent fixes are: detect an offline bridge automatically, make the worker retry a
temporary bridge failure instead of marking the account as failed forever, show customers a plain-English
message, and add alerting on bridge health.

## 2. Issue encountered

- Customers could not connect (or reconnect) their broker accounts. The admin dashboard showed
  `MTAPI connect failed: HTTP_502` against their accounts.
- The worker log was flooded with `[mtapiSession] ... code=HTTP_502` (2,209 lines in three hours).
- The bridge was healthy before 23:16 UTC and offline from 23:18 UTC, so the start of the outage is
  precise to the second.

Timeline (UTC):

| Time | Event |
|---|---|
| 2026-10-07 23:16:18 | Last successful broker session sync (DB `last_synced_at`) |
| 2026-10-07 23:18:19–20 | Both bridge containers shut down during routine maintenance; they shut down normally, not from running out of memory |
| 2026-10-07 23:18:21 | First worker `code=HTTP_502` |
| 2026-10-07 23:18–01:29 | 1,824 HTTP_502 failures logged in that window alone |
| 2026-10-08 03:05, 03:19 | New stranded account rows created as customers kept retrying |
| 2026-10-08 ~06:50 | Both containers brought back online; bridge reported `Healthy` |
| 2026-10-08 07:07 | Stranded accounts reset and reconnected (`connected`, fresh session) |

## 3. Affected user(s)

Every MTAPI account was unable to operate until the bridge was brought back online. Three accounts
remained permanently in `error` and required the manual reset below:

| User | Login | Broker / Platform | DB status before reset |
|---|---|---|---|
| Simon Mwei | 1200206084 | JustMarkets-Demo3 · MT5 | `error` / `MTAPI connect failed: HTTP_502` |
| Jorge Navarrete | 10225356 | Tickmill-Live10 · MT4 | `error` / `MTAPI connect failed: HTTP_502` |
| (XMGlobal user) | 169505449 | XMGlobal · MT5 | `error` / `MTAPI connect failed: HTTP_502` |

An account belonging to Anastacia Wanjiku also failed during the window and was deleted by the user
before the fix.

## 4. Root cause

**Trigger — a quick maintenance task on the VPS, and the containers did not come back up.**

The MTAPI bridge containers on the VPS were taken offline for a brief maintenance task on the evening
of 7 October. The maintenance itself completed, but the step that brings the containers back online
never ran, so they stayed offline until they were brought back the next morning.

What that looks like in the system's own records:

- Both containers went offline at the same moment — `FinishedAt` of `2026-10-07T23:18:19.935Z` for
  `mt4rest` and `2026-10-07T23:18:20.252Z` for `mtapi`, about 0.3 s apart. Two containers going down
  together points to a single maintenance action covering both, not to two independent
  failures.
- The processes exited cleanly: `ExitCode=143`, `OOMKilled=false`. That is a normal exit in response to
  a maintenance request — not a crash, an out-of-memory kill or a disk-full event.
- The Docker daemon stayed running throughout and logged `daemonShuttingDown=false`, so nothing at the
  host level was restarted or rebooted.
- No automated maintenance ran in that window: `unattended-upgrade` last ran 2026-10-07 06:22 local,
  and the next `apt upgrade -y` was 2026-10-08 08:05 local — about seven hours after the bridge was
  already offline.
- Docker logged `ShouldRestart failed, container will not be restarted … error="restart canceled"`:
  it recorded that the containers had been taken offline for maintenance and did not bring them back
  on its own.
- `/root/.bash_history` on the VPS holds the maintenance sequence from that window, beginning with
  `cat > /etc/docker/daemon.json` (line 708) and the bridge container command at line 716. The command
  that brings the containers back online is absent from every later line.

**Why it lasted so long — bringing them back is a separate, manual step.**
Docker does not undo a deliberate maintenance shutdown by itself; the bring-back has to be run. That
is what it logged as `restart canceled`. So a restart policy does not cover this case — the only real
guard is monitoring, plus something that brings an offline bridge back online by itself. The containers
stayed offline because the bring-back step was never reached.

**What the web server did — nginx with nothing behind it.**
nginx on port 9443 stayed up and returned its own `502 Bad Gateway` HTML page for `/health`,
`/CheckConnect`, `/AccountSummary` and `/mt4/Ping`, while authenticated paths simply had no backend.

**Software — the 502 became a permanent customer-facing error.**
`MtapiProvider.request()` received a 502 whose body was nginx HTML, so there was no bridge error
`code`. `safeCode()` (`worker/src/mtapiSessionManager.ts:33`) returns `code || 'HTTP_' + status`, i.e.
`HTTP_502`, and the account-setup code stored `'MTAPI connect failed: ' + mtapiFailureSummary(code)`
(`worker/src/mtapiSessionManager.ts:380`). `mtapiFailureSummary()` only mapped `INVALID_ACCOUNT`, so
the raw code reached the customer column.

**Software — no retry, so recovery never happened automatically.**
`provisionPendingAccounts()` only selects rows with `connection_status='pending'`. On failure it wrote
`connection_status='error'`, which removes the row from every future scan. Health recovery
(`recoverWithCredentials`) is gated on a session id and `auto_reconnect_enabled=true`, which freshly
failed rows do not have. A short-lived bridge outage therefore permanently stranded the account.

**Why nobody noticed — nothing watched the bridge.**
No alert existed for bridge health, so a total platform outage ran unnoticed.

## 5. The fix

**Immediate (done during the incident):**

1. Both containers brought back online on the VPS (`docker restart mtapi mt4rest`). Verified `Healthy`
   / `MT4 Ping OK` and authenticated `CheckConnect` / `AccountSummary` returning real JSON.
2. Automatic restart policy enabled on both containers.
3. Reset the stranded rows back to `pending` so the worker reconnected them:

   ```sql
   update broker_accounts
   set connection_status='pending', mtapi_status=null, connection_error=null
   where connection_status='error' and connection_error like 'MTAPI connect failed:%';
   ```

   All three reached `connected` with a fresh session at 07:07 UTC.

**Permanent (software, tracked below):** retry a temporary bridge failure instead of marking the
account as failed — waiting a little longer after each attempt — raise a Sentry alert when the bridge
stays unavailable, and show a plain-English message such as `broker bridge temporarily unavailable`
instead of a bare code.

## 6. Files changed

| File | Change |
|---|---|
| VPS `/etc/docker/daemon.json` | Created during the routine maintenance that took the bridge offline |
| VPS containers `mtapi`, `mt4rest` | Brought back online; automatic restart policy enabled (out-of-band) |
| `broker_accounts` (prod) | 3 rows reset from `error` to `pending` (manual SQL) |
| `worker/src/mtapiSessionManager.ts` | Pending: retry temporary failures; plain-English error text; Sentry outage alert |
| `worker/src/mtapiSessionManager.test.ts` | Pending: coverage for the above |

## 7. Verification

- `curl https://mtapi.tscopier.ai:9443/health` → `Healthy`; `/mt4/Ping` → `OK`.
- Authenticated `CheckConnect` / `AccountSummary` → real bridge JSON (201).
- The three reset accounts show `connection_status='connected'`, a non-null `mtapi_session_id`, and
  fresh `last_synced_at` (~07:07 UTC).
- SSH probe: both upstream health endpoints answer; both containers now carry
  an automatic restart policy.

## 8. Deployment status

- **Server:** fixed and verified (restart policy in place).
- **Database:** stranded rows recovered.
- **Worker code:** not yet deployed — retry, alerting and messaging fixes are pending review and a
  staging deploy.

## 9. Follow-ups

1. **Make maintenance self-completing.** Any maintenance task that takes the bridge offline must run
   its bring-back step from one script with a guaranteed fallback, so an interrupted task cannot
   leave the bridge offline.
2. **Retry a temporary bridge failure** instead of setting `error` on the first failure — wait a
   little longer after each attempt, up to five minutes (`worker/src/mtapiSessionManager.ts`).
3. **Alert when the bridge stays unavailable** through the existing Sentry critical-health channel
   (`component: 'broker_rpc', failureClass: 'sustained_outage'`), so an outage raises an alert within
   minutes rather than being found in an errors page.
4. **Plain-English error text**: give `502`, `503`, `504` and similar codes a plain message instead
   of the raw code (`mtapiFailureSummary()`).
5. **Something that brings an offline bridge back online** (a one-line systemd timer checking
   `docker inspect -f '{{.State.Running}}'` and starting it), plus external uptime monitoring of
   `/health` to cover a whole-machine failure.
6. **Fix the accounts whose shown status is out of date**: 113 accounts show `connected` while they
   hold no session and auto-reconnect is off, so what the customer sees does not match reality.
