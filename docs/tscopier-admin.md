# tscopier-admin — internal operations dashboard (separate repository)

**Repository:** `tartarixinc/tscopier-admin` (private; local clone at `/home/jbzetsu/projects/tscopier-admin`).
**Production branch:** `main` (the only production branch — this repo is not a fork workflow;
`origin` *is* the production repository).
**Deployed at:** `panel.tscopier.cloud` (Netlify, builds `main` automatically; `netlify.toml`
in the repo handles build/publish and the SPA redirect).

## What it is

`tscopier-admin` is the **internal operations dashboard** for the copier platform. It is a
separate standalone app (Vite 5 + React 18 + TypeScript + Tailwind 3 + Recharts + Lucide),
independent of the main product repository. It is where the team watches production and
staging: users, signals, trades, the listener, workers, errors and billing.

It is **read-mostly**: pages query Supabase through the anon key with row-level security
gated on `is_admin()` (the original spec — `docs/admin-panel-spec.md` in this repository —
described a read-only service-role design; the current app uses RLS-gated access). No
production data is written from here except explicit admin actions (e.g. bulk ban of spam
signups).

## What it does — page map

| Area | Pages |
|---|---|
| Health & overview | `OverviewPage`, `SystemHealthPage`, `WorkerLeasesPage`, `ErrorsPage`, `ErrorsAnalyticsPage`, `DeadLettersPage` |
| Users | `UsersPage`, `UserDetailPage` (profile, copier state, payments, worker-lease Telegram status), `SubscriptionsStatsPage`, `AffiliatesPage` |
| Signals | `SignalsPage`, `SignalStatsPage`, `ChannelSignalProfilesPage`, `TelegramChannelsPage` |
| Trades | `TradesPage`, `TradesAnalyticsPage`, `OpenPositionsPage`, `TradeExecutionLogsPage`, `CopierLogsPage`, `BrokerErrorsPage`, `BrokerAccountsPage` |
| Pipeline | `CopierEnginePage`, `ListenerEventsPage`, `TradeExecutionLogsPage`, backtests (`BacktestRunsPage`, `BacktestRunDetailPage`) |
| Telegram | `TelegramSessionsPage`, `TelegramAuthPendingPage`, `MtapiReconnectsPage` |
| Assistant / AI | `AssistantThreadsPage`, `AssistantThreadViewPage` |
| Email & alerts | `EmailsPage`, `AlertsPage` |
| System | `AppSettingsPage`, `PresetsPage`, `ReportsPage` |

(Exact nav labels live in `AdminShell`.)

## Environments

The app reads **two Supabase projects** and switches at runtime from the topbar toggle
(stored in `localStorage[tscopier_admin_env]`; a STAGING badge is shown while on staging):

| Env | Supabase project | Netlify variables |
|---|---|---|
| PROD | `sxkpcovbyaficvtkpsdo` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| STAGING | `axdcledcyhyvzrnfkwat` | `VITE_SUPABASE_URL_STAGING`, `VITE_SUPABASE_ANON_KEY_STAGING` |

Sessions are keyed per environment so logging into one does not silently authorise the other.

## Access and CAPTCHA

- Sign-in is Supabase email + password; authorisation comes from `is_admin()` in the
  database (RLS), not from a client-side password gate.
- Since **2026-11-02** the login also carries a **Cloudflare Turnstile** captcha token —
  Supabase Auth CAPTCHA is enforced project-wide, and this app originally had no widget,
  which locked out every admin with `captcha protection: request disallowed (no
  captcha_token found)`. The widget was added to `src/pages/LoginPage.tsx`
  (`@marsidev/react-turnstile`, gated by `VITE_TURNSTILE_SITE_KEY`), pushed to `main` as
  `aa1660f`. Full write-up: `docs/incidents/incident-2026-11-02-admin-panel-captcha-lockout.md`.
  Remaining owner checks from that incident: Cloudflare widget hostname list includes
  `panel.tscopier.cloud`, and the Netlify env var is exactly `VITE_TURNSTILE_SITE_KEY`.

## Commands (run inside the tscopier-admin clone)

| Command | Notes |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `vite build` → `dist/` |
| `npm run lint` | ESLint — must be 0 errors |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.app.json` |
| `npm run preview` | Preview the production build locally |

There is **no test suite** in that repository; verification is typecheck + lint + build.

Its own `AGENTS.md` and `docs/PROJECT_MEMORY.md` (inside the tscopier-admin clone) hold the
working rules and changelog for that app — they are branch/repo-specific and do not live here.

## How the admin surfaces relate

| Surface | Repository | Audience | Purpose |
|---|---|---|---|
| **tscopier-admin** | `tartarixinc/tscopier-admin` (separate) | the team | deep operations dashboard for TScopier prod + staging (`panel.tscopier.cloud`) |
| **`apps/backoffice`** | this repository | the team | Unicopier's in-repo backoffice (admin actions against the Unicopier backend) |
| **`apps/support-admin`** (uni Support) | this repository | support agents + admins | answering customer chats and tickets (`docs/support-admin.md`) |

Do not confuse them: tscopier-admin predates the in-repo backoffice and covers the TScopier
projects; the backoffice and uni Support are Unicopier-side.

## Related docs

- `docs/incidents/incident-2026-11-02-admin-panel-captcha-lockout.md` — the CAPTCHA lockout
  and fix.
- `docs/admin-panel-spec.md` — the original build specification for an admin panel
  (historical reference; stack details have since drifted).
- `docs/backoffice-deployment.md` — the *other* admin (`apps/backoffice`).
- `docs/support-admin.md` — the uni Support desk app.
