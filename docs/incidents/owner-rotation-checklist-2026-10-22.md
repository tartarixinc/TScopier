# Credential rotation & follow-ups — Railway breach (2026-10-22)

**For:** project owner (Supabase account owner) — standup handoff
**From:** incident response, 2026-10-22
**Companion docs:** `docs/incidents/incident-2026-10-22-railway-env-breach.md` (full incident record)

**Context:** Railway confirmed that stored environment variables may be in attacker hands.
Every secret that lived in Railway must be treated as stolen. Your part is the Supabase side
(the keys only you can rotate) plus placing a few values we already rotated. Work top to bottom.

**Do NOT rotate:** `anon` / `publishable` API keys, JWKS, URLs, ports, flags, price IDs.

---

## A. Supabase keys — rotate (you)

| # | What | Where | Then place the new value in |
|---|---|---|---|
| A1 | `service_role` — **TScopier PROD** (`sxkpcovbyaficvtkpsdo`) | Dashboard → PROD → Settings → API keys → service_role → Rotate | edge secrets **PROD**: `SUPABASE_SERVICE_ROLE_KEY`, `PARSE_SIGNAL_KEY` — and we update Railway/VPS envs (send us the new value) |
| A2 | `service_role` — **TScopier STAGING** (`axdcledcyhyvzrnfkwat`) | same, staging project | edge secrets **STAGING**: `SUPABASE_SERVICE_ROLE_KEY` |
| A3 | `service_role` — **UNICOPIER** (`supmsgcubipmmowrzoub`) | same, Unicopier project | edge secrets **UNICOPIER**: `SUPABASE_SERVICE_ROLE_KEY` |
| A4 | *(recommended)* Postgres password reset | Settings → Database | edge **PROD** `SUPABASE_DB_URL` (contains the password) — update **immediately** after reset or connections break |
| A5 | *(only if it appears in any Railway env)* new-style `secret` key | Settings → API keys → Rotate | edge `SUPABASE_SECRET_KEYS` (all three projects) |

**Also, one configuration fix (not a rotation):**
- Edge secret **`SUPABASE_URL`** currently = `https://sso.tscopier.ai` → change it to
  `https://sxkpcovbyaficvtkpsdo.supabase.co` (PROD project). Same database, standard address.
  This is what makes a firewall rule against the stolen key safe to switch on later.

---

## B. Third-party keys — rotate (you; we have no access)

Each: **create new key at provider → place in locations → delete old key → tell us done.**

| # | Key | Rotate at | New value goes to |
|---|---|---|---|
| B1 | `OPENAI_API_KEY` | platform.openai.com | Railway services, edge PROD + STAGING |
| B2 | `CEREBRAS_API_KEY` (+ `_1.._3` if present) | Cerebras dashboard | Railway services |
| B3 | `FMP_API_KEY` | financialmodelingprep.com | Railway, edge PROD |
| B4 | `MASSIVE_API_KEY` | massive.com | Railway, edge PROD |
| B5 | `FINNHUB_API_KEY` | finnhub.io | edge PROD |
| B6 | `POLYGON_API_KEY` | polygon.io | edge PROD |
| B7 | `FXSOCKET_API_KEY` (`fxs_live_…`, **confirmed in Railway**) | FxSocket dashboard | edge PROD/STAGING/UNICOPIER + Railway |
| B8 | `RESEND_API_KEY` | resend.com | edge PROD/STAGING/UNICOPIER |
| B9 | `STRIPE_SECRET_KEY` | Stripe → Developers → API keys | edge PROD/STAGING |
| B10 | `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → reveal new signing secret | edge PROD/STAGING |
| B11 | `UPSTASH_REDIS_REST_TOKEN` | Upstash console | edge PROD |
| B12 | `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile | edge PROD/STAGING/UNICOPIER |
| B13 | `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` (new pair) | my.telegram.org | Railway, edge PROD, edge UNICOPIER |
| B14 | `CTRADER_CLIENT_ID` / `CTRADER_CLIENT_SECRET` | SpotWare app credentials | edge PROD, edge UNICOPIER |
| B15 | `MT4API_BASIC_USER` / `MT4API_BASIC_PASSWORD` (**confirmed in Railway**) | the `mt4api.dev` service — tell us if that's ours or a vendor | Railway, edge PROD |
| B16 | `VITE_ADMIN_PASSWORD` | choose new | edge PROD |

---

## C. Internal values + placements (generate/place)

| # | What | New value goes to |
|---|---|---|
| C1 | `WORKER_INTERNAL_TOKEN` (generate, `openssl rand -hex 32`) | **every** Railway service (same value) + edge PROD/STAGING/UNICOPIER |
| C2 | `ALERT_EVALUATOR_SERVICE_KEY` | edge PROD + STAGING (same value) |
| C3 | Railway access token (Account → Access Tokens) | edge PROD (`RAILWAY_TOKEN`), edge STAGING (`RAILWAY_API_TOKEN`), local tooling `RAILWAY_TOKEN_PROD` |
| C4 | **MTAPI pair — already rotated by us** (values provided with this handover) | edge secrets **PROD/STAGING/UNICOPIER**: `MTAPI_API_KEY`, `MTAPI_INTERNAL_TOKEN` — Railway staging already handled by us |
| C5 | **Broker encryption key — rotated by us after the worker redeploy** | edge **all three**: `BROKER_CREDENTIALS_ENCRYPTION_KEY` (new) **and** `BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` (old) — coordinate with us; we run the re-seal migration first |

---

## Notes

- **Sequencing with Railway:** Railway is refusing deploys (same incident). We stage every
  Railway-side value now; they apply at the first successful deploy. Coordinate A1–A3 rotation
  so the worker envs can be updated at the same time (else the workers fail auth after rotation).
- **New values** are handed over through our password manager — not chat.
- **Verification after A1:** old token must fail —
  `curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: <OLD>" -H "Authorization: Bearer <OLD>" "https://sso.tscopier.ai/rest/v1/trades?select=id&limit=1"` → **401/403** (not 200).
- **Firewall status:** a rate-limit rule covers `sso.tscopier.ai`; the stronger "stolen-key
  deny" rule exists but is **Disabled** — it becomes safe to enable (or can be deleted as moot)
  once A1 is done and the `SUPABASE_URL` fix above is applied.
- **Already handled by us — no action needed:** MTAPI keys rotated server-side; broker-key
  dual-key code + re-seal migration built and tested; Railway static egress IPs enabled on all
  services; database activity sweeps clean; VPS clean; audit-trigger SQL prepared.

**Already covered by our side** (for your awareness): `MTAPI_API_KEY`, `MTAPI_INTERNAL_TOKEN`,
`MT_SERVERS_SYNC_SECRET`, `SENTRY_DSN`, `BROKER_CREDENTIALS_ENCRYPTION_KEY`, Railway account
password/2FA.
