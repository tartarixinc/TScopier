# Incident — listener update-loop timeout storm and unplanned restart

**Date:** 2026-09-29 (detected 20:57 UTC; report written 2026-09-30)
**Component:** worker listener (Telegram MTProto client), Railway production
**Severity:** High — fleet-wide listener instability
**Status:** Fixed (code complete on a local branch; not yet committed or deployed)
**Scratchpad:** `docs/scratchpads/scratchpad-prod-listener-crash-2026-09-29.md`

## Executive summary (plain English)

The copier keeps a permanent connection to Telegram for every user. That connection
has a small background routine that pings Telegram to keep the line alive. When a
ping fails, Telegram's own library prints an error and — because we had disconnected
the connection but never fully torn it down — that background routine kept running
against a dead line, forever, for every connection we had ever used. In production
this produced hundreds of error stacks per minute (about 10–15% of all log output)
for at least four days.

On 29 September at 20:57 UTC a large group of users' connections failed at the same
moment. 43 sessions tried to reconnect within a single second, the log service hit
its rate limit and started dropping messages, and the worker container restarted
about four minutes later (21:01–21:04 UTC). It was not a code deployment — the last
deployment had been 10.6 hours earlier.

For users this meant a window (up to roughly two hours of stale activity before the
storm, and a few minutes of downtime around the restart) in which copied trades may
have been delayed. After the restart the listener came back and was dispatching
signals again at 22:03–22:09 UTC. One user's Telegram session was permanently dead
and could not be repaired by reconnecting; that user must re-link Telegram.

The fix does four things: it tears down dead connections properly instead of leaving
background ping routines running, it reacts to every ping timeout (the old code
ignored them in exactly the situation where they matter), it spaces out reconnects
so sessions do not all reconnect in the same millisecond, and it stops trying to
reconnect forever when Telegram has revoked the login key — instead it tells the user
to re-link.

## 1. Issue encountered

From the Railway production logs (Listener service):

- **Chronic noise:** `Error: TIMEOUT` produced by the Telegram library's update loop
  (`telegram/client/updates.js`) appears in every sampled window for at least four
  days — 263 lines / 2 min on 09-25 12:00, 1 011 on 09-28 00:00, 797 at 09-29 20:55,
  **935 / 10 min** at 22:05. That is roughly **10–15% of all log lines**, and the
  worker produced **zero** of its own "requesting reconnect" lines alongside them.
- **The storm (20:57:45–20:58:14 UTC):**
  - 43 unique sessions logged `_updateLoop TIMEOUT … requesting reconnect` in the
    second 20:57:45 (291 lines), then 43 `connect_start` events at 20:57:49 with
    `source=update_loop_timeout`, connection generations 2–10 (churn had already
    been running for hours).
  - 138 raw `Error: TIMEOUT` stacks burst at 20:58:00.016–.207.
  - Railway's 500 logs/second cap was hit six times; 66 + 2 192 messages were
    dropped, so the export is ragged and the event looks worse than the data proves.
- **Fleet staleness before the storm:** at 20:57:49 the largest `lastEventAgeMs`
  values were 7 579 s (2.1 h), 2 601 s, 2 202 s, 517 s, 353 s, 321 s — sessions were
  already going quiet for hours before the window we can see.
- **Restart:** at 21:01–21:04 UTC, 46 sessions logged `connect_start` with
  `source=initial` and `uptimeMs` reset to ~60 160 ms, i.e. the container/process
  restarted around 21:00–21:01. The last deployment was **2026-09-29T10:19:08Z**
  (10.6 hours earlier), so this was not deploy-triggered. The exit reason is
  unavailable — the Railway token in use cannot read `metrics` or `deploymentLogs`.
- **One permanently dead session:** user `b8cc4467-8f1a-4a69-ba5b-7cc750c529d2`
  logged `401 AUTH_KEY_UNREGISTERED` (415 lines / 10 min) on four channels; the
  watchdog reconnected it every ~30 s forever, because reconnecting cannot repair a
  revoked login key.
- **Not the usual suspects:** zero `flood wait`, zero `AUTH_KEY_DUPLICATED` in the
  window, so this was neither the July 2026 flood-wait storm nor duplicate sessions.
- **After the restart:** `[userListener] dispatch signal` occurred at 22:03, 22:06,
  22:06 and 22:09 with 46 sessions heartbeating `connected=true`.

## 2. Affected user(s)

| Scope | Who | What they experienced | Database state |
|---|---|---|---|
| Storm window | 43 sessions (13 distinct users at 20:57:45) | connections dropped and reconnected inside one second; copying paused while they recovered | listeners recovered after the restart |
| Fleet-wide | all sessions on the Listener service | hours of growing staleness before the storm (up to 2.1 h), then ~3–5 min of downtime around 21:01–21:04 | recovered; 46 sessions `connected=true` by 22:09 |
| Permanent | `b8cc4467-8f1a-4a69-ba5b-7cc750c529d2` | no copying until the user re-links Telegram | `401 AUTH_KEY_UNREGISTERED`, 415 lines / 10 min |

Honest limit: we could **not** prove that any specific user missed a copied trade.
Signal dispatch was observed after the restart, but log volume in the window was too
low (and partly dropped by the log rate cap) to demonstrate per-session delivery.

## 3. Root cause

1. **Orphaned background ping loops.** The Telegram library's update loop runs
   `while (!client._destroyed)` and only exits when `destroy()` has been called.
   `disconnect()` does not set that flag and does not stop the loop (verified in
   `worker/node_modules/telegram/client/updates.js` and `telegramBaseClient.js`).
   The worker only ever called `disconnect()` — in `stop()`, in `forceReconnect()`
   and in the recovery paths — and **never** called `destroy()`. The library's own
   fallback step (`client._sender.reconnect()`) was patched to a no-op by
   `buildClient()` whenever `autoReconnect: false`, so the loop could not recover
   either. Every client that had ever been connected therefore kept pinging a dead
   socket for the life of the process and printed ~2 stacks/minute each (backtest
   runs were hit hardest: 560 stacks / 10 min, listener 375 / 10 min).
2. **The timeout handler was skipped in the exact situation it exists for.** The
   handler was guarded with `msg.includes('TIMEOUT') && this.isConnected`. When a
   connection stalls, `isConnected` is already `false`, so the guard was false: no
   reconnect was requested and nothing was logged by us — only the library's raw
   stack. This guard was introduced by commit `4a0febe06` (2026-07-28), replacing
   the correct guard added on 2026-07-24 (`docs/PROJECT_MEMORY.md:2069`), and the
   `await` on the reconnect was dropped at the same time, so the recovery raced the
   still-running ping loop.
3. **Simultaneous failure → stampede.** When many sessions lost their connection in
   the same second, all 43 requested a reconnect at once with a fixed delay and no
   jitter, produced 291 log lines in one second and saturated the log pipeline
   (500/s cap).
4. **A revoked key is unrecoverable.** `401 AUTH_KEY_UNREGISTERED` cannot be fixed
   by reconnecting, so the watchdog retried every ~30 s forever, without telling the
   user anything actionable.
5. **What actually restarted the container at ~21:01Z remains unknown** — no
   deployment was in progress and the token cannot read exit metrics.

## 4. The fix

1. **React to every update-loop timeout.** The handler now recognises the ping
   timeout by message alone (no `isConnected` guard) and **awaits** the full
   reconnect cycle, so the ping loop and the recovery no longer race.
2. **Tear connections down properly.** `destroy()` is now called on a listener's
   client when it stops and when a recovery replaces it (with a bounded
   `disconnect()` fallback if `destroy()` fails), and ephemeral backtest clients are
   destroyed in a `finally`. Reconnecting is still done on the same client object
   when it will be reused, because the library starts its update loop only once per
   client — destroying a client we are about to reuse would kill it permanently.
3. **Space out reconnects.** The reconnect delay now carries a random jitter
   (`TELEGRAM_RECONNECT_JITTER_MAX_MS`, default 2000 ms, clamped to 0–30 000), so a
   mass failure spreads across a second or two instead of landing in one tick.
4. **Stop retrying a revoked key.** A `sessionRevoked` flag is set the moment
   Telegram reports the key as unregistered — from the watchdog, from a reconnect
   cycle or from a duplicated-key recovery. It short-circuits every reconnect path,
   destroys the client, keeps the lease without the hard-reset cycle that made the
   re-link banner flicker, and writes `telegram_account_status = reconnect_required`
   with `recovery_exhausted = true`, which is what drives the existing re-link
   banner. Callers are given a plain error ("Telegram connection expired. Reconnect
   Telegram to resume copying.") instead of a connection that silently exists.
5. **Stop the log flood.** The library's raw `Error: TIMEOUT` stacks are aggregated
   to one line per minute (both `console.log` and `console.error` are patched at
   startup, before the Sentry pipeline initialises), and `/Error: TIMEOUT\b/` was
   added to Sentry's log-noise filter. Our own actionable line
   (`[userListener] _updateLoop TIMEOUT for <user> — requesting reconnect`) is
   preserved: it does not match the pattern.
6. **Config safety.** A shared `envNumber()` helper now parses the clamped numeric
   settings (reconnect cooldown, jitter, connect timeout, auth-duplicate delays,
   healing ticks). A malformed value used to produce `NaN`, and `NaN` silently
   disables the arithmetic it sits in — a bad value in `.env` could have removed the
   cooldown or the timeout entirely. It now falls back to the documented default.

## 5. Files changed

| File | Change |
|---|---|
| `worker/src/userListener.ts` | timeout handler (no `isConnected` guard, awaited reconnect); `destroy()` on stop and on replaced clients; `sessionRevoked` flag + `noteSessionRevoked()`; sticky `sessionInvalid` health write with `allowWithoutLease`; `isSessionRevoked()`; `requestReconnect`/`requestReconnectIfDisconnected`/`runWatchdog`/`ensureTelegramConnected` gates; `forceReconnect` abandons a cycle that learned the key was revoked mid-flight; duplicated-key recovery stops and reports the re-link error; reconnect cooldown/jitter helpers |
| `worker/src/sessionManager.ts` | lease renew keeps a revoked listener parked (no hard reset, no per-tick log) and skips the "listener quiet" warning; `disconnectListener()` preserves `reconnect_required` and `recovery_exhausted` instead of hard-coding `linked`; bounded `destroy()` when adopting a client fails; numeric env parsers routed through `envNumber()` |
| `worker/src/backtestSync.ts` | ephemeral Telegram client destroyed in `finally` (bounded fallback) |
| `worker/src/telegramClient.ts` | `isSessionInvalid()` — recognises both shapes of a revoked key |
| `worker/src/gramjsLogSuppress.ts` | patches `console.error` as well as `console.log`; `isGramjsUpdateLoopTimeout()`; 60-second aggregation line routed through the live logger |
| `worker/src/observability/sentry.ts` | `/Error: TIMEOUT\b/` added to `DEFAULT_LOG_NOISE_PATTERNS` |
| `worker/src/authKeyDuplicatedRecovery.ts` | reconnect delay / max attempts / deferred retry parsed with `envNumber()` |
| `worker/src/envNumber.ts` | **new** — shared clamped numeric env parser (falls back on `NaN`) |
| `worker/src/userListener.updateLoopRecovery.test.ts` | **new** — 16 regression tests |
| `worker/src/sessionManager.revokedHealth.test.ts` | **new** — 3 tests pinning the health writes on stop and the parked-renew behaviour |
| `worker/src/sessionManager.shutdown.test.ts` | fast-recovery fixture pins the jitter env so the recovery test stays deterministic |
| `worker/src/index.ts` | comment updated for the `console.error` patch |
| `worker/.env.example` | `TELEGRAM_RECONNECT_JITTER_MAX_MS` documented |

## 6. Verification

- `npm --prefix worker run build` (TypeScript) — clean.
- `npx eslint` over every changed file — clean.
- Targeted suites: `userListener.updateLoopRecovery` + `authKeyDuplicatedRecovery` +
  `copierHealth` + `observability/sentry` = **92/92 pass**;
  `sessionManager.shutdown` + `sessionManager.realtime` = **20/20 pass**.
- Full worker suite: **1980 tests, 1980 pass, 0 failures** after the final edits
  (1977 existing + the 3 new health-write tests). The previous revision ran
  1976/1977; its single failure was the jitter test's own upper bound, since
  replaced by a deterministic assertion.
- Two review passes were run by the `code-review` subagent. The first found 1 HIGH
  and 5 MEDIUM; the second found 2 HIGH (one was already fixed, one was the flaky
  test) plus MEDIUM/LOW items — all addressed and re-verified above.
- No test or lint output indicates a regression in the signal pipeline, and no
  database or broker call was changed in behaviour other than the health columns
  named above.

## 7. Deployment status

- **Branch:** `fix/listener-updateloop-recovery` (from `origin/staging`), squashed
  into one commit and pushed to **`origin/staging` and `upstream/staging`** on
  2026-09-30. Railway redeploys the staging Listener/Trade services from `staging`.
- **Not yet in production.** `main` is untouched; promote to production only after
  the staging worker has been validated in the Railway logs (watch for the absence
  of raw `Error: TIMEOUT` stacks and for `reconnect_required` rows behaving).
- Local-only extras in the same working tree (not part of this incident):
  `scripts/railway-logs.py` and the `railway-logs` skill used to read the logs.

## 8. Follow-ups

1. **Log export limits:** the Railway token used for the investigation cannot read
   `metrics` or `deploymentLogs`, so the 21:01Z restart has no exit reason. A
   broader read-only token (or the Railway dashboard) is needed to close this.
2. **Separate defect found during the investigation:** the per-channel config heal
   path fails with `null value in column "copy_limit_state"` (32 occurrences /
   10 min, 8 distinct channels) — it silently defeats "heal missing config from
   defaults". Not fixed here.
3. **Separate defect found during the investigation:** two broker accounts
   (`48b2cdfa-…`, `87383068-…`) are offline in FxSocket, producing 104 quote failures
   each per 10 min, 498 + 335 deferred ghost closes, and 322 `OrderModify` retries
   against one permanently rejected ticket with no backoff. Not fixed here.
4. **Alerting:** consider an alert on the aggregated update-loop timeout rate (now
   one line per minute) so a recurrence is visible before it becomes a storm.
