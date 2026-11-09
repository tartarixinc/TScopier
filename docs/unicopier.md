# Unicopier — product overview

Unicopier is a **Telegram signal copier**: it listens to Telegram channels, turns posted
trade signals into structured orders, and executes them on the user's broker account. It
began as a fork of TScopier's `migration` branch and shares that project's commit history —
on purpose, so future work can flow both ways (see `AGENTS.md` → *Repository & remotes*).

## What the product does

1. **Listen** — a worker connects to Telegram over MTProto (one connection per auth key)
   and receives messages from the channels a user has connected.
2. **Parse** — each message goes through an AI-assisted pipeline (regex → Cerebras OSS →
   GPT-4o fallback) that extracts action (buy/sell), symbol, entry, stop loss and
   take-profit levels, with dedupe protection so one message never executes twice.
3. **Execute** — a separate trade worker picks up parsed signals and places orders on the
   user's broker through FxSocket (MT4/MT5), with experimental cTrader support and the
   MTAPI stack in rollout. Orders can be market or pending (limit/stop), with layered
   take-profits, breakeven and partial-close management afterwards.
4. **Serve** — the web app (`app.…`) lets users connect channels and broker accounts, watch
   trades, and configure risk; the marketing site sells the product. One Netlify build
   serves both shells.

Domain cutover from `tscopier.ai` to `unicopier.com` is tracked in
`docs/domain-cutover-unicopier-com.md`.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | the web frontend (Vite + React 19, Tailwind) — product app **and** marketing site in one build |
| `worker/` | the MTProto listener + trade executor (Node, `telegram` lib), runs on Railway |
| `supabase/functions/` | Deno edge functions (auth, assistant, billing, support, …) |
| `supabase/migrations/` | SQL migrations (applied via Management API / scripts) |
| `apps/backoffice/` | Unicopier's in-repo admin UI (separate app) |
| `apps/support-admin/` | **uni Support** — the support desk for agents/admins (`docs/support-admin.md`) |
| `apps/docs/` | the docs site |
| `docs/` | project documentation, `PROJECT_MEMORY.md` changelog, incident reports, scratchpads |
| `scripts/` | local tooling (incl. the local-only `test-signal.mjs` pipeline test tool) |

`tscopier-admin` is **not** in this repository — it is a separate repo/ops dashboard
(`docs/tscopier-admin.md`).

## Remotes and branches

| Remote | URL | Role |
|---|---|---|
| `origin` | `github.com/BZetsu/Unicopier` | this project's home |
| `upstream` | `github.com/tartarixinc/TScopier` | source project (shared history; never push without explicit permission) |
| `bzetu` | `github.com/BZetsu/TScopier` | Netlify's deploy source for `migration.tscopier.ai` |

Development happens on `migration` (feature line) and `staging-merge` / `staging`
(promotion line). Promotion rules — staging first, production as a separate, explicit
decision — are in `AGENTS.md` and `docs/mtapi-rollout-plan.md`.

## Environments

| Layer | Where |
|---|---|
| Backend (Unicopier product data) | Supabase project **`supmsgcubipmmowrzoub`** (the "migration" backend — worker, app and the uni Support desk all point here) |
| TScopier staging / production (inherited) | Supabase `axdcledcyhyvzrnfkwat` (staging) and `sxkpcovbyaficvtkpsdo` (production) — used for upstream staging/promotion work |
| Worker (listener + trade worker) | Railway; `WORKER_SHARD_ID` / `WORKER_SHARD_COUNT` must match across replicas |
| Frontend + marketing | Netlify (build-time `VITE_*` env vars — changing one requires a redeploy) |
| Edge functions | Supabase (Deno), deployed with `npm run deploy:function <name>` |

Secrets never live in the repository; `.env.example` documents every variable.

## Admin and support surfaces

| Surface | Where | Purpose |
|---|---|---|
| uni Support desk | `apps/support-admin` in this repo | agents/admins answer customer chats and tickets (`docs/support-admin.md`) |
| Unicopier backoffice | `apps/backoffice` in this repo | internal admin actions on the Unicopier backend (`docs/backoffice-deployment.md`) |
| tscopier-admin | separate repo `tartarixinc/tscopier-admin` | deep ops dashboard for TScopier prod/staging, `panel.tscopier.cloud` (`docs/tscopier-admin.md`) |

All three password logins are subject to Supabase Auth **CAPTCHA (Turnstile) enforcement** —
each app must render the widget and send a `captcha_token`, or every sign-in fails with
`captcha protection: request disallowed (no captcha_token found)` (see
`docs/incidents/incident-2026-11-02-admin-panel-captcha-lockout.md`).

## Where to start reading

- `AGENTS.md` — working rules for agents (commands, push policy, promotion rules).
- `docs/PROJECT_MEMORY.md` — the changelog: every notable fix/incident, plain English +
  technical, newest first.
- `docs/railway-architecture.md` — how the worker services fit together.
- `docs/mtapi-rollout-plan.md` — the MTAPI production rollout waves.
- `docs/signup-spam-protection-setup.md` — CAPTCHA / abuse-protection setup.
- `docs/incidents/` — rendered incident reports (PDF + markdown).
