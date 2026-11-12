# Duplicate-Trade & Stale-Trade Protections — Audit — 2026-11-11

## Executive summary

Core protections exist and most are intact: message-level dedupe, per-(signal, broker) dispatch claim, trades ticket idempotency index, sweep/replay age windows. Nothing recent removed a guard — the last claim-related changes *strengthened* the system (unconditional claim on revision path, duplicate-telegram-message drop).

Four real weaknesses found:

1. **The in-code staleness gate (`signalTooOldForReplay`) is effectively dead** — every dispatch entry point passes `liveDispatch: true`, exempting the check. Only SQL query windows bound age, and the **Redis queue path has no age bound at all**.
2. **Retry paths deliberately delete the durable dispatch claim** for *all* brokers before re-dispatching, no lease/staleness check — protection then rests on a non-atomic materialization re-check.
3. **Claim lease renewal only starts at OrderSend** — slow preparation (>120 s) can expire the lease while a second dispatcher takes over.
4. **Virtual/layering pending-leg claim re-opens after 30 s while OrderSend can take up to 90 s** — double-fire window for range rungs.

## Protection status table

| # | Protection | Primary location | Status | Finding |
|---|---|---|---|---|
| 1 | `ensureSignalRow` ingest dedupe + non-executable stub | `ensureSignalRow.ts:74-146` | **Intact** (minor hole) | Duplicate → `status='skipped'` stub; hole only if owner lookup throws (swallowed, `:176-178`) |
| 2 | `signal_broker_dispatch_claims` | `signalBrokerDispatchClaim.ts:107-148` | **Intact, weakened by deliberate releases** | Taken on every non-amend entry; deleted by retries, empty-plan skip, range defer/wake; renew only during OrderSend |
| 3 | trades ticket idempotency (DB) | `20260805000000_trades_idempotency_guard.sql` | **Intact** | unique `(broker_account_id, metaapi_order_id)` ≥2026-08-05; blocks duplicate rows, not duplicate orders |
| 4 | light config cache epoch/stale-fill guard | `lightConfigCache.ts:343-348,387-392` | **Intact** | disabled by default; never caches claims/idempotency |
| 5 | in-process duplicate dispatch guard | `dispatch.ts:233,485-489,552-568` | **Intact** (per-process only) | inflight/queuedIds/claimSignalExecution |
| 6 | age/staleness gate pre-execution | `dispatch.ts:606` + `types.ts:197-200` | **Weakened / bypassed** | skipped whenever `liveDispatch:true` (all accept paths); **queue path has no age check** |
| 7 | sweep age window | `TradeExecutor.ts:715-725` | **Intact** | `created_at >= now − EXECUTOR_REPLAY_MAX_AGE_MS` (5 min) |
| 8 | listener message dedupe (redelivery) | `userListener.ts:2842-2872,3206-3230` | **Intact** | DB count + in-memory pre-parse claim + unique index + stub drop |
| 9 | content de-duplication (intentional reposts) | none | **Absent by decision** | declined 2026-10-02 (`PROJECT_MEMORY.md:1153-1161`) |
| 10 | retry paths | `retrySignal.ts:130-156`, `retryActivity.ts:43-69` | **Bypassed by design** | deletes ALL claims; age+proven exempt for these sources; retryActivity can reset `executed`→`parsed` (`:62`) |
| 11 | replay paths | `brokerSignalReplay.ts:29-55`, `listenerSignalReplay.ts:42-89` | **Intact** | age-windowed SQL; listener replay also skips proven; broker replay relies on claim |
| 12 | backtestSync | `backtestSync.ts:66-84` | **N/A — no execution** | writes `backtest_channel_signals` only |
| 13 | social copy execution | `socialCopyMonitor.ts:464-558,654-681` | **Intact** | subscription lease RPC + mapping/event uniques; uncertain blocks auto-retry |
| 14 | mirror copy execution | `mirrorCopyMonitor.ts:1047-1100` + `20261018170000:111` | **Intact** | lease claim + unique (link_id, source_ticket) + unique (link_id, idempotency_key) |
| 15 | edge social-copy-reconcile | `functions/social-copy-reconcile/index.ts:288,520,544` | **Intact** | same claim pattern |
| 16 | perAccountConcurrency | `perAccountConcurrency.ts:19-70` | **Intact but not a dedupe guard** | bounds concurrency (default 3–4); serializes, does not deduplicate |
| 17 | openTradeReconcile | `openTradeReconcile.ts` | **Intact** | closes rows only; inserts nothing |
| 18 | orphanPositionMonitor adoption | `orphanPositionMonitor.ts:567-585` | **Intact** | adopts existing broker positions (no OrderSend); relies on trades unique index |
| 19 | signalExecutionEligibility | `signalExecutionEligibility.ts:22-117` | **Intact, content-only** | no age component; consulted every handleSignal (`dispatch.ts:726-733`) |
| 20 | signalExecutionProven | `signalExecutionProven.ts:9-35` | **Intact, partially bypassed** | used by sweep + non-fast handleSignal; fast paths skip (`dispatch.ts:616`) |
| 21 | copyLimitDispatch | `copyLimitDispatch.ts:14-44` | **Intact, not an age gate** | profit/risk pause per broker pre-entry |
| 22 | virtual pending leg claim | `virtualPendingMonitor.ts:187,900-911` + `rangePendingFireGuard.ts:438-527` | **Weakened** | 30 s stale reclaim vs up-to-90 s OrderSend → double-fire window; `markRangeLegFired` no status guard (`rangePendingLadderSync.ts:372-381`) |
| 23 | OrderSend retry safety | `fxsocketClient.ts:1144-1172` | **Intact** | refuses bare-timeout retries (`:1157-1158`) |
| 24 | opened-market dedup (`c2beaa55`) | `livePositionIdentity.ts`, `managementScope.ts`, … | **Pulled 2026-11-11** | see PROJECT_MEMORY entry for the test-fake interplay |

## Bypass mechanisms (ranked, with evidence)

1. **Queue path has no staleness gate** — `signalQueueConsumer.ts:336` → `acceptDispatchSignalAwait` → `TradeExecutor.ts:966-972` passes `liveDispatch:true` → `dispatch.ts:606` gate skipped; no `created_at` window at publish/consume/reclaim (`signalQueuePublisher.ts`, `signalQueueConsumer.ts:190-205`); `enqueued_at` metrics-only. Stale execution after outage/DLQ/reclaim (max attempts 5, `signalQueueConfig.ts:58`).
2. **Retry deletes all dispatch claims, lease-unaware** — `retrySignal.ts:136-143`, `retryActivity.ts:49-56` (+ status rollback `:62`); age/proven exemptions `dispatch.ts:606,616`; backstop = non-atomic re-check `entryPrepare.ts:898-907` (misses OrderSend-succeeded-but-log-failed).
3. **Claim lease renew only wraps OrderSend** — claim `TradeExecutor.ts:1638`, renew `orderLegExecution.ts:273-278`, lease 120 s (`signalBrokerDispatchClaim.ts:8-11`) → slow prepare → stale takeover double-send.
4. **Range wake deletes any claim unconditionally, even fresh** — `TradeExecutor.ts:1634-1636`.
5. **Virtual pending: 30 s stale reclaim vs 90 s send timeout** — `virtualPendingMonitor.ts:187` (`STALE_CLAIM_AFTER_MS=30_000`) vs `fxsocketClient.ts:1196`; reset-to-pending `rangePendingFireGuard.ts:514-525`.
6. **In-code age gate dead on accept paths** — `dispatch.ts:606` vs `TradeExecutor.ts:885,894,967` (blame 2026-05/06 — old, not regression).
7. **Queue idempotency fails open on non-unique DB errors** — `signalQueueIdempotency.ts:50-57` (`return true`).
8. **Intentional reposts (new message ids)** — no content dedupe by decision.
9. **Projector re-projection can reset `signals.status` to `parsed`** — `channelSignalProjector.ts:82-99` re-arms sweep (claim/proven still guard execution).
10. **Management actions have no durable per-signal claim** — `dispatch.ts:901-928` (by design); cross-process safety = sharding + queue idempotency.

## Env flags affecting protections

| Flag | Default | Effect |
|---|---|---|
| `EXECUTOR_REPLAY_MAX_AGE_MS` | 300000 (clamp 60000–1800000) | sweep/replay age window; raising widens stale surface |
| `SIGNAL_DISPATCH_CLAIM_LEASE_MS` | 120000 (floor 30000) | shorter = more stale takeovers |
| `LIGHT_CONFIG_CACHE_ENABLED` | `false` | config cache only |
| `TRADE_SIGNAL_QUEUE_ENABLED` | on if Redis configured | the no-age lane |
| `TRADE_DISPATCH_AWAIT_DEFAULT` | `false` | |
| `WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES` | `true` | `false` disables listener-live gate |
| `TELEGRAM_CATCHUP_MAX_AGE_MINUTES` | 20 | catch-up age cap |
| `MGMT_SWEEP_REDISPATCH_MIN_MS/_MAX` | 10000 / 5 | |
| `MT_ORDERSEND_MAX_ATTEMPTS` | 3 | timeouts excluded |
| `OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY` | `true` | `false` = mass-close risk |
| `WORKER_ORPHAN_POSITION_SWEEP` | on | orphan adoption |

No flag disables ensureSignalRow, the dispatch claim, or the trades unique index; the claim fails closed on DB errors.

## Did a recent change weaken anything?

**No recent weakening found.** History: `26e09770` made the revision claim unconditional (fixes 75-position incident); `00674674` added deliberate claim releases (incident `30ec1794`); `d70c5471` added duplicate-telegram-message drop (strengthening). `liveDispatch:true` age exemption is old (2026-05/06). Long-standing tensions: 30 s leg-claim reclaim vs 90 s send; renew starting only at OrderSend; global claim deletion on retry.

## Bottom line

Duplicates are prevented by three stacked layers (message-id dedupe at ingest, (signal,broker) claim at execution, materialization re-check before OrderSend) + the trades ticket index. Realistic production duplicate vectors: (a) retry flows erasing claims mid-send, (b) range/layering leg 30 s reclaim, (c) intentional channel reposts (declined fix), (d) cross-process management dispatches on misconfigured sharding. Realistic stale vector: (a) Redis queue with no age window, then (b) long-outage backlog reaching a path that skips `signalTooOldForReplay`.
