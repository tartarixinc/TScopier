# Pulled fixes — per-commit record (2026-11-11)

Every commit below was cherry-picked from `upstream/main` or `upstream/migration`
(tartarixinc/TScopier, authored by Planmoni/Martins) onto `staging-merge` at the
owner's request, reviewed, and verified locally. **Nothing was pushed anywhere.**
Each entry: what it does, why it matters for the production symptoms, files,
review notes (including any upstream defects found), and verification.

## From `upstream/main` (5 commits)

### 1. `0f4861f4` ← `a0fa1c5e` — fix(useLiveOwnOpenPnl): retain previous open PnL on MTAPI poll failures
- **What:** on a failed/partial MTAPI AccountSummary poll the dashboard keeps the
  last known open PnL instead of blanking; clearer timeout messaging via
  `describeLiveFetchError`.
- **Why pulled:** resilience fix; removes UI churn during broker-read pressure
  (same pressure class as the close-latency audit).
- **Files:** `src/hooks/useLiveOwnOpenPnl.ts`, `src/lib/liveOpenPnl.ts`, `src/lib/liveOpenPnl.test.ts`.
- **Review:** trivial, no worker impact; no upstream defects.
- **Verified:** `npx vitest run src/lib/liveOpenPnl.test.ts` → **11/11 pass**; `npx tsc -b` green.

### 2. `dce938b3` ← `8d8cb5ae`… (`8d8cb5ac`) — feat(worker): broker gateway entry-critical reads + latency tracking
- **What:** entry-critical broker reads are admitted on the **order lane** so they
  bypass the 3 rps background backlog (audit finding: the pacer is the #1 close
  latency source); adds per-broker-call timing records and
  `scripts/diagnostics/pipeline_latency.sql` (send_plan_ms/total_ms).
- **Why pulled:** directly targets the entry/management latency symptom and gives
  us the diagnostics to measure it.
- **Files:** new `worker/src/brokerEntryContext.ts` (+test), `brokerGateway.ts` (+test),
  `mtapiProvider.ts` (+test), wiring in `dispatch.ts`, `entryExecution.ts`,
  `entryPrepare.ts`, `managementExecutor.ts`, `rangeTradeExecutor.ts`, new SQL script.
- **Review:** the entry-critical context is additive (explicit opt-in per call);
  background lane behavior unchanged for existing callers. No upstream defects.
- **Verified:** `npm --prefix worker run build` green; new tests pass in targeted run.

### 3. `14f1aaf6` ← `c2beaa55` — feat(worker): deduplication of opened market positions
- **What:** collapses order/position twin rows (same position seen as order + position)
  so one market position = one entry; used by social/mirror copy normalization,
  `reconcileUnknownSend`, entry persistence. Also adds
  `loadNearDuplicateOrphanTradesForClose` (folds `signal_id IS NULL` twin orphans
  into close sets so they don't survive a basket close).
- **Why pulled:** duplicate-trades fix; the missing piece identified by the
  past-fixes audit (existed only on upstream/main).
- **Files:** `livePositionIdentity.ts` (+test), `managementScope.ts`,
  `copyShared/copyHelpers.ts`, `socialCopyMonitor.ts` (+test), `socialCopySourceTrades.ts`,
  `mirrorCopyMonitor.ts`, `managementExecutor.ts`, `orderLegExecution.ts`, `reconcileUnknownSend.ts`.
- **Review findings (repaired):**
  1. **Duplicate `order()` stub** in `socialCopyMonitor.test.ts` (lines 37+40 —
     upstream's file has both; TS2393 blocks the whole file from running) — removed
     one identical no-op line. Test-only.
  2. **providerScope test exposed a fake-DB gap**: the new orphan-fold query uses
     `.is('signal_id', null)`; the test fake's `is()` was a no-op, so the second
     signal's ticket leaked into the close set (`[1001, 1011]`). Bisected to this
     commit (green at the previous commit). Repaired by implementing `is()` null
     filtering in `managementExecutor.providerScope.test.ts` (production DB applies
     the filter — behavior unchanged).
  3. **No dedicated test exists** for `loadNearDuplicateOrphanTradesForClose` — follow-up.
- **Verified:** socialCopyMonitor tests pass; providerScope **5/5** after repair;
  targeted suite **74/74**.

### 4. `0573c3b5` ← `fcb59231` — feat(worker): management close logic for multi-leg positions
- **What:** empty-readback confirmation no longer bounces multi-leg closes to
  reconciliation ("Could not close" false errors): persistently empty readback after
  a non-rejected close confirms the ticket; extra readback attempts (+3 at 400 ms)
  when other positions were open pre-close.
- **Why pulled:** close-path reliability (audit symptom: closures/adjustments failing
  or slow).
- **Files:** `managementClose.ts`, `managementClose.test.ts`.
- **Review:** semantics change is deliberate and test-covered upstream; siblings keep
  their own reconcile path. No upstream defects.
- **Verified:** managementClose tests **green** after the #5 repair below.

### 5. `fe3c6c4a` ← `be5ef264` — feat(worker): manual SL/TP restamping for basket trades
- **What:** (arc) added `restampBasketTargetsFromLegEntries` + `manual` plumbing so
  Override pips apply per fill; **partially reverted 90 minutes later by `f61124fb`
  (#7)** in favor of "freeze absolute SL/TP from the first entry". We pulled BOTH in
  order, so our tree equals his final intent.
- **Why pulled:** TP/SL stability stream.
- **Upstream defect #1 (repaired):** did not typecheck — `rangeBasketTpSync.ts:1050`
  passed a 3-key object into a `Pick<ManualSettings,…>` param (TS2559 weak-type).
  Verified `upstream/main` itself is red (clean worktree test). Interim type-only
  widening applied with owner approval; **superseded by his own `a670113e` (#6)** —
  his version is what stands now.
- **Files:** `basketSlTpReconcile.ts`, `basketSlTpReconcileMonitor.ts`,
  `manualPlanning/manualStops.ts` (+test), `rangeBasketTpSync.ts`,
  `basketMerge/legTpSync.ts`, `basketMerge/slTpRefresh.ts`.
- **Verified:** build green after #6 landed.

## From `upstream/migration` — Planmoni's 2026-11-11 batch (8 commits)

### 6. `168038b9` ← `a670113e` — feat(worker): extend manual settings in RangeBasketTpSyncArgs
- **What:** adds `use_predefined_sl_pips/predefined_sl_pips/use_predefined_tp_pips/predefined_tp_pips`
  to `RangeBasketTpSyncArgs.manual` — his own fix for defect #1 above.
- **Review:** supersedes our interim type widening; ours dropped in favor of his.
- **Verified:** `npm --prefix worker run build` green.

### 7. `1da10762` ← `f61124fb` — refactor(worker): streamline manual settings, remove redundant SL/TP logic
- **What:** removes the restamp-from-fill machinery (added 90 min earlier): Override
  pips are **no longer recomputed from every fill/fire quote** — absolute SL/TP is
  frozen from the first entry ("that moved stops on every layer"). Deletes
  `resolvePredefinedSlForEntry/…TpForEntry` usage across `virtualPendingMonitor`,
  `postFillFollowUp`, `planMultiManualOrders`, `manualStops`, `basketSlTpReconcile`.
- **Why it matters:** directly reduces stop churn (audit class: unstable TP/SL) —
  layered fills no longer repaint stops.
- **Review findings (repaired):** his commit updated `manualStops.test`,
  `manualPlanner.test`, `postFillFollowUp.test` but **missed 4 `virtualPendingMonitor`
  tests** asserting exactly the removed restamp behavior — upstream/migration is red
  on them (verified: our files byte-identical to his tree). Repaired:
  1. fake `sltp-refresh` row hard-coded `{stoploss:99, takeprofit:105}`, which (with
     restamp removed) overrode every test's planned stops — fake now reports "no newer
     row" so the tick snapshot stands (production re-read returns the same row);
  2. the 4 tests renamed + re-expected to the new semantics: planned stops are sent
     **frozen, clamped only to the fire quote** (buy SL 1992→1989.98, sell SL
     2008→2010.02, buy TP 2003→2005.02, sell TP 1997→1989.98 — NOT fill±pips).
- **Verified:** `virtualPendingMonitor.test.ts` **43/43 green** after repair.

### 8. `011597f2` ← `69ffea85` — feat(copierLog): toast announcement logic + signal source kind
- **What:** `shouldAnnounceCopierLogToast` (INSERT/UPDATE fingerprint decide
  show/skip/seed — stops Executed-toast resurrection by reconcile patches); toast
  seen-persistence (`read/writeCopierLogToastSeen`); `signalSourceMark.ts`
  (source icons/names); `signals.source_kind` column + migration
  `20261111081000_signals_source_kind.sql`; worker writes source_kind from
  ensureSignalRow/listeners/projector; types +5.
- **Conflict resolution (13 files, reviewed individually):**
  - **i18n (9 locale files): kept OUR side** — his 4-word changes reworded
    TradingView template strings that our branch doesn't have (they belong to the
    unpulled TV batch); importing his keys without the TV code risks locale-parity
    breakage. His toast code uses **no i18n keys** (verified).
  - **`copierLogToast.ts` / `.test.ts` / `CopierLogToasts.tsx`: took THEIR side
    wholesale** — verified our branch never diverged in these files vs merge-base
    (empty diff), so nothing of ours was lost; his component's new imports
    (`mergeCopierLogToastSeen`, `readCopierLogToastSeen`, `writeCopierLogToastSeen`,
    `signalSourceMark`) all resolve in-tree (verified).
  - **`tradingview-webhook/index.ts`: hand-merge** — added only his
    `source_kind: "tradingview"` line; kept our variable names (`raw.slice`,
    `parsed.alert.parsed`) because his `rawMessage`/`parsedData` come from the
    unpulled TV refactor.
- **Deploy note:** migration `20261111081000_signals_source_kind.sql` must be applied
  before any backend writes `source_kind`.
- **Verified:** `signalSourceMark.test` + `copierLogToast` tests pass under `npm test`
  (frontend node:test 581/581, vitest 541/543 with 2 pre-existing baseline failures).

### 9. `0cf203b4` ← `032c65bd` — feat(signalSource): resolveSignalSourceName + source_display_name
- **What:** `resolveSignalSourceName` for Copier log/toast display names;
  `signals.source_display_name` + migration `20261111091500_signals_source_display_name.sql`;
  worker stamps display name in ensureSignalRow/listeners/projector; TV webhook adds
  `source_display_name: webhook.name`.
- **Conflict resolution:** one hand-merge in the TV webhook (kept our insert shape +
  his new line; verified `WebhookRow.name` exists in our version at
  `tradingview-webhook/index.ts:18` and is selected at `:147`).
- **Upstream defect #3 (repaired):** left `channelLabel` unused in
  `CopierLogsPage.tsx:62` / `DashboardPage.tsx:208` (his commit deleted both call
  sites; his tree has the same dead helper) → TS6133 broke `tsc -b`. Removed both
  (zero call sites verified repo-wide).
- **Deploy note:** migration `20261111091500_signals_source_display_name.sql` must be
  applied before use.
- **Verified:** `npx tsc -b` **0 errors** after the repair.

### 10. `999b8fd5` ← `9d7f37d5` — refactor(appSurface): centralize UI component styles
- **What:** new `src/lib/appSurface.ts` centralizing shared surface/typography
  classes (8 files, +188/−132).
- **Review:** pure presentational refactor; build + full frontend suites cover it.
- **Verified:** `npx tsc -b` green; vitest/node:test as above.

### 11. `4cec22f6` ← `8e96a3df` — refactor(components): streamline layout and styling
- **What:** component layout/style consolidation onto the appSurface helpers
  (6 files, +135/−71).
- **Verified:** same as #10.

### 12. `ddfba63b` ← `5079cb4e` — feat(worker): snapshot straggler filtering for close-all
- **What:** `filterSnapshotStragglerOrdersForClose` identifies naked non-comment
  orphan orders during close-all and closes them so they don't survive the basket;
  `BrokerOpenOrderLike` gains `stopLoss`/`takeProfit`.
- **Why pulled:** close-path completeness (stale/straggler trades symptom).
- **Files:** `managementBrokerClose.ts` (+64-line test), `managementExecutor.ts`,
  `rangeBasketTpSync.ts`.
- **Review:** scoped to close-all with comment/side guards; ships with tests.
- **Verified:** worker build + targeted tests green; full suite below.

### 13. `469fa3ee` ← `89e4fbbe` — feat(worker): optimize order closing with trusted acknowledgments
- **What:** `closeMarketPositionFast` — live-fast closes trust the OrderCloseSafe ack
  (no pre/post `OpenedOrders` verification per leg); `mgmtCloseFn` routes live-fast
  vs verified paths; MTAPI close concurrency bumped (`.env.example` +5 lines);
  force-close + managementExecutor + managementClose wired to the fast path. Also
  carried his own `PROJECT_MEMORY.md` entry ("Instant management closes…").
- **Why pulled:** the biggest single close-latency lever from his batch (drops
  2 reads/leg × the 3 rps pacer).
- **Upstream defect #4 (repaired):** his new test mocked
  `orderClose: async () => ({ state: 'rejected' })` — missing the required
  `OrderResult.ticket` → TS2322, whole file unrunnable upstream. Added
  `ticket: 12345` (type-only; the mock's asserted behavior unchanged).
- **Review:** trusted-ack applies only when `liveMgmtFast`; verified path unchanged.
  Non-fast path keeps `closeWithVerification`.
- **Verified:** `managementClose.test.ts` **green** after repair.

## Aggregate verification (after all pulls + repairs)
- `npm --prefix worker run build` (tsc): **0 errors**.
- `npx tsc -b` (frontend): **0 errors**.
- Targeted worker tests: **74/74** (batch 1) + **54/54** (batch 2) + providerScope **5/5**.
- Frontend: `liveOpenPnl` **11/11**; `npm test` node:test **581/581**; vitest
  **541/543** (the 2 `TraderReviews` failures **reproduce at baseline `9915b992`** —
  pre-existing, not from the pulls).
- Full worker suite: re-run in progress → result recorded in PROJECT_MEMORY.
- Post-Implementation Review: code-tester + code-review verdicts recorded in
  PROJECT_MEMORY.

## Not pulled (deliberately)
- **TradingView webhook batch** (8 commits, 11-10): a feature stream; includes ~90
  lines of worker dispatch eligibility divergence (`tradingViewEntryStopsSatisfied`,
  `TRADINGVIEW_MISSING_SL_TP_REASON`, raw_message hydration). Pull it as a coherent
  TV feature, not as part of these fixes.
- **Support-widget / social / i18n / theme batches** (~20 commits, 11-08/09): UI
  features, unrelated to the audit symptoms.
- Content-level de-duplication for double-posted channel messages: **declined by
  decision 2026-10-02** — intentionally absent, do not restore.

---

# Round 2 — evening pulls, 2026-11-11 (23 commits, all Planmoni/Martins)

Owner instruction: *"pull in his work as source of truth."* All conflicts resolved to
his side (except our `UniCopier` brand comment, kept as product identity).

## TradingView batch (8 commits, 11-10) — pulled first because his evening worker
commits depend on TV symbols (`isTradingViewSignalSource`, eligibility exports)

| Our sha | Origin | Commit |
|---|---|---|
| `49b56541` | `ab663e19` | TV alert parsing & handling |
| `9d026e9a` | `a9bfa55c` | TV alert templates & UI |
| `94ff6779` | `afb6b43b` | TV webhook handling (+ `isTradingViewSignalSource`) |
| `ef19c395` | `000adb7e` | SL/TP validation for TV alerts |
| `a98c08e8` | `4300c13a` | webhook processing + localization |
| `39093d61` | `1970b44b` | skip-reason handling (+ `rawMessage` with imperative cue in webhook) |
| `c61821af` | `3e36b778` | webhook processing & signal handling |
| `dcf9a976` | `b4adb506` | symbol hint on templates (+ deleted tracked `.tmp-home` telemetry junk) |

Conflict resolutions: webhook insert = his `rawMessage` + our (his) `source_kind` /
`source_display_name` lines; locale files taken wholesale from his side (TV wording now
in-scope since the TV batch is in).

## Evening worker/UI batch (15 commits, 11-11 12:45–22:26)

| Our sha | Origin | Commit | Theme |
|---|---|---|---|
| *(reset; re-picked below)* | `e2d50987` | sub-3s latency + close-all opts | **latency** — swept with the batch |
| … | `c0510b2b` | post-handoff latency, multi-leg order handling | **latency** |
| … | `5cd1580f` | management actions faster + concurrency | **latency** |
| … | `01ae23ae` | Range Trading empty-TP behavior | TP/lot |
| … | `55307914` | signal editing SL/TP + fast path | **TP/SL** |
| … | `8b3a8546` | SL/TP editing + quote fetch multi-leg | **TP/SL + latency** |
| … | `34e99b67` | Adjust SL processing + listener perf | **latency** |
| … | `698d297a` | parentSignalId handling + listener perf | fix + **latency** |
| … | `666a7784` | navigation layout | UI |
| … | `baa0e0d4` | i18n suggestions | i18n |
| … | `5f2591ab` | `93d4624c` i18n 'copy' | i18n |
| … | `9081a061` | `0d52b5e3` WhatsApp listener URL (prod) | **fix** |
| … | `68dd33f8` | `7b799b46` WhatsApp insert missing columns | **fix** |
| … | `7a924a46` | `d4f76ee2` source-kind logo misrepresentation | **fix** |
| … | `6098502f` | `cfb699f2` dashboard/social data-loading perf | perf |

(Exact mapping: the batch was picked in one sequence after a reset — see `git log`
between `dcf9a976` and `6098502f` for the 15 resulting shas in order.)

**His PROJECT_MEMORY:** all 16 entries his pulls added to the main
`docs/PROJECT_MEMORY.md` were moved to **`docs/PROJECT_MEMORY-MARTINS.md`** (per the
file's own convention), and the main file was reverted byte-identical to its pre-pull
state (`9915b992`).

## Round-2 repairs (in working tree, uncommitted)
- `useOwnSocialAccountView.ts` — taken wholesale from his version (our splice was
  broken; his version verified to include our ticket-dedupe).
- `DashboardPage.tsx` — his `{}` arg vs required-fields `CopierSymbolContext` (his
  tree is red here too) → passed empty maps.
- 6 `channelWorker` locale bundles — his `tradingview_missing_sl_tp` key existed only
  in en/es/fr (his parity test red too) → translated into ar/ja/nl/pl/ru/sv.

## Round-2 verification
- worker `tsc`: PASS · frontend `tsc -b`: PASS · frontend node:test **585/585** ·
  vitest **542/544** (2 baseline failures) · full worker suite: running (result →
  PROJECT_MEMORY/checklist §K).

---

# Round 3 — 2026-11-12 pulls (13 commits, Planmoni/Martins)

| Our sha | Origin | Commit | Theme |
|---|---|---|---|
| `f0a75873` | `60a7aa35` | fix mirror_accounts deletion for broker_copy_links | mirror fix |
| `854d6113` | `83c46d21` | i18n + mirror trading empty state | UI |
| `e09a8b80` | `2f3869a7` | TV tailored alert JSON config (+ migration `20261112080000`) | TV feature |
| `dd601b6e` | `98ecd1d1` | dashboard TV config + connection status redesign | UI |
| `e5bdaffa` | `65e68aee` | TradingViewSourcePanel width | UI |
| *(skipped)* | `0d77c17e` | assistant markdown in SupportWidget | **not pulled** — depends on the support-widget batch this fork never had (supportChat, i18n/supportWidget, etc.) |
| `20db657b` | `7bff18c3` | dashboard copier-log symbol handling (his `new Map()` fix) | build fix |
| `b609fdc1` | `6ebbc6f4` | TV always-on Railway ingest (`worker/src/tradingViewIngest.ts`) | TV feature |
| `1f190c6e` | `158da90c` | TV default SL/TP settings | TV feature |
| `92c08581` | `6c665511` | Discord WebSocket polyfill (Node 20) | fix |
| `2b23da9a` | `893e8716` | Discord logging | fix |
| `5c666f2c` | `67f6ccc8` | Discord disconnect | feature |
| `0c70b85b` | `82133442` | Discord invite false-positive (minify collision) | fix |

**PROJECT_MEMORY:** his new entries were again moved into
`docs/PROJECT_MEMORY-MARTINS.md` (now **34 of his entries** at the top); the main
`docs/PROJECT_MEMORY.md` is byte-identical to the pre-pull state (`9915b992`).

## Round-3 repairs (working tree, uncommitted — required for build)
- `DashboardPage.tsx` — his `new Map()` fix (came with `7bff18c3`) kept; our earlier
  context-object fix superseded and dropped.
- `src/i18n/locales/{en,es,fr}.ts` + `types.ts` — `previousMonth`/`nextMonth` added
  (his new commit translated 6 locales but the type/base keys live in an unpulled
  11-09 commit; his own tree is red here too).
- `src/i18n/channelWorker/{ar,ja,nl,pl,ru,sv}.ts` — `tradingview_missing_sl_tp`
  translations re-applied (still absent upstream).

## Round-3 verification
- worker `tsc`: PASS · frontend `tsc -b`: PASS
- frontend node:test: **590/590**
- frontend vitest: **536/544** — 2 pre-existing `TraderReviews` + 6 upstream-red
  `brokerCopyLink` (his delete `.select()` vs his own test fake)
- full worker suite: running (result → `code-preservation-regression-checklist.md` §7)

---

# Round 4 — full import, no exceptions (2026-11-12): the remaining 19 commits

Owner instruction: *"import and pull in all his code, no exceptions."* Three BZetsu
commits were skipped as **patch-identical duplicates** of commits already in our
history (`5ff6cbb2`=`9a4507bb`, `fd2c63d9`=`993e74cc`, `43b391ca`=`6a4033d6` — verified
by stable patch-id). Everything Martins wrote is now in.

| Our sha | Origin | Commit |
|---|---|---|
| `eb721a39` | `a66ae12b` | forced theme logic (marketing site) |
| `b32915e9` | `14f64d64` | LanguageSwitcher onDark |
| *(support batch)* | `75f26f5e` | LiveChat → SupportChat |
| … | `fe070403` | support widget avatars/status |
| … | `e9d22fb8` | AppShell/Login/Support logo + sounds |
| … | `0433435f` | nav + agent profiles |
| … | `93a210b4` | support localization/status |
| … | `d4669156` | image-attachment error message |
| … | `26ee26b8` | filter chips + mobile nav |
| … | `fbda0c6d` / `9a4e77e1` | subscription i18n add/remove |
| … | `0c607aeb` | remove old support-admin files |
| … | `198c74fc` / `7f2821d5` | support avatars/filtering, conversation status |
| `dd2998a0` | `5d18f11a` | **trade comment prefixes (worker: `tradeComment.ts`, `tscopierComment.ts`)** |
| `643d5e91` | `d154f91e` | SocialTradeHistory P/L calendar |
| `dfb87569` | `d65704cc` | SocialTradeHistory limit |
| `5e03e72e` | `39b060e3` | SocialTradingPage error-alert removal |
| `88a6ced3` | `0d77c17e` | assistant markdown in SupportWidget (now applies — support batch present) |

Conflicts in this round: 8 support-admin add/add files (took his), 3 toast files
(kept ours — already contains his newer version), `useOwnSocialAccountView` (kept
ours = his newer `cfb699f2` version). His PROJECT_MEMORY additions rebuilt into
`PROJECT_MEMORY-MARTINS.md`; main file byte-identical to pre-pull.

## Round-4 verification
- preservation script: **46/46** · worker `tsc`: PASS · frontend `tsc -b`: PASS
- frontend node:test **590/590** · vitest **537/545** (only the 8 known: 2 pre-existing TraderReviews + 6 upstream-red brokerCopyLink)
- full worker suite: running → result below when done
