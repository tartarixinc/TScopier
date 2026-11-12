# Past-fix regression audit — `staging-merge` @ `9915b992` (2026-11-11)

Method: every fix commit checked with `git merge-base --is-ancestor <sha> HEAD`; every "still present" claim confirmed by reading the code (file:line cited). Branch deltas at audit time: `HEAD..origin/staging` = 0; `HEAD..origin/migration` = 1 unrelated; **`HEAD..upstream/main` = 41 commits** (2+ unique relevant fixes); `bzetu/main` unique commits already in HEAD by patch-id.

## 1. Timeline (abridged — full table kept in PROJECT_MEMORY context)

| Date | Fix | Symptom fixed | Key files | In tree? | Sha |
|---|---|---|---|---|---|
| 2026-07-28 | Telegram reconnect storm hardening (11 fixes) | AUTH_KEY storms, 37-min outage | authKeyDuplicatedRecovery, userListener | Yes | `4a0febe0`, `9d76011f` |
| 2026-08-04/05 | **Revision path must honor dispatch claim** (3–75× duplication) | revisions bypassed claims → double OrderSend | TradeExecutor, entryPrepare | Yes (claim `:1638`; amend-only `entryPrepare.ts:372-385,511-526`) | `26e09770`, `d9c4e2f8` |
| 2026-08-05 | trades ticket unique index | duplicate broker ticket rows | `20260805000000_trades_idempotency_guard.sql` | file present; DB state per docs (staging 08-05, prod 08-16) | migration |
| 2026-08-10/11 | unknown-ticket benign + mgmt sweep guard | breakeven retry loop on gone positions | orderModifyBenign, TradeExecutor | Yes (`:126-132,:751-759`) | `d70c5471` |
| 2026-08-16 | block TP-without-SL entries | naked-TP entries executed | signalEntryNowRequirement | Yes | — |
| 2026-08-21/24 | flood-wait backoff + fast-poll pacing | flood-wait storms, 440 reads/min | userListener | Yes (`:877-936`, `:201-216`) | `eaf85b29`, `21461d17` |
| 2026-08-25 | realtime resubscribe retry storm bounds | 50 stacked retry timers | sessionManager | Yes (`:130,:497,:515-535`) | `fe0bd785` |
| 2026-09-18/19 | revision fast-path consults AI | edited signal bypassed AI → entry_not_opened | parseSignal, signalRevision | Yes | `33e728de` |
| 2026-09-24 | V1 basket reconcile ghost legs + empty OpenedOrders | false "SL still drifted" floods | basketSlTpReconcile* | Yes (`:61,:76,:332,:409-412`) | `5951762c` |
| 2026-09-29/30 | listener storm (destroy orphan loops, jitter, sessionRevoked) | 43-session reconnect burst | userListener, sessionManager | Yes | `33971725` |
| 2026-10-02 | "Pending LIMIT @ price" parser + level_already_passed | informational pending market-filled | parseSignal, entryPrepare | Yes | `273b0344` |
| 2026-10-04 | flat-account probeHealthy; broker drift sweep (2-pass ghost ≥4 min) | empty position list = "disconnected"; live trades closed as stale | openTradeReconcile, tradeBrokerDrift* | Yes | `1de17a75`/`be7aff93` |
| 2026-10-05 | MTAPI pacing/backoff + closed-history corroboration | stuck trades, auto-BE hot loop, ghost closes without proof | mtapiProvider, brokerGateway, openTradeReconcile | Yes — **but its RPS pacer is now audit finding #1 (3 rps background lane)** | `931347e9` |
| 2026-10-10 | wrong-side stop rejection + stop reconcile grind | naked entries; unfixable legs ground to max_attempts | basketReconcileTargets, basketSlTpReconcile | Yes | `8f60af3c`, `e1d5fdb2` |
| 2026-10-16 | auto-BE proves broker took the stop | DB recorded stops broker never had | brokerStopReadback | Yes (`AUTO_BE_VERIFY_AFTER_MODIFY` default on) | `a43113ae`/`94f2ef3f` |
| 2026-10-20 | dispatch claims became 120 s lease + deferred outcomes | stale claim blocked signal forever | signalBrokerDispatchClaim* | Yes | `cee94070` |
| 2026-10-22 | stop-loss safety (never clear, never cross sides) | broker-unacceptable stops; TP-only modify wiped SL | orderModifySafe, basketSlTpReconcile, channelStopApply | Yes — **but SL-only retry at orderModifySafe:141 still uncovered (audit B3)** | `b0bbbf74`/`32e6eb85` |
| 2026-10-22/23 | closed-trade fill monitor resolves from broker row | 112+ closed trades stuck without close price | closedTradeFillMonitor | Yes | `52f2a750`/`b294b930` |
| 2026-10-28 | **DB CPU 98%: config heal loop from realtime path** | table rewritten 150k×/25 min; listeners disconnected | TradeExecutor, channelTradingConfig | Yes (cache-only realtime, diff/cooldown guards) | `8c45fc6c` |
| 2026-11-03 | fill monitor shared column list | cTrader brokers silently skipped | closedTradeFillMonitor | Yes | `0b9fd4f3` |
| 2026-11-05 | force-close cancels resting pendings | "could not close" on pending rows | forceCloseSignalTrades | Yes — **but copyLimitFlatten still uses orderClose (known open)** | `b6900c96` |
| 2026-11-06/07 | close-20% trio (grounding counts pending, percent parse, promote) | 20% read as close-all | parseSignal, grounding, tradeBrokerDrift | Yes (staging + migration 11-07/08 at the time) | `a14607e5`/`a0319784` |
| 2026-11-10 | skip entries with all TPs behind market; one-sided MTAPI modifies | trades without TP; wiped stops | signalEntryPriceGuard, channelStopApply, orderModifySafe… | Yes (staging + upstream/main verified) | `e8def833` |
| 2026-11-10 | partial-TP reads open trades not 500-row window | partial profits stopped 4 days | partialTpMonitor | Yes | `468da314` |

## 2. Most likely regressed / missing fixes (verified pre-pull)

1. **`dedupeOpenedMarketPositions` existed only on `upstream/main`** — `c2beaa55`, not ancestor of HEAD; grep empty. **[PULLED 2026-11-11 as `14f1aaf6`]**
2. **`brokerEntryContext` entry-critical lane only on `upstream/main`** — `8d8cb5ac`; lets entry-critical reads bypass the background pacer; adds `pipeline_latency.sql`. **[PULLED 2026-11-11 as `dce938b3`]**
3. **`copyLimitFlatten.ts:92-93` still closes pendings with `orderClose`** (the exact bug force-close fixed 2026-11-05; prod evidence order 387155920, 215 failures/24h). Known-open follow-up in PROJECT_MEMORY. **[NOT yet fixed]**
4. **`basketSlTpReconcileMonitor.ts:251-252` still resolves brokers via session-keyed map** (silent-skip root cause family of 2026-10-22/11-03 incidents; should use row-based `apiForBrokerRow`). Known-open follow-up. **[NOT yet fixed]**
5. Aug-4 proposed alert (>3 trades/signal/account/5 min) never built — no duplicate alert rule in `20261012120300_alerting.sql`.
6. Content de-dup for double-posted messages: deliberately declined — do not restore.
7. Forward reconcile layers 1–3 (young-view guard, cross-tick evidence, mass-close guard) never shipped (documented deferral).
8. **Adverse-price entry guard still AI-lane only** (`entryPrepare.ts:461`); `allTakeProfitsBeyondMarket` covers TP side for all lanes, entry side not.
9. Doc/DB-state: retention tier-3 migration `20261106210000` recorded NOT applied to staging/prod as of 11-06; idempotency index DB state for Unicopier's own backend not verifiable from repo; many PROJECT_MEMORY/incident headers stale ("not deployed"/"uncommitted" for committed work).

## 3. Fixes intact (spot-check examples)

Fast-poll pacing; flood backoff; listener storm jitter; realtime retry dedupe; DB-CPU heal-loop fix; dispatch-claim lease + renewal + takeover; autoBE backoff/quarantine; mgmt sweep guard; monitor idle pacing helpers; light config cache (flag off); revision claims + amend-only routing; in-flight dup guard; listener 6-layer dedupe; flat probeHealthy; drift sweep 2-pass ghost; closed-history corroboration; fill-monitor row resolution + warnings; partial-TP open-trade-scoped reads + grace; force-close pending cancel; filled-LIMIT promote; grounding counts pending; percent-close parsing; unknown-ticket benign; BE absent-position skip; stop-loss safety suite; auto-BE readback verify; all-TP-behind-market skip; one-sided counterpart carry; wrong-side stop rejection; single-TP-target honored; TP-without-SL block; pending-limit parser; labeled-entry revision guard; cTrader quote symbolId filter.

## 4. Branch summary
- No fix on `origin/staging`/`staging`/`origin/migration` missing from HEAD (deltas 0–1 unrelated).
- `bzetu/main` unique commits (`44831ea0`, `54e0b518`) already in HEAD by patch-id.
- `upstream/main`/`upstream/migration` unique worker fixes: **all pulled 2026-11-11** (5 from main + 8 from migration, see PROJECT_MEMORY + scratchpad). Remaining unpulled upstream work = TradingView webhook batch (8 commits, feature stream incl. worker dispatch divergence ~90 lines), support-widget/social/i18n/UI (~20 commits).
