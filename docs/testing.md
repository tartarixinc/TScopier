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

CI runs all jobs on **every push to any branch** (see `.github/workflows/typescript-ci.yml`).

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

### Latency tests (worker)
Perf budgets for hot paths in the copier pipeline. Files: `worker/src/**/*.perf.test.ts`

| Path | Budget (median) |
|------|-----------------|
| `parseChannelMessageSync` | 12 ms |
| `classifySymbol` | 0.15 ms |
| `evaluateParsedSignalExecutionEligibility` | 2 ms |
| `buildIdempotencyKey` | 0.25 ms |
| `parallelMap(120, c=8)` | 250 ms |

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
