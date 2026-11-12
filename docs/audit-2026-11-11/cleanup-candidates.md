# Cleanup / refactor candidates — RECOMMENDATIONS ONLY, NOTHING APPLIED — 2026-11-11

Method: export graph analysis (1808 exports), env-read extraction (313+ reads), doc-link checker, git history for deleted modules. Every "dead" claim verified with `rg -w -l <name>` repo-wide (excluding node_modules/dist), test-only users excluded (62 test helpers NOT listed).

## RISK: LOW — pure dead code, comments, docs (safe deletions/edits)

### A. Dead code (zero callers repo-wide, including tests)
1. **7× unused `create*Provider()` factories**: `binanceProvider.ts:1085`, `bybitProvider.ts:1262`, `ctraderProvider.ts:833`, `dxtradeProvider.ts:1103`, `kucoinProvider.ts:1367`, `matchtraderProvider.ts:983`, `tradelockerProvider.ts:905` — resolver uses `getXProvider()` singletons (`providerResolver.ts:41-73`). Delete all 7.
2. `mtApiByAccount.ts:212,226` — `@deprecated` `loadPlatformByMetaapiId`, `apiForMetaapiAccount`. Delete.
3. `basketEffectiveStops.ts:259` — deprecated alias `findLatestMgmtModifySl`. Delete.
4. `tradeSignalPush.ts:346-353` — `pushParsedSignalToTradeWorkerAwait()` (comment says queue/diagnostics; neither imports it). Delete.
5. `userListener.ts:3311-3366` — private `persistSignalSync()` (~56 lines, `@deprecated` at 3310, 0 refs; `persistSignalBackground` is what's called). Delete.
6. `sessionLease.ts:145-148` — deprecated `renewSessionLease()` wrapper (0 callers). Delete.
7. `fxsocketClient.ts:634-636` — deprecated `isTerminalHealthy()` (0 worker refs; edge copy separate). Delete.
8. **~41 zero-reference exports** (batch list; split per module): `bundleSteadyTargetRows` (`manualPlanning/tpBundleIdentity.ts:124`), `intentActionLabel`/`intentToParsePreview` (`signalIntent/shadowDiff.ts:51,60`), `claimLayeringPlanActivation`, `clearBrokerConnectionStatusCache`, `clearBrokerTerminalHealthCache`, `countActiveSubscribers`, `expandAndGroupChannelModifyLegs`, `failoverChannelReader`, `globalLegIndexForRangePending`, `invalidateChannelFeedCache`, `isRequoteRetcode`, `operationRequiresPrice`, `linkSubscriptionToSignalChannel`, `listActiveChannelLeases`, `loadMgmtFanOutSubscriptions`, `onChannelSubscriptionAdded`, `projectChannelSignalById`, `releaseChannelListenerLease`, `resetCheckConnectPacing`, `setMtapiProviderForTests`, `universalResultToParseResult`, `upsertChannelSignalExample`, `MULTILINGUAL_FIXTURES`, `buildFxsocketWsUrl`, `isMtBridgeGlitchError`, `isBrokerCredentialsCryptoConfigured`, `isMgmtEligibleTradeStatus`, `markRangeLegsExpired`, `fetchFreshBrokerForChannel`, …
9. `brokerSymbolCache.ts:337-340` `reconnectCachedBrokers()` body is `void ctx;` — called only under `BROKER_PING_ON_WORKER_START` (default true) at `TradeExecutor.ts:414-417` → startup runs a guaranteed no-op. Remove call + stub + branch (env absent from `.env.example`).

### B. Stale / false comments in code
10. `virtualPendingMonitor.ts:67-75` — header claims `range-pending-sweep` 60 s cron backup + "1.5s cadence"; cron gone (dropped `20260616130000`), real cadence 200 ms/15 s (`:185-186`); heartbeat math at `:559` wrong too. Rewrite header.
11. `cweCloseMonitor.ts:46,89` — "1.5s, same as VirtualPending" / "20 ticks × 1.5s"; actual 400 ms/15 s (`:65-66`). Fix numbers.
12. `TradeExecutor.ts:265-267` — log tells operators to set `BROKER_SESSION_BACKGROUND_HEARTBEAT=true` which `workerConfig.ts:73-83` explicitly ignores. Correct the log.
13. `monitorIdleGate.ts:4,12` JSDoc "default 1500/60000ms" — both take caller defaults. Reword.
14. `brokerSymbolCache.ts:411-415` — `markBrokerSessionRecovered` comment "called from every heartbeat success path"; 0 callers, heartbeat disabled. Delete with item 30.
15. `rangeBasketTpSync.ts:1058-1059` — "synced legs are skipped by stopsAlreadyMatch" is false (`basketSlTpReconcile.ts:354` void no-op). Fix comment only.

### C. Docs that mislead operators
16. `docs/worker-deployment.md:414-415` — recommends `BROKER_RECONNECT_BACKOFF_*`, `BROKER_HARD_RECONNECT_SWEEP_MS`: **exist nowhere in code**. Delete bullets.
17. `docs/worker-deployment.md:407-408` — table rows "broker reconnect sweep 120000/300000", "forced hard-reconnect sweep 900000": no such monitors. Delete rows.
18. `docs/worker-deployment.md:404-406,398,421` — interval table/prose wrong (virtual 400 vs **200**; basket 15000/120000 vs **5000/15000**; sweep 3000 vs **1000**; idle "60s default"; "1.5s"). Regenerate from call sites.
19. `docs/worker-deployment.md:417,452` — "`connection_status` written only by worker (`brokerConnectionMonitor`…)" — **file deleted** (`69a62ee6`); edge functions write it (`fxsocket-broker:123`, `mtapi-broker:471`, `disconnect-expired-fxsocket-brokers:32`). Rewrite.
20. `docs/worker-deployment.md:412,447,503` — heartbeat "default 15s", prewarm per heartbeat, "Set `BROKER_SESSION_HEARTBEAT_MS=10000`" — heartbeat disabled, default 30 s, prewarm runs at start + keepalive. Rewrite as "disabled; warm via `SYMBOL_CACHE_KEEPALIVE_MS`".
21. `docs/worker-deployment.md:511,721`; `docs/product-test-strategy.md:177-180`; `docs/admin-panel-spec.md:468-469` — deploy/test steps for removed crons `range-pending-sweep`, `basket-sl-tp-sweep`, `broker-session-keepalive`. Delete or mark "(removed 2026-06-16)".
22. `MT4API_HTTP_CONNECTIONS` (docs default 128) → now `FXSOCKET_HTTP_CONNECTIONS` default 64: fix in `deploy-scale-hardening.md:13`, `staging-shard-fleet.md:48`, `worker-deployment.md:451`.
23. Broken links `../diagnostics/pipeline_latency.sql`, `../load/*` → actual `scripts/diagnostics/…`, `scripts/load/…`: fix `deploy-scale-hardening.md:25`, `staging-shard-fleet.md:67,73`.
24. `worker/.env.example:17-47` — commented "recommended" intervals slower than code defaults (`*_IDLE_MS=60000` vs 15 000; ticks 1500 vs 400; signal-entry 1500 vs 2000; basket 15000/120000 vs 5000/15000; sweep 3000/60000 vs 1000/15000); duplicate `BASKET_RECONCILE_TICK_MS` (lines 35 + 341). Rewrite comments with real defaults.
25. `worker/.env.example:88-89` — `TRADE_DISPATCH_AWAIT_DEFAULT=true` claim vs code `'false'`. Correct.
26. Concurrency env families undocumented: `MT_TRADE_OP_CONCURRENCY` (mtapi **1**, not in either .env.example), `MT_PER_ACCOUNT_TRADE_CONCURRENCY` (fxsocket 3 cap 8; engine same name default 4 cap 16 — conflicting defaults for one env), `MTAPI_ORDER_RPS`/`MTAPI_BACKGROUND_RPS`/`MTAPI_PER_ACCOUNT_RPS` (6/3/6). Document all three families.

(checked: `docs/light-config-cache.md` and root `.env.example` — NO drift found.)

### D. Test debt / naming / housekeeping
27. Orphan-named tests: `deletePendingsManagement.test.ts`, `brokerPendingFillTpRedistribute.test.ts` (modules don't exist; both pass 8/8 against real modules). Rename.
28. `scripts/run-frontend-tests.sh:11,17` discovery greps only match **single-quoted** imports → `src/lib/socialTradingProductionBoundary.test.ts` (double quotes) never runs under `npm test` (CI hardcodes path). Broaden regex or normalize quotes.
29. `src/lib/socialTradingProductionBoundary.test.ts:143-157` — only `test.skip` in repo. Restore or delete.
30. `worker/scripts/split-basket-merge.mjs`, `split-entry-prepare.mjs`, `split-trade-executor.mjs` — one-off split tools, reference now-dead `computeCweTp`; zero refs. Archive/delete.
31. `worker/scripts/debug-sendorder.mjs`, `forceReconcileGbpusdBasket.mjs`, `fxSmoke.ts`, `generateDerivSymbolRegistry.ts`, `mgmtLatencyBench.ts` — zero refs in package.json/docs/code. Review + archive or add README.
32. Tracked junk: `.DS_Store`, `.superstack/learnings.md`, `.tmp-home/.supabase/telemetry.json` — `git rm --cached` + gitignore.
33. `worker/package.json:39` — `@types/ws` in `dependencies` → move to devDependencies.

## RISK: MEDIUM — removable but touches logic
34. `brokerSymbolCache.ts:414-421` `markBrokerSessionRecovered()` 0 callers — delete is safe, BUT `markBrokerSessionDown` IS called (`orderLegExecution.ts:425`, `managementExecutor.ts:411`) while the only 'connected' writer never runs → **open separate ticket for the write-gap** (connection_status can stick 'error').
35. `listenerSignalReplay.ts:20-31` `listenerLeaseRecoveryTick` only reachable via dead heartbeat chain (`TradeExecutor.ts:430 → :445 → :260-263`); `replaySignalsAfterListenerRecovery` itself stays alive (`sessionManager.ts:475`). Decide: delete or re-home onto `symbolCacheKeepaliveTimer`.
36. `retryActivity.ts:43,71` vs `retrySignal.ts:130,158` — `resetSignalForRetry()` + `toDispatchRow()` byte-identical duplicates (log prefix only). Extract shared helper.
37. `userListener.ts:463-465` `isNumericTelegramChatId` byte-copy of exported `telegramChatId.ts:3-5`. Import + delete copy. (Do NOT unify `toChannelIdVariants` — bodies genuinely differ.)
38. Three per-account concurrency impls with **conflicting defaults for the same env**: `mtapiProvider.ts:117-119` (1), `fxsocketClient.ts:557-560` (3/8), `engine/fxClient.ts:105-107` (4/16). Consolidate into `perAccountConcurrency.ts` with explicit per-bridge defaults — needs a deliberate default-wins decision.
39. `envNumber.ts` vs 4 local copies (`mtapiOrderUpdateHub.ts:29`, `mirrorCopyMonitor.ts:174`, `tradeExecutionMonitor.ts:246`, `workerHeartbeat.ts:22`) — signature families differ; migrate + add `envNumberByName`.
40. 6 `envBool`/`parseEnvBool` variants with different accepted tokens — unify on `workerConfig.parseEnvBool` after per-call-site token audit.
41. `brokerSignalReplay.ts:24-63` vs `listenerSignalReplay.ts:36-105` — identical load query + `REPLAY_BATCH_LIMIT=40`. Extract `loadRecentParsedSignals(...)`, keep post-filters local.
42. Three dedupe layers (queue idempotency / dispatch claim / inflight) — **checked and rejected: different scopes, not mergeable.** Recorded so it isn't re-proposed.

## RISK: HIGH — flag only, needs its own change process
43. Second `ensureSignalRow` in `handleSignal` (`dispatch.ts:523-556`) — NOT a no-op (duplicate abort + FK backstop). Keep; only consolidate with proof every ingress hits dedupe once.
44. `skipAlreadySynced` no-op + 9 callers passing it (`rangeBasketTpSync.ts:1049`, `basketSlTpReconcileMonitor.ts:384`, `basketMerge/legTpSync.ts:143`, `basketMerge/slTpRefresh.ts:554,648,730`, `rangeBrokerPendingMonitor.ts:217`, `rangeBasketTpSync.ts:1043`) — removal touches naked-fill regression surface. Separate change; comment fix only until reviewed.
45. Heartbeat chain removal (`workerConfig.ts:84 → TradeExecutor.ts:260-263,428-445 → brokerSymbolCache` + dead env `BROKER_HEARTBEAT_CONCURRENCY`) — mechanically safe today but decides whether listener-lease replay on trade workers is wanted. Product decision.
46. `pingBrokerSessionInner` no-network stamp + its 3 tests — leave until heartbeat decision (45); making it a real keepalive would change warm-up latency.

## Verification notes
- Non-use never assumed; every claim double-passed repo-wide; test-only helpers excluded.
- Orphan tests execute green (8/8); no unresolved relative imports among the 48 same-name-less test files.
- Deleted-module claims backed by `git log --diff-filter=D`; "env exists only in docs" re-checked against all read styles (`process.env.X`, `envNumber`, `parseEnvBool`, `Deno.env.get`, …). Only genuinely dead envs: `BROKER_HEARTBEAT_CONCURRENCY` + the three `BROKER_RECONNECT_*`/`BROKER_HARD_*` doc-only names.
