# MTAPI order-timeout & stuck-trade remediation plan (2026-10-05)

Companion to `docs/incidents/incident-2026-10-05-mtapi-ordersend-timeout.{md,html,pdf}` and
`docs/scratchpads/scratchpad-mtapi-ordersend-timeout-2026-10-05.md`.

## Goal
Make the copier deterministic end to end: no self-inflicted bridge load, no order
outcome left "ambiguous", and no open trade that can be neither managed nor closed.
Peoples' money must never sit in an unmanaged/unknown state.

## CONFIRMED ROOT CAUSE (proven 2026-10-05, read-only diagnostic)

`MtapiProvider.request()` only JSON-parsed bodies starting with `{` or `[`. The MTAPI
bridge content-negotiates: with the worker's `Accept: application/json` it returns
`CheckConnect` as the JSON string `"OK"` (quotes included, `content-type: application/json`).
The worker left that as the literal `"OK"`, so `checkConnect` threw
`INVALID_RESPONSE` for **every** account.

Consequences:
1. `reconcileOpenTradesForBroker`'s health probe never passed, so it **never closed a
   flat account's stale trades** — the double-snapshot + "session healthy" close path
   was unreachable. That is the real (and chronic) source of `OPEN_TRADE_RECONCILE_FAILED`
   and of the stuck open rows.
2. `autoManagementMonitor` (400 ms tick) could not resolve those rows and hot-looped,
   flooding the bridge → `OrderSendSafe` exceeded its 20 s timeout → the "ambiguous"
   order alert.

Also: 18 open auto-BE rows have `broker_account_id = NULL` (orphaned, 2026-08-25 →
2026-09-06, one user) and can never be managed; they kept the monitor's work set true.

**Diagnostic result (35 open auto-BE trades):** 17 confirmed **CLOSED** by broker history
(ticket/comment match); 18 orphaned (`broker_account_id` null); 0 genuinely ambiguous.
Proven directly: `CheckConnect → "OK"`, `OpenedOrders → []` for the affected accounts.

**Fix:** parse JSON by content-type (incl. scalars) in `request()` + tolerant
`checkConnect`; exclude `broker_account_id IS NULL` from the auto-BE monitor work set.
With the health probe fixed, reconciliation's existing safe close (empty snapshot twice
+ healthy session) resolves the 17 stale rows. The deterministic comment key and the
heuristic-identity concerns remain good hygiene but are not required for this incident.

## The real defect (audited)
`resolveCanonicalOpenPosition` (`worker/src/livePositionIdentity.ts`) matches a stored
trade to a live position in this order:
1. exact ticket identity (`identities.has(storedTicket)`), then
2. fuzzy attributes: symbol + direction + lots (±0.001/5%) + entry (±0.002 / 0.00001×entry).

Baskets and range/layered entries place **many positions with identical symbol, direction,
lots and entry**. Exact-ticket matching fails when the stored `metaapi_order_id` no longer
equals the broker's canonical ticket (MTAPI cutover), so matching falls through to fuzzy
attributes, which then match **multiple** positions → `status: 'ambiguous'`.

`reconcileOpenTradesForBroker` (`worker/src/openTradeReconcile.ts`) **defers** ambiguous
trades (logs, returns) and never closes them. `autoManagementMonitor` keeps them in its
work set and retries every 400 ms. That is the storm. The 15 stuck trades are exactly this:
10× `XAUUSD.s` opened in the same second on `ffcd3493`, 4× `BTCUSDm` on `d66cdbb8`.

## What makes a trade "inconclusive" (exhaustive)
1. **Multiple identical live positions** → fuzzy attributes match >1 → `ambiguous`
   (the main case here: baskets/range legs).
2. **Ticket identity mismatch** after the MTAPI cutover (canonical vs stored ticket).
3. **Position genuinely closed** but the row is still `open` (`missing` both passes) —
   reconcilable only if the snapshot is complete and the session is healthy.
4. **Closed-history gap** — the close is outside the fetched `ClosedOrders`/`OrderHistory`
   window/pagination, so "not live and not closed" is a *data* gap, not a fact.
5. **Read failure / incomplete snapshot** (`OpenedOrders` empty or partial) — must never be
   read as "closed".
6. **Partial fills / lot changes / half-close** make stored `lot_size` differ from live.
7. **Symbol suffix drift** (`.s`/`.m`/`.c`) or entry slippage exceeding the tolerance.
8. **Stored ticket maps to >1 live position** (`identityMatches` distinct >1).
9. **Row has no `broker_account_id`** — the reconcile monitor filters those out, so they are
   never reconciled at all.

Root cause of almost all of them: **identity is heuristic, not explicit.**

## The fix: deterministic identity, then reconcile from authority
1. **Give every position a unique client key** in the order comment (already
   `TScopier:ch:<signalId>`; make it per-leg, e.g. embed the trade/intent id) and persist the
   mapping `(trade.id ↔ comment ↔ broker ticket)`. Match live/closed positions by that key
   **first**, so baskets stop being ambiguous. Tickets become a fast path, not the identity.
2. **Persist the canonical ticket returned at entry** (`persistCanonicalPositionTicket`
   already exists) so exact matching survives the cutover.
3. **Resolve from authoritative broker state, never a guess:**
   - live by key/ticket → adopt, continue management;
   - in `ClosedOrders`/`OrderHistory` (wide, paginated window) by key/ticket → finalize the
     row from broker data (`status=closed`, real close price/time/profit);
   - read failure/incomplete/session not healthy → **do not conclude**; retry with backoff.
4. **Persisted terminal state** (migration) for anything still unresolved after N slow
   passes: `needs_review` — leaves the retry set, one alert, position left untouched
   (its broker SL/TP remain). No silent loop, no blind close.

## Phases
- **P0 (done, prod DB):** `listener_events` retention + prune; final `VACUUM`.
- **P1 (in progress, `fix/mtapi-rate-limit`):** monitor load reduction (cache
  `openedOrders` per account/tick) + transient-vs-unresolvable backoff; health-sweep pacing;
  nginx bridge exemption. No trade-status change.
- **P2 (money-safe, reviewed):** deterministic identity key; reconcile-by-key; persisted
  `needs_review`; run against the 15 trades; repair `OPEN_TRADE_RECONCILE_FAILED`.
- **P3 (durable):** single broker gateway (per-account rate limit, global budget, priority
  classes, circuit breaker); per-op timeouts (client > server); universal idempotency keys +
  reconcile-on-unknown; SLO/rate alerts; de-duplicate alerts.

## Implementation status (branch `fix/mtapi-rate-limit`, based on `staging`)

Done (build green; targeted tests 48 passing):
- `mtapiProvider.ts`: checkConnect JSON-scalar fix (**root cause**); per-op
  `MTAPI_ORDER_TIMEOUT_MS`; 429 pre-accept retry; gateway wired into `request()`.
- `brokerGateway.ts` (new): per-account + global rate pacer, pacer-not-rejector.
- `autoManagementMonitor.ts`: `openedOrders` once per account/tick; transient vs
  unresolvable backoff + unresolvable park; `broker_account_id IS NULL` excluded.
- `mtapiSessionManager.ts`: health sweep bounded concurrency + jittered gap.
- `openTradeClassification.ts` + `diagnostics/classifyStuckTrades.ts` (new, read-only).
- Tests: brokerGateway, autoManagementMonitor, openTradeClassification, mtapiProvider,
  mtapiSessionManager.

Review fixes applied (code-review + design-review, 2026-10-05):
- Pacer wait no longer counts against the request timeout (timer armed after `acquire`).
- `orderSend` no longer resends on a client timeout (MT5 `OrderSendSafe` idempotency is
  **unproven**) and throttle-retry is opt-in (`MTAPI_ORDER_THROTTLE_RETRY`, default off).
- Partial `orderClose` (with `lots`) no longer timeout-retries (could over-close); full
  close still does (idempotent "not found").
- `orderTimeoutMs` clamped below nginx's 60s.
- Benign "not found/unknown ticket" failures now classified unresolvable; quarantine
  uses `count >=` so the park is actually reachable; per-trade failure maps evicted.
- Shared `openedOrders` snapshot now passed into identity resolution (one read/account/tick).

Ghost-close corroboration (addresses the review's mass-close risk):
- `openTradeReconcile.ts` no longer closes on an empty snapshot alone. Each candidate
  must have a positive close record — its ticket or signal comment appears in
  `OrderHistory` — via `matchClosedHistory`. Uncorroborated rows are deferred and raise a
  `GHOST_UNCONFIRMED_BY_HISTORY` review alert; a history-read failure is treated as "no
  corroboration" (defer), never as "flat". Flag:
  `OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY` (default true; `false` restores the old
  absence-only behaviour, not recommended). This can only make closing stricter, never
  looser. Tests cover corroborated close, uncorroborated defer, and flag-off.

Reconcile-on-unknown (order timeout) — implemented, default ON:
- On an order-send client timeout (v1/MTAPI), before marking it ambiguous the worker asks
  the broker (`OpenedOrders`): if the order is live -> **adopt** it (record the real ticket
  and continue as success); if a **market** order is provably absent -> **resend once**;
  otherwise (pending not visible / multiple matches / read failure) -> ambiguous. Flag
  `MTAPI_RECONCILE_ON_TIMEOUT` (default true; `false` disables). Helper
  `worker/src/tradeExecutor/reconcileUnknownSend.ts` + tests.

Not yet done (deliberately deferred / needs review):
- Universal idempotency keys (bridge-protocol dependent).
- SLO/rate alerts and de-duplicating the ambiguous vs `trade_copy_failed` alerts.
- 18 orphan-trade data cleanup (needs go-ahead).
- nginx config written locally, not deployed (untracked file).

## Env flags (all optional; sane defaults; `0` disables rate pacing)

Auto-BE retry (transient vs unresolvable):
1. `AUTO_BE_TRANSIENT_BACKOFF_MS` (1000), `AUTO_BE_TRANSIENT_BACKOFF_MAX_MS` (15000)
2. `AUTO_BE_FAILURE_BACKOFF_MS` (5000), `AUTO_BE_FAILURE_BACKOFF_MAX_MS` (300000)
3. `AUTO_BE_QUARANTINE_AFTER` (6), `AUTO_BE_QUARANTINE_MS` (1800000)
Session sweep: `MTAPI_SESSION_HEALTH_CONCURRENCY` (2), `MTAPI_SESSION_HEALTH_GAP_MS` (250)
Order/read timeouts: `MTAPI_HTTP_TIMEOUT_MS` (20000), `MTAPI_ORDER_TIMEOUT_MS` (50000)
429 retry: `MT_RATE_LIMIT_BACKOFF_MS` (1000)
Gateway (two channels so orders never queue behind background): `MTAPI_ORDER_RPS` (6),
`MTAPI_BACKGROUND_RPS` (3), `MTAPI_PER_ACCOUNT_RPS` (6) — set to `0` to disable that channel
Ghost-close corroboration: `OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY` (true),
`OPEN_TRADE_RECONCILE_HISTORY_DAYS` (30)
Order retry safety: `MTAPI_ORDER_THROTTLE_RETRY` (false; opt-in, needs proven idempotency)

No flag changes order placement, SL/TP math, or close logic.

## Expected outcome
- Bridge call rate falls from dozens/s to a few/s; 429s and >20 s latencies stop.
- No new saturation-induced `OrderSendSafe` timeouts → no ambiguous orders.
- Each of the 15 trades ends as **re-managed (live)**, **closed from broker history**, or
  **`needs_review` + one alert** — never silent, never blindly closed.
- `listener_events` stays a few hundred MB; disk healthy.

## Rollout / rollback
Staging for a full session (metrics: broker calls/min per account, BE latency, ambiguous
rate, reconcile failures) → canary on prod → expand. Every change behind an env flag and
independently revertible.
