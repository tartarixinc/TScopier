# Latency audit — trade MANAGEMENT & CLOSE path — 2026-11-11

**Verification gaps (cannot be resolved from the repo alone):**
- Railway custom env vars are not exposed via the GraphQL API (only `RAILWAY_*`) — documented-but-commented `.env.example` values may be set in prod and several are *slower* than code defaults.
- Live `supabase_realtime` publication contents must be read from the DB:
  `select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1;`

## 1a. Idle-gate monitors (`startMonitorLoop` in `monitorIdleGate.ts`)

| Monitor | File:line | Active | Idle | Env overrides | Notes |
|---|---|---|---|---|---|
| virtualPendingMonitor | `virtualPendingMonitor.ts:185-186` | **200 ms** | **15 000 ms** | `VIRTUAL_PENDING_TICK_MS/_IDLE_MS` | — |
| partialTpMonitor | `partialTpMonitor.ts:87-88` | **400 ms** | **15 000 ms** | `PARTIAL_TP_*` | stale-claim reaper 30 s (`:89`); dead-leg grace 30 min (`:112-114`) |
| autoManagementMonitor | `autoManagementMonitor.ts:75-76` | **400 ms** | **15 000 ms** | `AUTO_MANAGEMENT_*` | transient backoff 1→15 s; unresolvable 5 s→300 s; quarantine 30 min (`:87-99`) |
| trailingStopMonitor | `trailingStopMonitor.ts:50-51` | **400 ms** | **15 000 ms** | `TRAILING_STOP_*` | no failure backoff |
| cweCloseMonitor | `cweCloseMonitor.ts:65-66` | **400 ms** | **15 000 ms** | `CWE_CLOSE_*` | — |
| signalEntryPendingMonitor | `signalEntryPendingMonitor.ts:24-25` | **2 000 ms** | **15 000 ms** | `SIGNAL_ENTRY_PENDING_*` | docs say 400 ms — doc stale |
| signalRangeEntryMonitor | `signalRangeEntryMonitor.ts:29-30` | **1 000 ms** | **15 000 ms** | `SIGNAL_RANGE_ENTRY_*` | — |
| rangeBrokerPendingMonitor | `rangeBrokerPendingMonitor.ts:41-42` | **2 000 ms** | **15 000 ms** | `RANGE_BROKER_PENDING_*` | settle 150 ms (`:275`) |
| basketSlTpReconcileMonitor | `basketSlTpReconcileMonitor.ts:38-39` | **5 000 ms** | **15 000 ms** | `BASKET_RECONCILE_*` | **drift safety sweep 90 s** (`:79-81,111,195-196`); stale claim 120 s; batch 50 |
| openTradeReconcileMonitor | `openTradeReconcileMonitor.ts:17-18` | **30 000 ms** | **120 000 ms** | `OPEN_TRADE_RECONCILE_*` | runs at 30 s whenever any open trade exists |
| closedTradeFillMonitor | `closedTradeFillMonitor.ts:76-77` | **60 000 ms** | **300 000 ms** | `CLOSED_TRADE_*` | batch 50 |
| tradeBrokerDriftMonitor | `tradeBrokerDriftMonitor.ts:44-45` | **300 000 ms** | **900 000 ms** | `BROKER_DRIFT_*` | `hasWork` effectively always true (`:88-107`) |
| orphanPositionMonitor | `orphanPositionMonitor.ts:68-69` | **3 600 000 ms** | same | `ORPHAN_SWEEP_*` | alert TTL 6 h |
| tradeExecutor parsed-signal sweep | `types.ts:195-196` | **1 000 ms** | **15 000 ms** | `EXECUTOR_PARSED_SWEEP_MS/_IDLE_MS` | replay window 300 000 (`:197-200`) |

Interval helper clamps (`monitorIdleGate.ts:5-16`): env values clamped (active ≥500 ≤60 000; idle ≥5 000 ≤300 000); **defaults NOT clamped** — so `BROKER_DRIFT_IDLE_MS` default 900 000 is legal while an env value above 300 000 is silently reduced. `.env.example:41-43` claims the opposite. The helper's 60 000 idle default is never reached (every caller passes its own default).

## 1b. Fixed-interval monitors (not registered for wake pokes)

| Monitor | Interval | Wake |
|---|---|---|
| newsTradingMonitor (`:39,62`) | 60 000 ms | none |
| copyLimitMonitor (`:23,57`) | 30 000 ms | none |
| socialCopyMonitor (`:126,132`) | 10 000 ms (`SOCIAL_COPY_RECONCILE_MS`) | MTAPI OnOrderUpdate hub (`index.ts:221-230`) |
| mirrorCopyMonitor (`:201,211`) | 20 000 ms | same hub |
| v2ReconcileMonitor (`:49,245`) | 4 000 ms | none |
| channelReconcileMonitor (listener; `sessionManager.ts:156,184`) | 45 000 ms | has loop handle but **never passed to trackMonitor** — not poked |

Only monitors passed through `trackMonitor` (`index.ts:133-142`) are poked by `monitorWorkWake`.

## 2. Idle-aware backoff + work wake — missed-poke failure modes

Wake source: `monitorWorkWake.ts:18-44` — channel `monitor_work_wake:${pid}`, INSERT+UPDATE on
`range_pending_legs, partial_tp_legs, signal_entry_pending_orders, signal_range_entry_waits, basket_reconcile_jobs, trades, signals`.
`poke()` reschedules at 0 ms (`monitorIdleGate.ts:24-78`).

| # | Failure mode | Delay contribution |
|---|---|---|
| **F1** | **5 of 7 wake tables are never added to the `supabase_realtime` publication.** Only `signals`, `trades`, `broker_accounts`, `trade_execution_logs` are added (explicit comment required: `20260512100000_broker_metatraderapi.sql:94-115`, `20260516140000_dashboard_realtime_publication.sql:13-23`). No migration adds the other five → **no poke at all** for basket-reconcile enqueue, range-leg insert, partial-TP insert, entry-pending insert. | Up to full idle: **15 s** default, **60 s** if `*_IDLE_MS=60000` from `.env.example`, **120 s** for `BASKET_RECONCILE_IDLE_MS=120000` |
| **F2** | Wake channel has **no status callback, no health check, no resubscribe** (`channel.subscribe()` bare, `:39`). Realtime health check covers only `telegram_channels` + `telegram_auth_pending` (`sessionManager.ts:636-647`). | One channel error silently disables every monitor's wake until restart → all fall back to idle (15/30/60/900 s) |
| **F3** | Time-transitions produce no row event (`basket_reconcile_jobs.next_run_at` passing now; stale `claimed_at` crossing 30 s). | after 5 s backoff → actually 15 s (or 120 s with env.example value) |
| **F4** | Shard user cache TTL 5 min (`monitorIdleGate.ts:80-106`): new shard member invisible to `hasWorkOnShard` (`:122-138`). | up to 5 min + idle |
| **F5** | Poke mid-tick degrades to active interval | ≤400 ms |
| **F6** | Executor realtime UPDATE-only + off for split roles (`TradeExecutor.ts:572-584`, `workerConfig.ts:104-105`) | missed mgmt push → sweep 1 s / **15 s idle** |
| **F7** | `hasWork` error path fails open (`:133-136`) | none (keeps active) |

## 3. Management dispatch path

Telegram/UI → AI fallback parse (`AI_MODIFICATION_PARSE_TIMEOUT_MS` 3500, `aiParseModification.ts:73`) →
`ensureSignalRow` BEFORE dispatch (`userListener.ts:3205-3230`) → `routeDispatchToTradeWorker` (`:3267-3317`, fire-and-forget):
1) Redis `enqueueParsedSignal` (`queue/signalQueuePublisher.ts:133`) 2) HTTP push fallback (default on) 3) in-process if monolith.

| Stage | Constant | Value |
|---|---|---|
| HTTP push timeout (mgmt) | `TRADE_SIGNAL_PUSH_TIMEOUT_MS` | **5 000 ms** (entry 4 000), clamp 500–10 000 (`tradeSignalPush.ts:248-252`) |
| Push attempts/backoff | 3 × 75 ms linear | worst **≈15.4 s** before sweep fallback (`:284-319`) |
| Push semantics | mgmt `Accept` (`awaitExecution:false`) | HTTP returns on accept (`:335-343`) |
| Redis mgmt consumer block | `TRADE_SIGNAL_QUEUE_MGMT_CONSUMER_BLOCK_MS` | **150 ms** (entry 500 ms) (`signalQueueConfig.ts:55-56`) |
| Queue concurrency | default **8** | `signalQueueConfig.ts:61-71` |
| Failed-message reclaim | `TRADE_SIGNAL_QUEUE_CLAIM_IDLE_MS` 60 000, tick 20 s | failed mgmt msg retried only after **60 s** |
| DB sweep fallback | 1 000 / 15 000 ms | `TradeExecutor.sweep()` picks `parsed` ≤5 min (`:710-744`) |
| Mgmt re-dispatch guard | `MGMT_SWEEP_REDISPATCH_MIN_MS` 10 000, max 5 | ≥10 s between retries; after 5 → `mgmt_sweep_max_redispatch` (`:126-133,754-799`) |
| Replay age gate | `EXECUTOR_REPLAY_MAX_AGE_MS` 300 000 | non-live dispatches >5 min dropped (`dispatch.ts:606`) |
| Edge force-close | `force-close-trades` → worker HTTP, **no fetch timeout** | `supabase/functions/force-close-trades/index.ts:36` |
| Fast path | `shouldUseMgmtFastPath` needs mode ∈ {mgmt, all} (`tradeSignalActions.ts:27-31`) | mgmt gets liveDispatch+lightIdempotency |

Worst case if queue disabled AND push times out AND `signals` poke lost: AI 3.5 s + push 15.4 s + sweep idle 15 s ≈ **34 s**.

## 4. Sequential processing & the provider gates

Pools: `parallelPool.ts:3-15` — `mgmtLegConcurrency()` env `MGMT_LEG_CONCURRENCY` default **8** (max 16); `mgmtBasketConcurrency()` default **6** (max 16).

| Path | Parallel? | Evidence |
|---|---|---|
| channelStopApply (default `MGMT_USE_CHANNEL_STOP_APPLY=true`) | Yes (baskets 6 / legs 8) | `channelStopApply.ts:1288-1292,1239-1241` |
| legacy modify path | **serial across baskets** | `managementModifyBaskets.ts:148,225` |
| **force close (UI close-all)** | **fully serial** (channels → brokers → legs), then a **second serial pass** `tryBrokerFallbackClose` | `forceCloseSignalTrades.ts:530,281,665,728`, `:424-442` |
| broker-fallback close | brokers parallel, **orders serial** | `managementBrokerClose.ts:125,143-145` |
| autoManagementMonitor (BE) | serial per group/trade | `autoManagementMonitor.ts:314-365` |
| trailingStopMonitor | serial | `trailingStopMonitor.ts:147-171` |
| openTradeReconcileMonitor | serial per broker | `openTradeReconcileMonitor.ts:90` |
| basketSlTpReconcile jobs | serial (legs parallel inside a job) | `basketSlTpReconcileMonitor.ts:177-183,365` |
| partialTpMonitor | groups parallel, legs serial in group | `partialTpMonitor.ts:808,832` |
| newsTradingMonitor | serial | `newsTradingMonitor.ts:175` |
| managementExecutor | `legConcurrency = liveMgmtFast ? 8 : 1` | `managementExecutor.ts:1898-1914` |

**The real serialization — provider gates:** `mtapiProvider.ts:111-119` `tradeOpGate`, `MT_TRADE_OP_CONCURRENCY` **default 1** (single in-flight trade call per session) around `orderSend/orderModify/orderClose/orderCancel` (`:427,456,473,532`) — collapses leg concurrency 8 → serial per account. FxSocket uses `MT_PER_ACCOUNT_TRADE_CONCURRENCY ?? 3` (`fxsocketClient.ts:558`). **Regression: mtapi default changed 3 → 1 on 2026-10-06 (`b4dfd34d`)** while `PROJECT_MEMORY.md:1546` + `.env.example:327` still say "Default 3".

## 5. Sleeps / readback waits / retry backoffs on the close path

| Constant | Value | Where | Effect |
|---|---|---|---|
| `mgmtCloseVerifySleepMs` | `MGMT_CLOSE_VERIFY_MS ?? 0` live-fast; else 400 ms | `managementClose.ts:12-18,91-93` | 400 ms/attempt non-fast |
| empty-readback retry | 3 × 250 ms | `managementClose.ts:21-22,100-112` | up to +500 ms |
| retry gap rejected/still-open | 300 ms | `managementClose.ts:87,163` | |
| `closeWithVerification` | maxAttempts 2, slippage 50 | `managementClose.ts:53-54` | 2 × (pre-read+close+readback) |
| non-fast close loop | up to 6 orderCloses + 6 readbacks + sleeps | `managementExecutor.ts:1293-1324` | seconds per leg |
| unknown-ticket/BE retry sleep | 250/500 ms | `managementExecutor.ts:1322,1589-1591` | |
| straggler rounds | non-fast 4 rounds × 200/400/600 ms; fast 1 round ×0 | `basketSlTpReconcile.ts:1004-1011` | up to 1.2 s |
| leg modify gap | serial legs 50 ms (rebalance 120; live-fast 0) | `basketSlTpReconcile.ts:416-420,888-890` | |
| reconcile backoff | 0 → 5/10/20/40/60 s (cap 60 s) | `basketSlTpReconcile.ts:1091-1098` | only re-checked on idle cadence (F3) |
| partial-TP fired-write retry | 250 ms × attempt | `partialTpMonitor.ts:243,930` | |
| history-read transport retry | 400+rand·600 ms | `mtapiProvider.ts:318` | |
| auto-BE quarantine | 6 failures → 30 min park | `autoManagementMonitor.ts:98-99,239-247` | silent for 30 min |

## 6. Reconcile churn (stop/close writers fighting)

Writers: autoManagementMonitor (400 ms), trailingStopMonitor (400 ms), basketSlTpReconcile (job 5 s + drift sweep 90 s), channelStopApply, v2ReconcileMonitor (4 s, v1/v2 split guarded), tradeBrokerDriftMonitor (5 min, can reopen closed→open), openTradeReconcileMonitor (30 s), partial/cwe/news close paths.

- **Trailing/BE vs 90 s drift sweep:** trailing/BE write broker SL + `trades.sl` but **never** `upsertBasketSlTpTarget` (only dispatch/managementExecutor/applySignalOverride do) → sweep measures stored target vs broker → **reverts trailed/BE stop within ≤90 s**, 400 ms loop re-applies → flicker cycle. Override notifier only notifies after restore.
- **Ghost reopen vs partial-TP cleanup:** drift reopens rows (5–15 min); partialTp must wait `PARTIAL_TP_DEAD_LEG_GRACE_MS` 30 min before cancelling closed parents' legs — real close leaves pending partials for half an hour.
- **BE failure → reconcile job enqueue** (`managementExecutor.ts:1824-1874`) → more jobs into same sweeps.
- **Force-close double pass:** DB-driven close loop + `tryBrokerFallbackClose` re-read/re-close.
- autoManagement 30-min quarantine vs openTradeReconcile 30 s — two clocks on same row.

## 7. Documented intent vs actual code

| Documented | Actual | Verdict |
|---|---|---|
| Realtime pokes on work tables (`worker-deployment.md:398`) | Implemented but 5/7 tables absent from publication; no channel health/retry | **Partially missing — top regression candidate** |
| idle default 60 s | every monitor passes explicit 15 000 (30/60/300/900 s for slow ones) | doc stale (code faster) |
| interval table rows (basket 15000/120000; sweep 3000; signal entry 400 ms …) | basket 5000/15000; sweep 1000/15000; signal entry 2000; virtual 200 | doc stale; **signalEntryPending 5× slower than documented** |
| `.env.example` recommends `*_IDLE_MS=60000`, `BASKET_RECONCILE_TICK_MS=15000`, sweep idle 60 000, ticks 1500… | all commented; code defaults 2.5–4× faster | **Dangerous drift: if Railway mirrors them → reproduces "up to 30 s". MUST read Railway env.** |
| `range-pending-sweep` / `basket-sl-tp-sweep` cron backstops | **dropped 2026-06-16** (`20260616130000_drop_legacy_broker_crons.sql`), edge functions gone | **Documented safety nets removed — worker idle-gate+poke is the only wake path** |
| `MT_PER_ACCOUNT_TRADE_CONCURRENCY=3` default | mtapi reads `MT_TRADE_OP_CONCURRENCY ?? 1` (changed 3→1 2026-10-06 `b4dfd34d`); FxSocket only uses the documented one | altered/mis-documented |
| Gateway RPS (`mtapi-timeout-remediation-plan-2026-10-05.md:159-160`) | `MTAPI_ORDER_RPS` 6 / `MTAPI_BACKGROUND_RPS` 3 / `MTAPI_PER_ACCOUNT_RPS` 6 present (`brokerGateway.ts:45-47`) | present but **absent from `.env.example`** |
| `MGMT_LEG_CONCURRENCY=6 max 12` | code default 8, max 16 (`parallelPool.ts:4`) | doc stale |
| `TRADE_DISPATCH_AWAIT_DEFAULT` true on split deploy | code default `'false'` | doc wrong |
| realtime health check | covers only telegram tables; `monitor_work_wake:*`/executor signals uncovered | **missing for close-path-critical channels** |

## 8. Ranked latency sources

**A. Global MTAPI background-read pacer — 3 requests/second process-wide** ← strongest candidate for 30 s:
`brokerGateway.ts:44-77` — every MTAPI read (`openedOrders`, `quote`, `symbolParams`, `AccountSummary`, `OrderHistory`, `ConnectionStatus`) goes through the background lane at 333 ms spacing (`mtapiProvider.ts:282-296,234`). Close verify = 2 reads + 1 order/leg ≈ ≥830 ms pacing/leg before RTT. Monitors routinely demand 10–20× capacity (autoBE/trail issue ≥1 quote + 1 openedOrders per account every 400 ms, `autoManagementMonitor.ts:323,348`; trail quote every 400 ms `:157`) → queue grows unbounded in bursts → **10–40 s multi-leg close/adjust**. Added 2026-10-05 (`931347e9`) to stop bridge 429s; staging-only originally (`PROJECT_MEMORY.md:869,874`); RPS knobs not in `.env.example`. `MTAPI_BACKGROUND_RPS=0` disables the read channel (`brokerGateway.ts:41`).
**B. Global order lane** 6 starts/s process-wide (`:45,62-65`) — 20-leg close ≥3.3 s pure pacing.
**C. Per-account trade-op concurrency = 1 on MTAPI** (default changed 3→1, 2026-10-06).
**D. Force-close fully serial end-to-end** + second fallback pass — 10 legs ≈ 8–15 s, 20 legs ≈ 17–35 s.
**E. Idle interval + lost pokes (F1/F2)** — structural 15/60/120 s stalls; cron backstops removed.
**F. Reconcile backoff re-checked only on idle cadence** — 5 s backoff becomes 15–120 s; drift sweep 90 s.
**G. Dispatch fallback chain** — push 15.4 s worst + sweep 15 s idle + realtime off; AI mod parse 3.5 s.
**H. Mgmt sweep re-dispatch guard** — ≥10 s between retries of a failed close/modify.
**I. Close-verification sleeps** — 0.7–3 s/leg non-fast; 0 on live-fast.
**J. Reconcile churn** — stop flicker, re-done work, inflated pacer queues.

## Suggested verification order (read-only)
1. `select tablename from pg_publication_tables where pubname='supabase_realtime';` (F1).
2. Railway dashboard env: `MTAPI_BACKGROUND_RPS`, `MTAPI_ORDER_RPS`, `MT_TRADE_OP_CONCURRENCY`, `*_IDLE_MS`, `*_TICK_MS`, `UNIVERSAL_PARSE_MODE`.
3. Worker logs: `[monitor_work_wake]` errors; `started active=…ms idle=…ms` lines vs expectations.
4. `trade_execution_logs`: `dispatch_source` (`listener_push` vs `queue` vs `sweep`) and `enqueue_to_start_ms` on slow actions.
