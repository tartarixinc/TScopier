# Code-preservation & behaviour regression checklist — everything Martins fixed

Purpose (owner request): make sure **none of his fix code gets removed or silently
changed again**, and **none of the behaviours he fixed regress**. Source of truth:
his 34 entries in `docs/PROJECT_MEMORY-MARTINS.md` + the 49 commits pulled from
`upstream/main` / `upstream/migration`.

Two layers of protection:

1. **Code-preservation** — `bash docs/audit-2026-11-11/verify-martins-fixes.sh`
   (46 grep checks; currently **46/46 PASS**). Run it **before and after ANY change
   to a file covered by this checklist** (his closes, SL/TP, dedupe, latency, source
   and toast code) — and after every upstream pull, merge, revert or refactor. Any
   FAIL means his fix code disappeared or was altered.
2. **Behaviour** — automated tests + manual scenarios below. Fill in the result
   columns on each release candidate.

---

## 1. Trade closes (his "Instant management closes", sub-3s, multi-leg, close-all)

| # | Fix | Code-preservation check (script) | Behaviour verification | Result |
|---|---|---|---|---|
| 1.1 | **Instant close** — live-fast trusts OrderCloseSafe ack, no per-leg OpenedOrders readback | `closeMarketPositionFast` in `managementClose.ts`; used by `forceCloseSignalTrades.ts` | T: `managementClose.test.ts` (needs parked repair I2) · M: close a 3-leg basket, all legs closed, wall time seconds not 30s · S: `mgmt_wall_ms` in execution logs | ☐ |
| 1.2 | **Multi-leg empty readback** confirms instead of failing | `EMPTY_READBACK_MULTI_EXTRA_ATTEMPTS` | T: `managementClose.test.ts` · M: close while another position is open on the account | ☐ |
| 1.3 | **Straggler filtering** on close-all | `filterSnapshotStragglerOrdersForClose` in `managementBrokerClose.ts` | T: `managementBrokerClose.test.ts` · M: close-all with a comment-less naked orphan → orphan closed; **a commented manual pending must survive** | ☐ |
| 1.4 | Close-all "~6s before closing starts" (push 401 + sweep fix) | `accepted` in `tradeSignalPush.ts`, `internalToken.ts` | T: `tradeSignalPush.test.ts` · S: `dispatch_push_attempt` shows accepted, no 401 | ☐ |

## 2. SL/TP behaviour (his core TP/SL work)

| # | Fix | Code-preservation check | Behaviour verification | Result |
|---|---|---|---|---|
| 2.1 | **Freeze from first entry** — Override pips never restamped from later fills/fire quote | "first-entry freeze" comment in `virtualPendingMonitor.ts`; **`restampBasketTargetsFromLegEntries` must stay ABSENT** | T: `virtualPendingMonitor.test.ts` (4 tests currently assert the OLD restamp behaviour — parked repair I3) · M: open a range basket, check each leg's SL/TP equals the planned level (only clamp-adjusted), not fill±pips | ☐ |
| 2.2 | Manual settings type extended for range sync | `use_predefined_sl_pips` in `rangeBasketTpSync.ts` | `npm --prefix worker run build` (typecheck) | ☐ |
| 2.3 | **Adjust SL stall cut** — liveFast skips preflight, parallel quote/freeze/orders | `verifyOnBroker` + `liveFast` in `channelStopApply.ts` | M: "Adjust SL" → applied in ~1s, broker shows new SL **and keeps TP** · S: `mgmt_modify` logs both sides | ☐ |
| 2.4 | **Message-edit stalls cut** — shared basket quote, param peek, ghost-skip | `One shared quote for the whole basket` in `basketSlTpReconcile.ts`; `skipGhostReconcile` in `mergeRouting.ts`; `peekCachedSymbolParams` | M: edit a signal's SL/TP → applies without ~20s stall | ☐ |
| 2.5 | **Edited signals refresh SL/TP** — revision waits on inflight, claim-lost refresh, merge counts as materialized | `waitForSignalInflightClear`, `SL/TP only`, `message_revision`; `merge_modify_summary` in `helpers.ts` | T: `deferredOnlyRangePlan.test.ts` (3 currently red upstream), `managementExecutor.replyScope.test.ts` (2 red upstream) · M: edit open signal's stops → broker stops update | ☐ |
| 2.6 | **Range empty-TP** no longer collapses to 1×full lot | `multi_trade_fallback_empty_tps` in `planMultiManualOrders.ts` | T: range plan tests · M: range signal with no TP → lots split correctly, no single full-lot leg | ☐ |

## 3. Duplicates / orphan twins

| # | Fix | Code-preservation check | Behaviour verification | Result |
|---|---|---|---|---|
| 3.1 | Opened-position dedupe (order/position twins → one entry) | `dedupeOpenedMarketPositions` in `livePositionIdentity.ts`, used by `copyHelpers.ts` | T: `livePositionIdentity.test.ts` · M: social/mirror copy of one position creates one destination trade | ☐ |
| 3.2 | Near-duplicate orphan fold on close | `loadNearDuplicateOrphanTradesForClose` in `managementScope.ts`, wired in `managementExecutor.ts` | T: `managementExecutor.providerScope.test.ts` (1 currently red — parked repair I4) · M: close a basket that has a twin orphan → both gone; **unrelated same-symbol trade stays open** | ☐ |
| 3.3 | In-flight duplicate-send guard | "skip duplicate in-flight sendOrder" in `TradeExecutor.ts` | S: no duplicate `order_send` per signal+broker | ☐ |
| 3.4 | Mgmt accept dedupe | `shouldSkipDuplicateMgmtAccept` | M: send the same management edit twice quickly → applied once (watch: review M1 — `telegram_edit_date` vs `telegram_edit_date_seen` field name bug) | ☐ |

## 4. Entry/management latency lanes (touch trades → must not regress to 7–15s)

| # | Fix | Code-preservation check | Behaviour verification | Result |
|---|---|---|---|---|
| 4.1 | Entry-critical read lane (bypasses 3 rps background pacer) | `worker/src/brokerEntryContext.ts` + use in `mtapiProvider.ts` | T: `brokerEntryContext.test.ts`, `brokerGateway.test.ts` · S: `scripts/diagnostics/pipeline_latency.sql` → entry reads not queued | ☐ |
| 4.2 | Concurrency lanes: send/modify/close + throttle step-down | `MT_SEND_OP_CONCURRENCY`, `MT_MODIFY_OP_CONCURRENCY`, `MT_CLOSE_OP_CONCURRENCY`, `MTAPI_ORDER_THROTTLE_RETRY` in `mtapiProvider.ts`; `MTAPI_ORDER_PER_ACCOUNT_RPS` in `brokerGateway.ts` | T: `mtapiProvider.test.ts` · M: multi-leg entry fills all legs without 429 storm | ☐ |
| 4.3 | Listener pre-parse parallelism + parentSignalId fix | `parentSignalId` in `userListener.ts` | T: worker listener tests · M: reply-scoped management still resolves parent | ☐ |
| 4.4 | Real-time wake resubscribe with backoff | `consecutiveFailures` in `monitorWorkWake.ts` | ⚠ review H1: resubscribe loop bug — verify no churn in logs (`[monitorWorkWake] realtime status=CLOSED` repeating every ~2–4s = FAIL) | ☐ |

## 5. Signal sources (TV/WhatsApp) — affect what gets traded

| # | Fix | Code-preservation check | Behaviour verification | Result |
|---|---|---|---|---|
| 5.1 | TV always-on ingest on Railway | `worker/src/tradingViewIngest.ts`, `webhooks/tradingview` in `httpServer.ts` | T: `tradingViewIngest.test.ts` · M: paste Railway webhook URL in Configure → alert lands as signal | ☐ |
| 5.2 | TV stops required (alert SL+TP or overrides) | `tradingViewEntryStopsSatisfied` | T: `signalExecutionEligibility.test.ts` · M: alert missing stops → skipped with `tradingview_missing_sl_tp` | ☐ |
| 5.3 | Source kind correct (no fake Telegram logo) | `source_kind` in `ensureSignalRow.ts`; `live` preference in `signalSourceMark.ts` | T: `ensureSignalRow.test.ts`, `signalSourceMark.test.ts` · M: WhatsApp/TV/Discord rows show correct logo | ☐ |
| 5.4 | WhatsApp listener PORT/URL fixes | `process.env.PORT` in `whatsappListener.ts` | M: WhatsApp service reachable from UI; ingest inserts (both migrations applied) | ☐ |
| 5.5 | Copier-log toast logic (no resurrected Executed toasts) | `shouldAnnounceCopierLogToast` in lib + component | T: `copierLogToast.test.ts` · M: reconcile updates don't re-toast old signals | ☐ |

## 6. Deploy prerequisites (must hold, or his trades misbehave)

1. Migrations applied **before** worker deploy: `20261111081000_signals_source_kind.sql`,
   `20261111091500_signals_source_display_name.sql`, `20261112080000_tradingview_webhook_alert_config.sql`.
2. Railway env: `MT_SEND_OP_CONCURRENCY=3`, `MT_MODIFY_OP_CONCURRENCY=3`,
   `MT_CLOSE_OP_CONCURRENCY=6`, `MTAPI_ORDER_PER_ACCOUNT_RPS`, `MTAPI_ORDER_THROTTLE_RETRY=true`,
   `UNIVERSAL_PARSE_MODE=fastpath` (his recommendation), `WORKER_INTERNAL_TOKEN` (push auth),
   `TELEGRAM_SHUTDOWN_DRAIN_MS=3000`; Netlify `VITE_TRADINGVIEW_INGEST_BASE_URL`,
   `VITE_WHATSAPP_LISTENER_URL=https://…`.
3. Redeploy order: DB → edge → listener → trade worker → Netlify.

## 7. Known-red tests with his code as-is (his branches are red on these too — verified)

Parked repairs in `stash@{1}` (per instruction: his code stands alone for now):

| Test | Cause | Repair (parked) |
|---|---|---|
| `managementClose.test.ts` (file won't compile) | mock missing `OrderResult.ticket` | I2 |
| `socialCopyMonitor.test.ts` (file won't compile) | duplicate `order()` method | I1 |
| `virtualPendingMonitor.test.ts` ×4 | tests assert removed restamp behaviour + fake hard-codes `{99,105}` | I3 |
| `managementExecutor.providerScope.test.ts` ×1 | fake `is()` no-op vs orphan-fold query | I4 |
| `deferredOnlyRangePlan.test.ts` ×3 | his own test mocks lack the ctx map his `entryPrepare.ts:438` now requires | none yet — upstream-red |
| `managementExecutor.replyScope.test.ts` ×2 | post-close volume-alias / partial-profit expectations vs his new close path | none yet — upstream-red |
| `src/lib/brokerCopyLink.test.ts` ×6 | his delete now chains `.select('id')`; his own test fake lacks `.select()` after `.delete()` | none yet — upstream-red |

Worker full suite at round-2 pull time: **3207/3218 pass, 11 fail** (round-3 re-run pending) (exactly the above; no unexplained failures).
Frontend after round 3: node:test **590/590**; vitest **536/544** (2 pre-existing `TraderReviews` + 6 upstream-red `brokerCopyLink`).

## 8. Review findings to watch (do not silently drop)

- **H1** `monitorWorkWake.ts` resubscribe can loop after `CLOSED` (stale-channel callback). Symptom + check in 4.4.
- **M1** `TradeExecutor.ts:864` reads `telegram_edit_date` instead of `telegram_edit_date_seen` → 15s mgmt-dedupe can drop a newer edit. Watch in 3.4.
- **M2** `channelStopApply.ts:895` TP-freeze now also skipped for `tpOnly` — confirm intended; watch in 2.3.
- **M3** two hand-rolled ticket-alias parsers in `managementExecutor.ts` (`ticketsFromOpenedOrdersSnapshot`, modify prewarm) disagree with `rawOrderTicket`/`ingestBrokerTickets` — straggler sweep can under-close for `orderId`/`deal` payloads. Watch in 1.3.
- **M4** TradingView entries bypass price-plausibility/commentary checks — malformed alert with absurd positive levels passes dispatch. Watch in 5.2.
- **M5** TV webhook ACK-before-work: failures only visible in `tradingview_webhook_deliveries`; alerts without expanded `id` can duplicate on redelivery. Watch in 5.1.
