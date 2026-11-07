# Incident: Admin panel locked out after CAPTCHA enforcement was enabled

**Date:** 2026-11-02
**Severity:** High (admin access blocked)
**Status:** Fixed (deploy pending user verification)
**Component:** tscopier-admin (`panel.tscopier.cloud`) login ↔ Supabase Auth (prod `sxkpcovbyaficvtkpsdo`)
**Root cause:** Project-wide Turnstile CAPTCHA enforcement rejects any password login that carries no `captcha_token`; the admin panel has never had a Turnstile widget, so its logins always arrive tokenless.

## 1. Executive summary (plain English)

To stop signup bots, Turnstile CAPTCHA was switched on for all three Supabase projects (production, staging, migration). That switch is global: every password login, signup, and password recovery must now include a captcha token. The admin panel (`panel.tscopier.cloud`) was built long before CAPTCHA existed here and never needed a captcha — its login form sends no token. As soon as enforcement went live, every admin sign-in was rejected with "captcha protection: request disallowed (no captcha_token found)". The main app (`app.tscopier.ai`) was unaffected because it already renders the widget and refuses to submit without a token; Google sign-in and existing logged-in sessions were also unaffected (verified). Separately, the admin's own machine had a local DNS failure (it could not resolve `panel.tscopier.cloud` or `challenges.cloudflare.com` even though both resolve fine worldwide) — the same machine issue that had made the Turnstile widget fail earlier in the session.

## 2. Issue encountered

- Login at `https://panel.tscopier.cloud/login?env=prod` failed with:
  `captcha_failed: captcha protection: request disallowed (no captcha_token found)`
- Adding `VITE_TURNSTILE_SITE_KEY` to the admin Netlify site changed nothing — the admin repository contained **zero** Turnstile/captcha references (verified by repo-wide grep), so the variable was never read and no widget ever rendered.
- A machine-level `DNS_PROBE_FINISHED_NXDOMAIN` for `panel.tscopier.cloud` was reported in parallel; global DNS for the domain was healthy (resolved via default resolver, 1.1.1.1 and 8.8.8.8 to `63.176.8.218` / `35.157.26.135`, HTTP 200 from a second machine).

## 3. Affected user(s)

| Surface | Affected? | Evidence |
|---|---|---|
| Admin panel password login (`panel.tscopier.cloud`) | **Yes — all admins locked out** | exact `captcha_failed` error reproduced by direct API probe |
| Main app password login / signup (`app.tscopier.ai`) | No | live bundle contains site key `0x4AAAAAAENwYkTwFMwfAUdc`; submit is gated until a token exists |
| Google OAuth (main app) | No | `GET /auth/v1/authorize?provider=google` → 302 to Google (not captcha-gated) |
| Existing sessions (refresh) | No | `grant_type=refresh_token` → normal validation error, not `captcha_failed` |
| Password recovery (API) | Yes, by design | `POST /auth/v1/recover` without token → `captcha_failed` (main app's reset page sends a token via its edge function) |

## 4. Root cause

Supabase Auth CAPTCHA (`security_captcha_enabled = true`, provider `turnstile`) is enforced **project-wide** by GoTrue on password grant, signup, and recovery. Any client that does not attach `captcha_token` is rejected before credentials are checked. The admin panel (`tscopier-admin`, `tartarixinc/tscopier-admin`) was never integrated with Turnstile — correct behaviour while CAPTCHA was off, but a hard lockout the moment it was enabled. The site key previously added to its Netlify env had no effect because no code reads it.

Probe results (prod, 2026-11-02):

| Call | Result |
|---|---|
| `POST /auth/v1/token?grant_type=password` (no token) | `captcha_failed: no captcha_token found` |
| `POST /auth/v1/signup` (no token) | `captcha_failed: no captcha_token found` |
| `POST /auth/v1/recover` (no token) | `captcha_failed: no captcha_token found` |
| `POST /auth/v1/token?grant_type=refresh_token` (fake token) | `validation_failed: Refresh token is not valid` (not captcha-gated) |
| `GET /auth/v1/authorize?provider=google` | `302` to `accounts.google.com` (not captcha-gated) |

## 5. The fix

Added the Turnstile widget to the admin login (gate, don't replace — existing handler unchanged):

- `src/pages/LoginPage.tsx` — render `@marsidev/react-turnstile` when `VITE_TURNSTILE_SITE_KEY` is present; hold the token in state; block submit until a token exists (only when the key is configured); pass `options: { captchaToken }` to `signInWithPassword`; reset the widget and clear the token after a failed attempt (tokens are single-use).
- `package.json` / `package-lock.json` — dependency `@marsidev/react-turnstile`.
- Builds without the key (local dev) degrade to the old tokenless login.

Committed as `aa1660f` on branch `feat/admin-turnstile` (based on `origin/main`) and pushed to **`tartarixinc/tscopier-admin` `main`** with the owner's explicit approval (`a617ee3..aa1660f`); Netlify builds `main` automatically.

## 6. Files changed

- `tscopier-admin/src/pages/LoginPage.tsx`
- `tscopier-admin/package.json`
- `tscopier-admin/package-lock.json`

## 7. Verification

- Repo-wide grep before the fix: zero `turnstile`/`captcha`/`captchaToken` references in `tscopier-admin/src`.
- Pre-fix live bundle (`panel.tscopier.cloud/assets/index-DNA-FUpY.js`): no site key; the only `captchaToken` strings were supabase-js internals.
- Post-fix: `npx tsc -b` exit 0; `npm run build` succeeded; widget code present in the built bundle.
- Live probes (table in §4) confirm exactly which paths are gated and which are not.
- End-to-end admin login after Netlify deploy: **pending** (requires the deploy to finish plus the widget hostname check below).

## 8. Deployment status

- [x] Code pushed to `tartarixinc/tscopier-admin` `main` (`aa1660f`)
- [ ] Netlify deploy finished and login verified by the owner
- [ ] Cloudflare widget `tscopier.ai (Spin)` hostname list includes `panel.tscopier.cloud` (owner action — without it the widget will not render on the panel)
- [ ] Admin Netlify env var confirmed as exactly `VITE_TURNSTILE_SITE_KEY` (Production scope)
- Interim unlock available: disable CAPTCHA on prod `/auth/protection`, re-enable after the panel login is verified

## 9. Follow-ups

1. Confirm the two owner actions above and complete one successful admin login.
2. `apps/backoffice` (Unicopier repo) also calls `signInWithPassword` with no Turnstile — add the widget before the backoffice is used against any CAPTCHA-enabled project.
3. Local `.env` files in Unicopier/tscopier-admin lack `VITE_TURNSTILE_SITE_KEY`; local password logins against CAPTCHA-enabled projects will fail until it is added (the key is public).
4. The owner's Windows DNS failure (NXDOMAIN for both `panel.tscopier.cloud` and `challenges.cloudflare.com` while global DNS was healthy) is the same machine-level issue that broke the Turnstile widget at the start of the session — fixed with `ipconfig /flushdns` + switching the adapter to 1.1.1.1 / 8.8.8.8; worth remembering that the widget's "server IP could not be found" was never a server problem.
5. Any other scripts/clients that call prod Auth password signup/recovery directly must now send a captcha token or they will receive `captcha_failed`.
