# Signup Spam Protection — Dashboard Setup

**Status 2026-08-12:** Turnstile is **not effectively on in production**. Prod frontend build had no Turnstile site key baked in, server verify was fail-open without secret, and Auth CAPTCHA dashboard toggle is still off. Bots are not “solving” captcha — they never face it.

Complete these steps **in the same deploy window** as the frontend Turnstile release. Enabling CAPTCHA in Supabase before the frontend ships will block all email signups.

## 1. Cloudflare Turnstile

Widget already created. Keys:

| Variable | Where | Value |
|----------|-------|-------|
| `VITE_TURNSTILE_SITE_KEY` | Netlify (prod + staging) + local `.env` | `<turnstile-site-key>` |
| Turnstile secret | Supabase Dashboard → Auth → CAPTCHA **and** `supabase secrets set TURNSTILE_SECRET_KEY=...` | From Cloudflare Turnstile widget |

1. Confirm widget hostnames include `app.tscopier.ai`, `staging.tscopier.ai`, and `localhost`
2. Set the real public site key as Netlify env `VITE_TURNSTILE_SITE_KEY=<turnstile-site-key>` and redeploy the frontend. It is intentionally not stored in the repository.
3. Set Supabase secret (staging + prod):
   ```bash
   supabase secrets set TURNSTILE_SECRET_KEY=<turnstile-secret> --project-ref axdcledcyhyvzrnfkwat
   supabase secrets set TURNSTILE_SECRET_KEY=<turnstile-secret> --project-ref sxkpcovbyaficvtkpsdo
   ```

## 2. Supabase Auth CAPTCHA

1. [Supabase Dashboard](https://supabase.com/dashboard) → **Authentication** → **Bot and Abuse Protection**
2. Enable **CAPTCHA protection**
3. Provider: **Cloudflare Turnstile**
4. Secret key: same Turnstile secret as above

## 3. Supabase Auth Rate Limits

1. **Authentication** → **Rate Limits**
2. Enable **IP Address Forwarding**
3. Lower **Rate limit for sign-ups and sign-ins** (e.g. 5 per 5 minutes per IP)

Apply on **both** staging (`axdcledcyhyvzrnfkwat`) and production (`sxkpcovbyaficvtkpsdo`).

## 4. Auth Hook (before-user-created)

1. **Authentication** → **Auth Hooks** → **before-user-created**
2. Type: **HTTP Endpoint**
3. URL: `https://<project-ref>.supabase.co/functions/v1/auth-before-user-created`
4. Generate hook secret → set as Supabase secret:
   ```bash
   supabase secrets set BEFORE_USER_CREATED_HOOK_SECRET="v1,whsec_<base64>"
   ```
5. Deploy edge function: `supabase functions deploy auth-before-user-created --use-api`

## 5. Deploy checklist

- [x] Migration `20260812140000_auth_abuse_rate_limits.sql` applied (staging + prod) — 2026-08-12
- [x] Migration `20260812160000_block_spam_signup_emails.sql` applied (staging + prod) — DB-level signup block
- [x] Migration `20260812180000_block_spam_email_domains_keywords.sql` applied (staging + prod) — adult domains + keywords (`gay`, `porn`, …)
- [x] Migration `20260812190000_block_ms_name_digits_spam.sql` applied (staging + prod) — `name+5digits@hotmail/outlook` bots
- [ ] Edge functions deployed: `send-verification-email`, `send-password-reset-email`, `auth-before-user-created`, `admin-query`, `admin-mutate`
- [ ] `TURNSTILE_SECRET_KEY` + `BEFORE_USER_CREATED_HOOK_SECRET` set on Supabase
- [ ] `VITE_TURNSTILE_SITE_KEY` set on Netlify (redeploy frontend)
- [ ] Supabase CAPTCHA enabled **after** frontend deploy is live
- [ ] Auth hook enabled pointing at `auth-before-user-created`

## 6. Cleanup existing spam (optional)

Backoffice **Overview** → **Ban spam signups** button, or SQL (destructive):

```sql
-- Preview only — run SELECT first
SELECT id, email, created_at FROM auth.users
WHERE split_part(lower(email), '@', 2) IN ('pornhub.com', 'xvideos.com', 'xnxx.com')
   OR split_part(lower(email), '@', 1) ~ '(pornhub|gay|porn|xxx)'
ORDER BY created_at DESC;
```

Use backoffice bulk ban action instead of raw DELETE unless you need full removal.

## 7. Custom domains / keywords (ops)

Hard-coded lists live in:
- `src/lib/signupEmailPolicy.ts` (frontend)
- `supabase/functions/_shared/emailSignupPolicy.ts` (edge)
- `public.block_spam_auth_signup()` (DB trigger — source of truth even without Auth Hook)

To add more without a code deploy (edge hook only, if enabled):
```bash
supabase secrets set SIGNUP_BLOCKED_EMAIL_DOMAINS="bad.com,worse.net" --project-ref <ref>
supabase secrets set SIGNUP_BLOCKED_EMAIL_KEYWORDS="spamword,other" --project-ref <ref>
```
DB trigger still needs a migration for new hard blocks (recommended for bots that bypass the hook).
