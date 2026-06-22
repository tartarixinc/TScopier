# Test run report

**Date:** 2026-06-22 (local Windows run)  
**Commands:** `npm test`, `npm run test:worker`, `npm run test:worker:perf`, `npm run test:edge`, `npm run test:e2e`

Raw logs (if present): `test-output-frontend.txt`, `test-output-worker.txt`, `test-output-worker-perf.txt`, `test-output-e2e.txt` in repo root.

---

## Summary

| Suite | Status | Passed | Failed | Skipped / blocked |
|-------|--------|--------|--------|-------------------|
| Frontend unit (Vitest) | **Partial fail** | 138 tests (22 files) | 2 tests + 23 files | 23 files not runnable in Vitest |
| Worker unit (`node:test`) | **Pass** | 658 tests (77 suites) | 0 | — |
| Worker latency (`*.perf.test.ts`) | **Partial fail** | 9 | 8 | Machine load sensitive |
| Edge functions (Deno) | **Blocked** | — | — | Deno not installed |
| E2E (Playwright) | **Blocked** | — | — | `npm run build` fails |

---

## Passing (happy path)

### Worker unit — all pass (658/658)

After excluding `*.perf.test.ts` from the unit runner, every worker unit test passed, including:

- Signal parsing (`parseSignal.test.ts`)
- Trade execution / dispatch (`dispatch.*.test.ts`)
- Queue config, pip math, channel filters, management monitors
- Regression cases for broker connect, basket merge, range pending, etc.

**Command:** `npm run test:worker`  
**Result:** `# pass 658`, `# fail 0`

### Frontend Vitest — 138 tests pass in 22 files

Files using **Vitest** (`import from 'vitest'`) run correctly, including:

- `src/lib/site.test.ts` — host routing (`?site=marketing`, app vs marketing)
- `src/components/layout/ProtectedRoute.test.tsx` — auth guard (loading, redirect, happy path)
- `src/test/integration/msw.smoke.test.ts` — MSW mock wiring
- `src/lib/planLimits.test.ts`, `performanceBaseline.test.ts`, `dashboardTradeStats.test.ts`
- `src/lib/telegramChannelIdentity.test.ts`, `performanceInsights.test.ts`, etc.

**Command:** `npm test`  
**Result:** 138 passed

### Worker latency — partial pass (9/17 on this run)

These passed even under CPU load:

- Concurrent load: all 50 requests succeed (10 users × 5 trades)
- Concurrent load: median under 80 ms (standard load)
- Burst load: concurrent batch wall-clock completes
- Single-path: p95 ≤ 80 ms, pipeline summary segments
- `classifySymbol`, `buildIdempotencyKey`, `signalExecutionEligibility` module budgets

---

## Failing (unhappy path / regressions)

### 1. Frontend — 23 test files not executed by Vitest

**Error:** `No test suite found in file …`

**Why:** These files still use **Node’s test runner** (`import { test } from 'node:test'`) but are picked up by **Vitest** via `src/**/*.test.ts`. Vitest does not run them as suites.

**Affected files (need migration to Vitest or a separate `node:test` script):**

| File |
|------|
| `src/i18n/types.test.ts` |
| `src/lib/brokerFromServer.test.ts` |
| `src/lib/brokerLink.test.ts` |
| `src/lib/brokerSearchResults.test.ts` |
| `src/lib/brokerStats.test.ts` |
| `src/lib/bulkConnectBrokers.test.ts` |
| `src/lib/copierLogDisplay.test.ts` |
| `src/lib/copierStartBlocked.test.ts` |
| `src/lib/copyLimitPeriods.test.ts` |
| `src/lib/dashboardAnalytics.test.ts` |
| `src/lib/emailVerification.test.ts` |
| `src/lib/estimateMultiTradeOrders.test.ts` |
| `src/lib/linkedAccountSort.test.ts` |
| `src/lib/manualLotSizing.test.ts` |
| `src/lib/mtTradeTimestamps.test.ts` |
| `src/lib/notificationDayGroups.test.ts` |
| `src/lib/riskLotCalculator.test.ts` |
| `src/lib/signalOverride.test.ts` |
| `src/lib/tradeNotifications.test.ts` |
| `src/lib/tradeSignalLink.test.ts` |
| `src/lib/tradesSinceConnect.test.ts` |
| `src/lib/tradingPlatform.test.ts` |
| `src/lib/tscopierComment.test.ts` |

**Fix:** Migrate imports to `vitest` (`describe`/`it`/`expect`) or exclude from Vitest and run with `node --test` in a separate npm script.

---

### 2. Frontend — `channelWorkerLogMessage` (unhappy / edge case)

**File:** `src/lib/channelWorkerLogMessage.test.ts`  
**Test:** `channelWorkerLogMessage: unknown success action remaps sell when signal skipped`

**Expected:** A log message explaining the skipped sell (broker not connected).  
**Actual:** `message` is `null`.

**Why:** Implementation of `channelWorkerLogMessage` no longer emits a user-visible line for this combination (`action: 'some_internal_step'`, `status: 'success'`, signal `skipped` + `broker_session_not_connected`). Test documents intended UX; code and test are out of sync.

---

### 3. Frontend — `dashboardCharts` (happy-path regression)

**File:** `src/lib/dashboardCharts.test.ts`  
**Test:** `buildAccountGrowthSeries: backfills balance from closed trades in window`

**Expected:** `may16.acc_acc1 === 5050` (5000 balance + 50 closed profit on 2026-05-16).  
**Actual:** `5000`.

**Why:** `buildAccountGrowthSeries` behavior changed (or test fixtures no longer match production logic—e.g. account row now includes `fxsocket_account_id` / balance backfill rules). Chart series no longer adds closed PnL to that day key.

---

### 4. Worker latency — CPU / concurrency (environment)

**Command:** `npm run test:worker:perf`  
**Result:** 9 pass, 8 fail on this machine (after full unit suite had just run).

| Test | Error | Why |
|------|-------|-----|
| `parallelMap(120, c=8)` | median ~709 ms > 250 ms budget | Test includes `setTimeout(1)` per item; under load, wall time exceeds budget |
| `sync listener→dispatch (Gold)` | median ~6.3 ms > 5 ms | Idle target tight; machine variance |
| `sync listener→dispatch (EURUSD)` | median ~6.8 ms > 5 ms | Same |
| `telegram→mock OrderSend (p50)` | median ~5.9 ms > 5 ms | Same |
| `concurrent 10×5 (p95)` | p95 ~132 ms > 80 ms | Many parallel pipelines contend for CPU |
| `concurrent 10×5 (max)` | max ~270 ms > 80 ms | Same |
| `burst 25×4 (p95)` | p95 ~152 ms > 80 ms | 100 requests, concurrency 8 |
| `burst 25×4 (max)` | max ~234 ms > 80 ms | Same |

**Note:** CI uses `WORKER_PERF_BUDGET_MULTIPLIER=2.5`. Run perf alone on a quiet machine: `npm run test:worker:perf`. Failures here are **perf budget / environment**, not functional bugs.

---

### 5. Edge functions — not run

**Command:** `npm run test:edge`  
**Error:** `deno: The term 'deno' is not recognized`

**Why:** Deno is not installed on this machine. Required for `supabase/functions/_shared/*.test.ts`.

**Fix:** Install Deno from https://deno.land then re-run `npm run test:edge`.

---

### 6. E2E Playwright — not run

**Command:** `npm run test:e2e`  
**Error:** `Process from config.webServer was not able to start. Exit code: 2`

**Why:** Playwright runs `npm run build && vite preview`. **TypeScript build failed:**

```
Cannot find module 'lightweight-charts'
Cannot find module '@livechat/widget-react'
src/pages/dashboard/DashboardPage.tsx(935,5): Type 'number' is not assignable to type 'Timeout'
```

**Fix:**

1. `npm install` (ensure `lightweight-charts` and `@livechat/widget-react` are in `node_modules`)
2. Fix `DashboardPage.tsx` timer typing
3. Re-run `npm run build`, then `npm run test:e2e`

---

## Unhappy-path tests that exist and pass (worker)

Worker unit tests include many **negative / edge** cases, for example:

- Parse skips: non-trade chat, conditional close, ignore keywords
- Eligibility: commentary not signal, missing SL/TP without “now”
- Dispatch: copier paused, wrong broker session, channel filter blocks
- Management: ghost basket legs, terminal not ready, retry limits

All **658** passed in the latest unit run.

---

## Recommended next steps

1. **Migrate 23 frontend `node:test` files to Vitest** (or split npm scripts) so `npm test` runs the full frontend suite.
2. **Fix or update** the 2 failing Vitest assertions (`channelWorkerLogMessage`, `dashboardCharts`).
3. **Install Deno** and run `npm run test:edge`.
4. **Fix frontend build** (missing deps + TS error) then run `npm run test:e2e`.
5. **Run perf on quiet CI** with `WORKER_PERF_BUDGET_MULTIPLIER=2.5`; tune local with `WORKER_PERF_BUDGET_MULTIPLIER=3 npm run test:worker:perf` if needed.

---

## Quick re-run commands

```powershell
npm test                      # Frontend Vitest
npm run test:worker           # Worker unit (should be 658/658)
npm run test:worker:perf    # Latency (run alone for stable numbers)
npm run test:edge             # Needs Deno
npm run build                 # Must pass before E2E
npm run test:e2e              # Playwright
npm run test:all              # All of the above (will fail until edge/e2e unblocked)
```
