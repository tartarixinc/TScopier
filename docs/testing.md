# Testing

## Stack

| Layer | Tool | Command |
|-------|------|---------|
| Worker unit | Node `node:test` | `npm run test:worker` |
| Frontend unit | Vitest + Testing Library + MSW | `npm test` |
| Edge functions | Deno test | `npm run test:edge` |
| E2E | Playwright | `npm run test:e2e` |
| All | — | `npm run test:all` |

CI runs all of the above on **every push to any branch** (see `.github/workflows/typescript-ci.yml`).

## First-time local setup

```bash
# Root (frontend unit + E2E runner)
npm ci
npx playwright install chromium

# Worker
npm ci --prefix worker

# Deno (edge tests) — install from https://deno.land
deno --version
```

## Commands

```bash
npm test              # Vitest unit tests (src/)
npm run test:watch    # Vitest watch mode
npm run test:worker   # Worker unit tests
npm run test:edge     # Supabase _shared Deno tests
npm run test:e2e      # Playwright (builds app + runs browser)
npm run test:all      # Full suite
```

## MSW (integration mocks)

Handlers live in `src/test/msw/handlers.ts`. Vitest starts the MSW server in `src/test/setup.ts`. Add mocks there when testing components that call APIs.

## E2E notes

- Playwright serves the production build via `vite preview` on port 4173.
- On localhost, the app host is the default; use `?site=marketing` for marketing pages.
- E2E does not use snapshots (per project decision).

## Troubleshooting `npm install`

If install fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `unable to verify the first certificate`, npm cannot validate TLS to `registry.npmjs.org`. Common causes: corporate proxy/VPN SSL inspection or outdated CA store on Windows.

1. Retry off VPN or on a network without SSL interception.
2. If IT provides a root CA, configure npm once: `npm config set cafile "C:\path\to\corp-root.pem"`.
3. After `npm install` succeeds, run `npx playwright install chromium` and commit the updated `package-lock.json`.
