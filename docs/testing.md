# Testing

## Stack

| Layer | Tool | Command |
|-------|------|---------|
| Worker unit | Node `node:test` | `npm run test:worker` |
| Worker latency | Node `node:test` + perf budgets | `npm run test:worker:perf` |
| Frontend unit | Vitest + Testing Library | `npm test` |
| Frontend integration | Vitest + MSW | `npm test` (includes `src/test/integration`) |
| Edge functions | Deno test | `npm run test:edge` |
| E2E smoke | Playwright | `npm run test:e2e` |
| E2E regression | Playwright `@regression` | `npm run test:regression` |
| All | — | `npm run test:all` |

CI runs all jobs on **every push to any branch** (see `.github/workflows/typescript-ci.yml`):

| Job | What it runs |
|-----|----------------|
| `worker` | Unit tests + TypeScript build |
| `worker-perf` | Latency budgets (`*.perf.test.ts`) |
| `worker-load-smoke` | 500-user mixed load + mock FxSocket WS heartbeat |
| `frontend-unit` | Vitest |
| `frontend-build` | `tsc` + Vite build |
| `edge-functions` | Deno `_shared` tests |
| `e2e` | Playwright |

Live FxSocket (`npm run load:ws:live`) is **local/manual only** — requires real account UUID + API key.

Latest local run details and failure analysis: **[test-results.md](./test-results.md)**.

## First-time local setup

```bash
npm ci
npx playwright install chromium
npm ci --prefix worker
deno --version   # https://deno.land
```

## Commands

```bash
npm test                    # Vitest (unit + integration)
npm run test:watch          # Vitest watch mode
npm run test:worker         # Worker unit tests (~300+ cases)
npm run test:worker:perf    # Worker latency / perf budgets
npm run test:edge           # Supabase _shared Deno tests
npm run test:e2e            # Playwright smoke + regression
npm run test:regression     # Playwright @regression only
npm run test:all            # Full automation suite
```

## Test types

### Unit tests
Pure functions: signal parsing, pip math, dashboard analytics, plan limits, broker helpers.

- Frontend: `src/**/*.test.ts(x)` via Vitest
- Worker: `worker/src/**/*.test.ts` via Node test runner
- Edge: `supabase/functions/_shared/**/*.test.ts` via Deno

### Integration tests (MSW)
API boundaries mocked without a live Supabase project.

- Handlers: `src/test/msw/handlers.ts`
- Setup: `src/test/setup.ts`
- Examples: `src/test/integration/`, `ProtectedRoute.test.tsx`

### Regression tests
Stable routes and host switching that previously broke.

- E2E: `e2e/regression.spec.ts` (tag `@regression`)
- Lib regression: existing Vitest files under `src/lib/` and `worker/src/`

### Latency tests (worker) — Telegram → MetaTrader / FXSocket

Product targets for **worker-side** processing (after Telegram delivers the message, before live broker RTT):

| Segment | Target (p50) | Max (p95 / hard) |
|---------|--------------|------------------|
| Listener → dispatch ready (parse + eligibility) | **5 ms** | — |
| Full path → first `OrderSend` (mock-warm caches) | **5 ms** | **80 ms** |
| `parseChannelMessageSync` alone | **5 ms** | — |

Files:
- `worker/src/telegramToTradePipeline.perf.test.ts` — end-to-end worker simulation
- `worker/src/test/telegramPipelineStages.ts` — stage harness
- `worker/src/test/pipelineLatencyBudgets.ts` — constants

**Not included in unit perf suite** (track separately in production logs via `pipelineTimestamps`):
- gramjs Telegram network delivery
- Redis queue / HTTP push between listener and trade worker
- Live FXSocket / MT4 / MT5 API round-trip

Production hooks: `pipelineSummaryPayload()` fields `parse_ms`, `prep_ms`, `send_order_prep_ms`, `broker_send_ms`, `total_ms`.

### Concurrent load (multi-user × multi-trade)

Simulates many users each executing multiple trades at once (unique user/signal/broker ids, mixed symbols):

| Scenario | Shape | Concurrency |
|----------|-------|-------------|
| Standard load | **10 users × 5 trades** (50 requests) | 8 |
| Burst load | **25 users × 4 trades** (100 requests) | 8 |

### Heavy stress load (5k–10k users) — CLI

Simulates a **full fleet**: thousands of users, **4–10 Telegram signals each**, assigned to **MT4 / MT5 / FXSocket** round-robin. Reports:

- **Pipeline funnel** — how many signals reached each stage (telegram → heuristic → parse → eligible → dispatch → broker OrderSend)
- **User delivery** — % of users where **all** signals reached the trading platform
- **Signal delivery rate** — % of total signals that reached broker
- **Latency** — min / p50 / p95 / p99 / max (worker-side, successful only)
- **By platform** — MT4, MT5, FXSocket breakdown

```powershell
# Default: 5,000 users × 4–10 signals (~35k signals)
npm run test:load:stress

# Quick smoke (500 users)
npm run test:load:smoke

# Custom scale
$env:LOAD_USERS="10000"
$env:LOAD_MIN_SIGNALS="4"
$env:LOAD_MAX_SIGNALS="10"
$env:LOAD_CONCURRENCY="32"
$env:LOAD_WRITE_JSON="1"
npm run test:load:stress

# Mixed profile (~60% happy + heuristic/parse/eligibility/FxSocket broker failures)
$env:LOAD_PROFILE="mixed"
npm run test:load:stress

# All failure paths only
$env:LOAD_PROFILE="unhappy"
npm run test:load:stress

# FxSocket WebSocket heartbeat (in-process mock; set LOAD_WS_LIVE=1 for real FxSocket)
$env:LOAD_WS_ACCOUNTS="500"
$env:LOAD_WS_DURATION_MS="15000"
$env:LOAD_WS_HEARTBEAT_MS="5000"
npm run test:load:stress

# Live FxSocket WS — requires real terminal UUIDs (from broker_accounts.fxsocket_account_id)
$env:LOAD_WS_LIVE="1"
$env:LOAD_WS_ACCOUNT_IDS="your-fxsocket-uuid:MT5"
$env:LOAD_WS_ACCOUNTS="1"
npm run test:load:stress
```

**Note:** This is a **worker-side simulation** (parse + dispatch + mock-warm OrderSend). It does not hit live Telegram or live MetaTrader terminals. Use production `pipelineTimestamps` logs for real broker RTT.

**Profiles:**
| Profile | Behavior |
|---------|----------|
| `happy` (default) | All signals are valid trades → broker OrderSend |
| `mixed` | ~60% happy + heuristic/parse/eligibility/FxSocket session/OrderSend/WS failures |
| `unhappy` | Rotates through every failure class |

**FxSocket:** All MT4/MT5 connectivity goes through [FxSocket](https://fxsocket.com/docs) REST (`OrderSend`) and WebSocket (live `account`/`positions`/`prices` streams). Non-happy broker failures simulate `keepSessionAlive` heartbeat loss, REST reject, and WS disconnect.

**WebSocket heartbeat:** Phase 3 of the load CLI opens many FxSocket WS clients with ping/pong keepalive (mock server by default). Unit tests: `telegramPipelineScenarios.test.ts`, `fxsocketWsClient.test.ts`.

Files:
- `worker/src/diagnostics/heavyTelegramLoad.ts` — CLI entry
- `worker/src/test/heavyTelegramLoadRunner.ts` — runner + report formatter

Files:
- `worker/src/telegramToTradePipeline.load.perf.test.ts`
- `worker/src/test/telegramPipelineLoad.ts`

Per-request budgets:
- **Single request (idle): p50 ≤ 5 ms**
- **Multi-user concurrent load: median / p95 / max ≤ 80 ms** (0 failures)
- Standard: **10 users × 5 trades** (50 requests), concurrency 8
- Burst: **25 users × 4 trades** (100 requests), concurrency 8

### Other latency tests (worker modules)

| Path | Budget (median) |
|------|-----------------|
| `classifySymbol` | 0.15 ms |
| `evaluateParsedSignalExecutionEligibility` | 2 ms |
| `buildIdempotencyKey` | 0.25 ms |
| `parallelMap(120, c=8)` | 250 ms |
| **Telegram → mock OrderSend (full worker path)** | **5 ms p50 / 80 ms p95** |

CI uses `WORKER_PERF_BUDGET_MULTIPLIER=2.5` for slower runners. Override locally:

```bash
WORKER_PERF_BUDGET_MULTIPLIER=3 npm run test:worker:perf
```

## E2E notes

- Playwright builds the app and serves via `vite preview` on port 4173.
- App routes: `/login`, `/dashboard`, etc. (default on localhost).
- Marketing: `/?site=marketing` or `VITE_DEV_SITE=marketing`.
- No snapshot tests (project decision).

## Troubleshooting `npm install`

If install fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, npm cannot validate TLS to `registry.npmjs.org`. Try off VPN, or configure a corporate root CA: `npm config set cafile "C:\path\to\corp-root.pem"`.

## Troubleshooting worker tests on Windows

Worker tests use `worker/scripts/run-tests.cjs` (cross-platform). If you see `Cannot find module 'undici'`, run `npm ci --prefix worker`.
