# Entry-path latency audit — Unicopier worker (read-only) — 2026-11-11

## 0. Shape of the entry path (what runs where)

**Listener (inline, serial, before dispatch)** — `worker/src/userListener.ts`
1. `tListenerReceived` stamp (`userListener.ts:2805`) → reply-parent lookup (DB, only if reply, `:2821`) → `getChannelParseContext` (`:2824`, 5-min cache) → heuristic filter → **dup-count DB query** (`:2842-2847`) → in-memory dedup claim (`:2872`)
2. **Parse** via `withParseRetry` (`:2904-2926`) → `parseSignalForListener` (`:2536-2683`): deterministic inline; AI stage is **fire-and-forget in default `shadow` mode**, awaited in `fastpath`/`primary`
3. provider-number lookups (`:2991`, `:3094`) → `handlePostParseChannelIngest` (`:3150`, no-op unless `CHANNEL_LISTENER_MODE` on)
4. **`ensureSignalRow` awaited before dispatch** (`:3205-3219`) — deliberate FK-safety reversal of the old "dispatch-first"
5. `routeDispatchToTradeWorker` (`:3240`, `:3264-3308`) — **fire-and-forget**: Redis `XADD` first, HTTP push fallback; `persistSignalBackground` after (`:3247`)

**Trade worker** — `tradeExecutor/dispatch.ts::handleSignal`
`ensureSignalRow` (redundant upsert, `:525`) → in-memory claim → copier-pause gate → telegram-live + subscription/admin gates (`:632-662`) → broker match (in-memory) → copy-limit state (20 s cache) → channel meta (5 min cache) → `sendOrder` per broker in `Promise.all` (`:950-957`): channel-config fetch (DB when cache off) → dispatch-claim insert → `prepareEntryExecution` (session/symbol/params, quotes, planner) → `placeStrictSignalEntryPending` → `materializeVirtualPendingLegs` → `sendImmediateLegs` (`Promise.allSettled` over legs, `orderLegExecution.ts:995`) → post-fill DB/management **backgrounded** on live fast.

Entry actions take the **live fast path** (`dispatch.ts:110-121`, `TradeExecutor.ts:882-891`) when `liveDispatch && lightIdempotency` — true for listener push, queue, sweep, and range wake on `trade_entry`/`trade`/`all`.

---

## 1. Polling intervals / sweep loops that can delay pickup

| # | File:line | What | Value | Latency effect | Regression? |
|---|---|---|---|---|---|
| 1.1 | `userListener.ts:150-153` | Safety poll (all active channels) | `TELEGRAM_SAFETY_POLL_MS` default **10 000 ms** (5–60 s) | Channels Telegram is not pushing: avg **~5 s**, worst **10 s** to pickup. Comment at `:168` says exactly this. | Matches docs (`worker-deployment.md:366`) |
| 1.2 | `userListener.ts:170-176` | Fast poll for live-stale channels | `TELEGRAM_FAST_POLL_MS` default **3 000 ms**, stale after `TELEGRAM_FAST_POLL_LIVE_STALE_MS` **120 000 ms**, batch **6**, concurrency **4** (`:154-157`) | Speeds up dead channels; safety poll still bounds worst case | Matches docs `:367-368` |
| 1.3 | `userListener.ts:192-204` + `fastPollPacing.test.ts` | Per-channel fast-poll pacing: interval **doubles** per quiet poll, capped `TELEGRAM_FAST_POLL_MAX_CHANNEL_INTERVAL_MS` default **30 000 ms**; streak resets on `messages`/`failed` | 3 s → 6 → 12 → 24 → 30 s cap | Only affects fast poll (safety poll still 10 s). **Benign** | Intended (incident 2026-08-24 flood control) |
| 1.4 | `userListener.ts:5024-5050` | Two `setInterval` timers: safety 10 s, fast 3 s | — | Both skip entirely while `pollBackoffUntil` is armed | see 1.5 |
| 1.5 | `userListener.ts:267-286`, `:870-881`, `:928-938` | Flood-wait backoff | start **120 000 ms**, doubling to **600 000 ms**, cleared after **3** clean cycles | Under repeated FLOOD_WAIT, **poll-based pickup can stall 2–10 min** (live `NewMessage` events not gated) | Intended (`eaf85b29`, 2026-08) |
| 1.6 | `userListener.ts:148-149`, `:4548-4584` | Watchdog probe | `WATCHDOG_INTERVAL_MS` **30 000 ms**, reconnect after **2** consecutive failures | Dead gramjs socket repaired only on 30 s cadence → up to ~30 s + `TELEGRAM_CONNECT_TIMEOUT_MS` 45 s of missed live events | Known (incident 2026-09-29) |
| 1.7 | `tradeExecutor/types.ts:195-196` | Parsed-signal sweep (fallback dispatch) | `EXECUTOR_PARSED_SWEEP_MS` active **1 000 ms**, `EXECUTOR_SWEEP_IDLE_MS` **15 000 ms** | **If the Realtime work-wake poke is lost, a missed HTTP/queue push costs up to 15 s** — most plausible source of reported 7–15 s | Docs table (`worker-deployment.md:406`) says 3000/60000 — stale vs code |
| 1.8 | `monitorIdleGate.ts:24-78` | Idle-aware backoff loop: cheap `hasWork` probe, sleep idle when none; `poke()` reschedules at 0 | see 1.7 | Poke during in-flight tick degrades to active interval (1 s) | Intended (Phase 3 hybrid) |
| 1.9 | `monitorWorkWake.ts:4-44` + `index.ts:342-344` | Supabase Realtime poke on INSERT/UPDATE of `range_pending_legs, partial_tp_legs, signal_entry_pending_orders, signal_range_entry_waits, basket_reconcile_jobs, trades, signals` | — | Makes the 15 s idle harmless — but **no status callback/health/retry** on this channel: silent degradation to 15 s | Docs claim realtime pokes; present, but no failure handling |
| 1.10 | `TradeExecutor.ts:566-585` | `signals` Realtime subscription (`EXECUTOR_REALTIME_SIGNALS`) | default **false** for `trade_entry`/`trade_mgmt` (`workerConfig.ts:104-105`) | Subscribes to `event: 'UPDATE'` only; a new signal is an INSERT → never fires for fresh signals even when enabled | **Documented-vs-code gap** (`worker-deployment.md:43`) |
| 1.11 | `channelListenerManager.ts:44-52` | Channel-listener lease sync `CHANNEL_LISTENER_SYNC_MS` **30 000 ms** | — | lease bookkeeping only | benign |
| 1.12 | `userListener.ts:219`, `:3552`, `:3562-3570` | Reply-chain sweep 60 s, `SIGNAL_RECONCILE_SWEEP_MS` 60 s | | background only | benign |

## 2. `setTimeout` / sleeps / delays on the entry path

| # | File:line | What | Value | Effect | Regression? |
|---|---|---|---|---|---|
| 2.1 | `entryPrepare.ts:838-848` | **Copier Engine channel `delay_msec` sleep** | `plan.delay_ms` from `planManualOrders.ts:63`; capped 30 s | **Skipped when `liveEntryFast`** (`:839-844`); sleeps only on non-fast path | **Live-fast skip IS in effect** (verified all dispatch routes). Matches docs `:493,:506` |
| 2.3 | `userListener.ts:2904-2926` parse retry | `LISTENER_PARSE_MAX_ATTEMPTS` **3**, backoff 750×(attempt+1) ms → worst **2 250 ms** | only when parse throws | benign |
| 2.4 | `dispatch.ts:492-502` | `waitForSignalInflightClear` poll 100 ms, timeout 60 s | message-revision path only | revisions wait up to 60 s behind in-flight first entry | intended |
| 2.6 | `multiTradeMerge.ts:292-293`, `:365-371` | anchor poll 150 ms, budget 3 s | teaser/stack entries can spin up to 3 s waiting for anchor `trades` row — aggravated because on live fast the insert is backgrounded (`orderLegExecution.ts:939-981`) | entry-adjacent |
| 2.8 | `userListener.ts:145` | `COLD_FANOUT_DELAY_MS` **8 000 ms** | startup only | one-time |
| 2.9 | `userListener.ts:221-244` | `ENTRY_MESSAGE_SETTLE_MS` **10 000 ms**, delays [10 s, 30 s] | re-dispatch (revision) at +10 s/+30 s — extra load, not first-entry latency |
| 2.10 | `telegramClient.ts:43` + `:123-141` | gramjs `floodSleepThreshold` 60 s; `tgInvoke` sleeps waitSec+2 up to 90 s, 2 retries | an RPC can block 60–90 s inline | poll path only |

## 3. Dispatch mechanism — HTTP push, queue, fallbacks

| # | File:line | What | Value | Effect |
|---|---|---|---|---|
| 3.1 | `tradeSignalPush.ts:247-252` | Push timeout entry **4 000 ms**, mgmt **5 000 ms** (clamp 500–10 000) | per attempt | matches intent |
| 3.2 | `tradeSignalPush.ts:28-29`, `:284-319` | Retry 3 attempts, 75 ms linear; retryable = 5xx/429/408/network | **Worst ≈12.2 s** before `push_failed`; signal sits `parsed`, sweep recovers | intended; observable via `dispatch_push_attempt` |
| 3.3 | `tradeSignalPush.ts:323-332` | Entry push fire-and-forget | listener never blocks | good |
| 3.4 | `userListener.ts:3272-3286` | Route order: **Redis `XADD` first**, HTTP fallback if queue fails | | slow XADD delays HTTP fallback |
| 3.5 | `queue/redisStreamsClient.ts:19-44`, `:46-56` | **No AbortController/timeout on any Upstash REST call** | hung request stalls enqueue or the whole consumer read loop until TCP timeout | gap — no bound |
| 3.6 | `queue/signalQueueConfig.ts:55-56` | Consumer block entry 500 ms, mgmt 150 ms | `XREADGROUP BLOCK` returns as soon as a message arrives — not a per-message delay | harmless |
| 3.7 | `queue/signalQueueConsumer.ts:134-176` | **Head-of-line blocking**: read loop awaits whole batch (incl. full execution) before next `XREADGROUP`; concurrency 8 | one slow job (5–15 s) stalls pickup of every later queued signal | structural risk; undocumented |
| 3.8 | `signalQueueConsumer.ts:179-232`, `:426` | Failed job unacked; `XAUTOCLAIM` after 60 s idle (reclaim tick ≈20 s) | queue's own retry ≥60 s; DB sweep usually covers first | intended |
| 3.9 | `httpServer.ts:584-622` | `TRADE_DISPATCH_AWAIT_DEFAULT` code default `'false'` | entries send `await:false` | `.env.example:86-87` claims "default true" — stale |
| 3.10 | `signalQueueConfig.ts:51` | Queue auto-enables when Redis env present | a deploy adding Redis env silently moves primary dispatch onto 3.7 | operational |

## 4. Cold-start / warm-cache costs (`prep_ms`, `broker_resolve_ms`)

| # | File:line | What | Value / effect |
|---|---|---|---|
| 4.1 | **`workerConfig.ts:72-84`** | **Broker session heartbeat force-disabled**: `runsBrokerSessionHeartbeat = false` (env ignored with warning) | `TradeExecutor.start()` never installs the timer (`:260-270`). **`BROKER_SESSION_HEARTBEAT_MS` is a no-op env var.** **REGRESSION vs documented intent**: docs `:412,447,452,503` still recommend it as THE fix. Introduced `b13a3db5` 2026-08-07; docs never updated. |
| 4.2 | `brokerSymbolCache.ts:288-301` | `pingBrokerSessionInner` is a **no-network local stamp** (`void api`) | `sessionPingAt` only refreshed at dispatch time, not periodically |
| 4.3 | `types.ts:187-194` | `BROKER_SESSION_HEARTBEAT_MS` default 30 s (docs say 15 s); `SESSION_PING_MIN_INTERVAL_MS` 25 s (docs recommend 10 s) | `brokersWarmForLiveEntry` usually `true` even with no heartbeat (dispatch-time stamp) — metric misleading |
| 4.4 | `brokerSymbolCache.ts:303-316`, `TradeExecutor.ts:858-867` | `EXECUTOR_PREWARM_SYMBOLS` default true; startup prewarm + fire-and-forget on accept | cold symbol outside `symbol_to_trade` pays broker `/SymbolParams` round trip ≈ **1.5 s** (`TradeExecutor.ts:271-274`) |
| 4.5–4.6 | `types.ts:177-186`, `brokerSymbolCache.ts:351-399,504-522` | symbol cache TTL 24 h, stale 5 min (SWR), keepalive 5 min | warm symbols sub-ms; stale-while-revalidate = no stall after first fill |
| 4.7 | **`TradeExecutor.ts:1553-1568` + `lightConfigCache.ts:444-449`** | `fetchBrokerForChannelWithLightConfigCache` on every `sendOrder`; **cache disabled by default** (`LIGHT_CONFIG_CACHE_ENABLED ?? 'false'`) | with cache off: **serial DB round trip per broker before the claim** on every entry |
| 4.8 | `relayFetch.ts:21-48` | When `SUPABASE_RELAY_TOKEN` set, **every** Supabase fetch routed through VPS nginx relay | extra WAN hop on all hot-chain DB calls (dup-count, ensureSignalRow, claim…) |
| 4.9 | `index.ts:339,409-421` | liveness tick 60 s, lease renew 20 s, TTL 45 s | listener lease lapse gates execution up to 45 s during deploys; sweep retries |
| 4.10 | `sessionLease.ts:9-12` | `WORKER_LEASE_GATE_CACHE_MS` default 8 s | stale false-gate persists up to 8 s after recovery |

## 5. Serial awaits that could overlap

- `userListener.ts:2842 → 2904 → 3206`: dup-count → parse → ensureSignalRow strictly serial before dispatch (2–3 DB RTTs); deliberate (FK + dup safety); docs `:445` "POST before DB writes" stale.
- `dispatch.ts:525`: **second `ensureSignalRow`** inside prep — 1 extra DB RTT (defense in depth).
- `TradeExecutor.ts:1558 → 1638 → entryPrepare.ts:900`: channel-config fetch → claim insert → materialization probe (5 parallel count queries, `basketMerge/helpers.ts:218-254`) serial ≈3 RTTs; comment says "including live-fast" — contradicts docs `:446`.
- `entryPrepare.ts:678-698`: live fast with explicit stops: upsert + load (2 serial DB calls) before planning.
- Good: `entryPrepare.ts:305-309` session/symbol Promise.all; `orderLegExecution.ts:995` legs Promise.allSettled (but per-account gate serializes same-account legs: `fxsocketClient.ts:1144-1146` / `mtapiProvider.ts:426-427`, `MT_TRADE_OP_CONCURRENCY` default 1).
- `entryPrepare.ts:403-413,427,469,...`: up to several sequential `/Quote` calls; entry-zone guard's quote **not stored** into `strictEntryPrefetch` (`:427`).

## 6. Retry / backoff loops under normal conditions

- HTTP push: 3×4 s + 75/150 ms ≈ **12.2 s** worst (3.2).
- Queue retry via claim reclaim **60 s** (3.8).
- `fxsocketClient.ts:1144-1168` OrderSend retry 3, jitter 0.6–1.9 s; **bare timeouts NOT retried** (`:1157-1159`).
- `mtapiProvider.ts:568-633` `requestWithRetry` 3 (+throttle lane 6 × up-to-12 s cap) — only on rate-limiting. `MTAPI_ORDER_TIMEOUT_MS` default 50 s blocks account gate (concurrency 1).
- `orderLegExecution.ts:280-479` per-leg attempt < 2, only after `reconcileUnknownSend` proves order absent; no sleep.
- `TradeExecutor.ts:126-133`: mgmt sweep re-dispatch guard ≥10 s apart, max 5.

## 7. AI parse stage

| # | File:line | What | Value | Effect |
|---|---|---|---|---|
| 7.1 | `signalIntent/parseConfig.ts:19-25` | `UNIVERSAL_PARSE_MODE` default **`shadow`** | fire-and-forget (`parseRouting.ts:529-552`) → **0 ms added** |
| 7.2 | `parseRouting.ts:556-573` (fastpath), `:740` (primary) | AI stage 2 **awaited inline** before dispatch; timeout `UNIVERSAL_PARSE_TIMEOUT_MS` **4 000 ms** | fast-lane messages (conf ≥0.99) skip AI; everything else waits |
| 7.3 | `universalSignalParser.ts:227-298` | Cerebras 3 attempts, backoff 400×attempt on 429/5xx; timeouts don't retry; then OpenAI fallback | worst ≈ **17 s** inline before stage 2 gives up |
| 7.4 | `parseConfig.ts:106-118` | stage-3 GPT-4o reconcile default **false**, timeout 8 s | if enabled: +up to 8 s inline |
| 7.5–7.6 | `parseRouting.ts:583-618/744-793`, `universalSignalParser.ts:504-537` | grounding + context DB reads (1–3 RTT) inline in fastpath/primary |

**Bottom line:** default `shadow` = AI not a latency source. If prod runs `fastpath`/`primary`, every non-fast-lane entry pays an inline LLM call of **0.4–17 s** — alone explains 7–15 s. **MUST check prod env.**

## 8. Documented-vs-code regressions

1. **Heartbeat documented but hard-disabled** (4.1) — documented remediation is a no-op. **High (diagnostic trap).**
2. **New mandatory `/Quote` before OrderSend** (`e8def833`): `guardOpensAtMarket` `entryPrepare.ts:953-970` + uncached zone-guard quote → up to 2 sequential quotes (+50–300 ms). Contradicts docs `:448`. **Medium.**
3. "Dispatch-first" no longer true (ensureSignalRow awaited, `userListener.ts:3205-3219`, since 2026-07-28). **Doc drift.**
4. Live fast path still runs heavy DB idempotency (2nd ensureSignalRow, claim, 5-count probe, channel-config fetch). **Doc drift.**
5. Realtime `signals` fallback is UPDATE-only + disabled on split roles (1.10). **High if work-wake drops → silent 15 s.**
6. `MT4API_HTTP_CONNECTIONS` (docs 128) gone → `FXSOCKET_HTTP_CONNECTIONS` 64. Low.
7. `TRADE_DISPATCH_AWAIT_DEFAULT` documented true, code false. Low.
8. Sweep cadence documented 3000/60000 vs code 1000/15000; `.env.example:47` suggests idle 60 000 (would make lost poke cost 60 s). Low–Medium.
9. **`channel_delay_msec` live-fast skip confirmed intact** — no regression.
10. Queue head-of-line blocking + no Redis fetch timeout undocumented (3.5, 3.7). Medium.

## Most likely explanations for 7–15 s, ranked

1. **Dispatch fell through to DB sweep** — push retries (12.2 s) / queue enqueue failed / work-wake realtime down → up to 15 s idle (items 1.7, 1.9, 3.2, 3.5, 8.5).
2. **`UNIVERSAL_PARSE_MODE=fastpath/primary` in prod** → inline LLM 0.4–17 s (7.2/7.3).
3. **Serial DB chain before OrderSend** × relay hop (4.7, 4.8, 5.1–5.4).
4. **Cold broker caches** — heartbeat disabled, symbol cold ≈ +1.5 s; documented fix is a no-op (4.1–4.4).
5. **Listener pickup delay** — 10 s safety poll / flood backoff / lease gate (1.1, 1.6, 4.9).
6. **New `/Quote` guards + per-account leg serialization** (8.2, 5.6, 5.8).
