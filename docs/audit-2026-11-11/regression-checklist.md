# Regression checklist — everything Martins (Planmoni) pushed, pulled 2026-11-11

Source of truth: his 16 entries in `docs/PROJECT_MEMORY-MARTINS.md` + the 36 commits
cherry-picked today (13 earlier + 8 TradingView + 15 evening batch) — full commit
record in [pulled-fixes.md](pulled-fixes.md). Use this list to verify his work after
deploy and to catch regressions. Status column: fill in as you test.

Legend: **T** = test/automated check, **M** = manual/product check, **S** = SQL/log check.

---

## A. Entry latency (his "Sub-3s latency master plan" + post-handoff fix + entry-critical lane)

| # | What he changed | Regression check | How | Status |
|---|---|---|---|---|
| A1 | Phase 0–3 sub-3s plan: fast-lane management parse, concurrency lanes, prewarm | Entry actually lands in ~2–3s, not 7–15s | `scripts/diagnostics/pipeline_latency.sql`; `trade_execution_logs` `pipeline_summary.total_ms` | ☐ |
| A2 | `MT_SEND_OP_CONCURRENCY=3` (OrderSend lane), throttle step-down to 1 for ~45s | Multi-leg entries still all fill; no bridge 429 storm | order_send logs per leg; bridge logs | ☐ |
| A3 | `MT_MODIFY_OP_CONCURRENCY=3`, close default concurrency 6 | No lost/interleaved modifies under load | modify logs; broker readback | ☐ |
| A4 | live-fast `retryMs: 0` (no 3s teaser poll) | Teaser/stack entries don't double-fire or fire early | range/teaser entry flows | ☐ |
| A5 | claim∥light-config overlap; entry read cache; quote/OpenedOrders prewarm on order lane | `prep_ms` drops; no stale config used | `pipeline_summary.prep_ms`, `brokers_warm_at_dispatch` | ☐ |
| A6 | `brokerEntryContext` (our pull `dce938b3`): entry-critical reads bypass 3 rps background lane | Entry reads not queued behind monitor reads | broker timing records in execution logs | ☐ |
| A7 | listener pre-parse parallelization (channel-id/parent/context/dedup), `lastLiveMessageAt` only for monitored chats, `ingest_path` live\|catchup | No lost parent/reply linkage; provider numbers still link | parse logs; reply-scoped commands | ☐ |
| A8 | `UNIVERSAL_PARSE_MODE=fastpath` recommended by him — management actions always fast-lane | Management messages parse inline without stalling entries; AI failures don't block | parse timings; `UNIVERSAL_PARSE_TIMEOUT_MS` errors | ☐ |
| A9 | listener→trade push **401 fix** (internal token) + idle DB sweep fallback | Push no longer 401s; if push fails, sweep picks up ≤1s active | `dispatch_route_decision` / `dispatch_push_attempt` logs | ☐ |
| A10 | `TELEGRAM_SHUTDOWN_DRAIN_MS=3000` | Clean shutdown doesn't drop in-flight signals | deploy/restart during traffic | ☐ |

## B. Close / management latency

| # | What he changed | Regression check | How | Status |
|---|---|---|---|---|
| B1 | **Instant management closes**: `closeMarketPositionFast` trusts OrderCloseSafe ack on live-fast (no per-leg OpenedOrders readback) | Closes are fast AND complete — no "still open" ghosts | close wall time (`mgmt_wall_ms`); `trades.status` vs broker | ☐ |
| B2 | Multi-leg empty-readback confirmation (extra attempts when siblings open) | No false "Could not close" on multi-leg closes | close failure logs | ☐ |
| B3 | Straggler filtering on close-all (`filterSnapshotStragglerOrdersForClose`) | Comment-less naked orphans get closed; **commented user pendings NOT touched** | close-all on a basket with a manual pending; check orphans | ☐ |
| B4 | Close-all "~6s before closing starts" fix (push 401 + sweep) | `Close all` starts near-instantly | time from command to first broker close | ☐ |
| B5 | Fast close wired into force-close + managementExecutor | UI force-close fast path works; verified path still used when not live-fast | force-close flow | ☐ |
| B6 | expand∥orphan∥OpenedOrders parallelization; live partial skips post-readback | Partial closes reduce lots correctly (`trades.lot_size` shrinks) | partial-close audit | ☐ |
| B7 | `MTAPI_ORDER_PER_ACCOUNT_RPS` raised (12 → 20 in plan) | No bridge rate-limit storms | bridge 429/`expected available` logs | ☐ |

## C. Adjust / edited-signal SL/TP

| # | What he changed | Regression check | How | Status |
|---|---|---|---|---|
| C1 | **Cut Adjust SL pre-modify stall**: liveFast skips OpenedOrders preflight when verify-after-modify off; parallel quote/freeze/orders; `slFrom:'parsed'` honored | "Adjust SL" applies in ~1s, both sides intact | time `mgmt_modify`; broker readback SL **and TP** | ☐ |
| C2 | **Cut message-edit stalls**: overlap materialization, `peekCachedSymbolParams`, one shared basket quote | Edited signal SL/TP applies without ~20s delay | edit-signal flow timing | ☐ |
| C3 | **Edited signals refresh SL/TP**: revision waits on inflight (not dropped); claim-lost revisions attempt SL/TP-only refresh; merge_modify counts as materialized | Edited SL/TP actually lands on open basket; no dropped revisions | edit + verify broker stops | ☐ |
| C4 | **Freeze from first entry** (`f61124fb`): no restamp of Override pips from fill/fire quote | Later layers keep planned stops (clamped only); stops no longer "move every layer" | open a range basket; compare leg stops after each fill | ☐ |
| C5 | **Range empty-TP**: no collapse to 1×full lot | Range entry with no TP keeps correct lot split; no full-lot single leg | range trade with no TP | ☐ |
| C6 | Shared quote for basket before parallel legs; warm `entryBrokerReadCache` reuse | Fewer quotes; no wrong-symbol quotes under load | quote counts in logs | ☐ |
| C7 | One-sided-modify + behind-market guards from earlier pulls (`e8def833` lineage) still hold after his refactor | SL-only modify never wipes TP; all-behind-TP entry skipped | known scenarios from 2026-11-10 entry | ☐ |

## D. Duplicates / ghost trades

| # | What he changed | Regression check | How | Status |
|---|---|---|---|---|
| D1 | **Opened-position dedup** (`c2beaa55`): order/position twins → one entry | No twin rows; social/mirror copy doesn't double | `dedupeOpenedMarketPositions` tests; trades count per fill | ☐ |
| D2 | **Orphan-fold on close** (`loadNearDuplicateOrphanTradesForClose`): signal_id-null twins join the close set | Twins no longer survive basket close; **independent same-symbol trades NOT closed with the basket** | close basket with a real orphan twin + an unrelated same-symbol trade | ☐ |
| D3 | **Demo 0.1 XAU ghost lot** = active social copy follower, not double-send | The ghost-lot incident doesn't recur; social copy follower rows behave | social copy reconcile | ☐ |
| D4 | providerScope close-signal isolation | Closing signal P never touches signal Q's basket | `managementExecutor.providerScope.test.ts` (T) | ☐ |
| D5 | Claim/lease protections (pre-existing) untouched by his batch | No duplicate sends under retry/replay | claim logs; duplicate `order_send` per signal+broker | ☐ |

## E. Source kind / toasts / WhatsApp

| # | What he changed | Regression check | How | Status |
|---|---|---|---|---|
| E1 | `signals.source_kind` + `source_display_name` (migrations `20261111081000`, `20261111091500`) | **Migrations applied to target DB before deploy** — else inserts fail (his WhatsApp incident!) | `select column_name from information_schema.columns where table_name='signals' and column_name like 'source_%'` | ☐ |
| E2 | Logo fix: ensureSignalRow no longer invents `telegram`; dispatch upsert preserves kind; UI prefers live channel map | WhatsApp/TV/Discord rows show correct logo in Copier Logs | post a WhatsApp + TV signal | ☐ |
| E3 | WhatsApp listener: `PORT` env honored; `https://` prepended to URL | Railway WhatsApp service reachable; UI shows running | WhatsApp service + Netlify `VITE_WHATSAPP_LISTENER_URL` | ☐ |
| E4 | WhatsApp insert retry without source columns if schema lags | Ingest survives schema drift (warn + retry) | redeploy with lagging DB | ☐ |
| E5 | Toast announcement logic (`shouldAnnounceCopierLogToast`) + seen persistence | No Executed-toast resurrection on reconcile updates; fresh signals toast once | watch Copier Logs toasts during a close | ☐ |
| E6 | `source_kind` stamping from all listeners + projector + TV webhook | Correct kind on every channel type | verify one signal per source | ☐ |

## F. Frontend performance

| # | What he changed | Regression check | How | Status |
|---|---|---|---|---|
| F1 | Dashboard cold load skeleton under 2s (critical path, no 5s hold) | Dashboard paints <2s; metrics fill in | load dashboard on cold cache | ☐ |
| F2 | Account Trades/Performance/Own profile under 2s: `limit` 800/5000 single queries, background enrichment, no 800ms sleep | Trades page fast; history still complete enough; dedupe by ticket intact | trades page + performance tab | ☐ |
| F3 | Social preview hydrates own profile first; skips heavy RPC for `isYou` | Own profile instant; other traders unaffected | social trading page | ☐ |
| F4 | Copier strip symbol labels fill in during enrichment (empty-context first paint) | Symbols appear shortly after first paint; no crash | dashboard copier strip | ☐ |

## G. Environment variables his batch expects (set on Railway before/with deploy)

| Var | His documented value | Purpose |
|---|---|---|
| `MT_SEND_OP_CONCURRENCY` | 3 (default 3, max 6) | OrderSend lane |
| `MT_MODIFY_OP_CONCURRENCY` | 3 | OrderModify lane |
| `MT_CLOSE_OP_CONCURRENCY` | 6 | close lane |
| `MTAPI_ORDER_PER_ACCOUNT_RPS` | 12 → 20 (plan) | order pacing |
| `MTAPI_ORDER_THROTTLE_RETRY` | true | throttle step-down retries |
| `MT_TRADE_OP_CONCURRENCY` | (check current; he documents close lane separately) | per-account trade ops |
| `UNIVERSAL_PARSE_MODE` | fastpath (his recommendation) | inline parse — verify timeouts acceptable |
| `TELEGRAM_SHUTDOWN_DRAIN_MS` | 3000 | graceful drain |
| `WORKER_INTERNAL_TOKEN` / push auth | required for listener→trade push (401 fix) | dispatch push |
| `VITE_WHATSAPP_LISTENER_URL` | `https://…railway.app` | Netlify |
| `WHATSAPP_LISTENER_PORT` | Railway `PORT` | WhatsApp service |

Note: `worker/.env.example` now carries his documented values — diff Railway env against it.

## H. Database / deploy prerequisites

1. Apply `supabase/migrations/20261111081000_signals_source_kind.sql` (source_kind).
2. Apply `supabase/migrations/20261111091500_signals_source_display_name.sql` (source_display_name).
3. His WhatsApp entry says prod already got both columns as hotfix — verify per environment.
4. Redeploy order: DB migrations → edge functions → listener → trade worker → Netlify.

## I. Known upstream defects in his code (our repairs PARKED in stash — re-add later)

| # | Defect (verified on his branches) | Effect if not repaired | Our repair (stash@{1}) |
|---|---|---|---|
| I1 | `socialCopyMonitor.test.ts` duplicate `order()` method | that test file cannot compile/run | removed dup stub |
| I2 | `managementClose.test.ts` mock missing `OrderResult.ticket` | that test file cannot compile/run | added `ticket: 12345` |
| I3 | `virtualPendingMonitor.test.ts` 4 tests assert removed restamp behavior + fake hard-coded `{99,105}` row | 4 red tests | rewrote to frozen-stop semantics + fake reports "no newer row" |
| I4 | `providerScope.test.ts` fake `is()` no-op vs his orphan-fold close | wrong-scope red test (`[1001,1011]`) | implemented `is()` null filter |
| I5 | `DashboardPage` `buildCopierLogSymbolLabels(logs, {})` vs required-fields context type | **tsc red — ALREADY FIXED IN TREE** (empty maps passed) | (applied) |
| I6 | `tradingview_missing_sl_tp` missing from 6 channelWorker bundles | locale parity test red — **ALREADY FIXED IN TREE** (translations added) | (applied) |
| I7 | dead `channelLabel` helper (may have returned with his later commits) | TS6133 if unreferenced | (parked; tsc currently green) |

Note: I5 + I6 are applied in the working tree (uncommitted); I1–I4 + I7 remain parked in
`stash@{1}` ("local repairs") per your instruction to keep his code as-is for now.

## J. Pre-existing failures (NOT from his pulls — confirmed at baseline `9915b992`)

- `src/components/social/TraderReviews.test.ts` — 2 failures ('Rate trader', 'Loading reviews' strings).
- `src/lib/socialTradingProductionBoundary.test.ts` — skipped test + quote-sensitive discovery gap in `run-frontend-tests.sh`.

## K. Verification snapshot at pull time (staging-merge, local only — nothing pushed)

- `npm --prefix worker run build`: **PASS**
- `npx tsc -b`: **PASS** (after I5 fix)
- Frontend `npm run test:node`: **585/585 PASS** (after I6 fix)
- Frontend `npm run test:vitest`: **542/544** (J failures only)
- Full worker suite: see PROJECT_MEMORY / below (ran with his code as-is; I1–I4 expected red until repairs re-applied)
