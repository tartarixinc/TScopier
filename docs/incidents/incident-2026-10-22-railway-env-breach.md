# Incident: Railway environment-variable breach — credential rotation

**Status: Open (red)** · Severity: High · Detected: 2026-10-22 · Component: Railway platform / all services & environment variables · Root cause: third-party compromise of Railway (upstream incident) · Affected: every environment stored in Railway — TScopier production, staging, Unicopier, and any other project on the account

> This document is the living incident record. It is updated as each credential is rotated and stays open — with the PDF re-rendered at closure — until every item below reads ✅.

## 1. Executive summary (plain English)

On the morning of 2026-10-22 Railway notified us that an unauthorized third party may have accessed **encrypted environment variables and, for some, their decrypted contents** — which means API keys, database credentials and tokens stored in Railway must all be treated as stolen. This was not an attack on us specifically; Railway believes it is part of a wider campaign against platform companies and AI-inference providers. Our response has three parts: (1) stop the attacker from being able to *use* what was taken — first by firewalling our database behind Cloudflare so the leaked database key works from nowhere, (2) replace every key we control, starting with the ones that protect customers' broker access, using a rotation method that **never asks any customer to change a password**, and (3) escalate the one credential we cannot rotate ourselves (the Supabase service key) to the account owner. Builds on Railway are paused by the incident, so worker deployments go through the VPS in the meantime; the web frontend (Netlify) is unaffected.

## 2. Issue encountered

Railway's platform notice (2026-10-22, morning): anomalous activity on systems storing customer environment variables; unauthorized access to encrypted environment variables and, for some, decrypted contents; immediate revocation/reissue of all env vars instructed; builds temporarily unavailable.

## 3. Affected credentials and rotation tracker

Values are never recorded in this document — only variable names.

| # | Credential | Where it is changed | Status | Updated |
|---|---|---|---|---|
| 1 | `BROKER_CREDENTIALS_ENCRYPTION_KEY` (+ new `..._PREVIOUS` during transition) | VPS worker env + Supabase edge secrets | 🟨 Code ready (dual-key shim + `reencrypt-credentials` script), not yet deployed | 2026-10-22 |
| 2 | `MTAPI_API_KEY` | MTAPI service (mtapi.tscopier.ai) **and** VPS env | ⬜ Pending | 2026-10-22 |
| 3 | `MTAPI_INTERNAL_TOKEN` | MTAPI service **and** VPS env | ⬜ Pending | 2026-10-22 |
| 4 | `WORKER_INTERNAL_TOKEN` | Every worker/listener service + VPS (must match everywhere) | ⬜ Pending | 2026-10-22 |
| 5 | `MT_SERVERS_SYNC_SECRET` | VPS / consumers | ⬜ Pending | 2026-10-22 |
| 6 | `OPENAI_API_KEY` | OpenAI dashboard → Railway/VPS | ⬜ Pending | 2026-10-22 |
| 7 | `CEREBRAS_API_KEY` (+ `_1.._3` if present elsewhere) | Cerebras dashboard → env | ⬜ Pending | 2026-10-22 |
| 8 | `FMP_API_KEY` | FMP dashboard → env | ⬜ Pending | 2026-10-22 |
| 9 | `MASSIVE_API_KEY` | Massive dashboard → env | ⬜ Pending | 2026-10-22 |
| 10 | `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` (new pair) | my.telegram.org → env; old MTProto sessions invalidated afterwards | ⬜ Pending | 2026-10-22 |
| 11 | `SENTRY_DSN` | Sentry → Settings → Project → Client Keys → env | ⬜ Pending | 2026-10-22 |
| 12 | `SUPABASE_SERVICE_ROLE_KEY` / `PARSE_SIGNAL_KEY` (same JWT), all Supabase projects (TScopier prod `sxkpc…`, Unicopier `supmsg…`, staging `axdcle…`) | Supabase dashboard → API keys | 🟥 **Blocked — no dashboard access; escalated to project owner / Supabase support** | 2026-10-22 |
| 13 | Supabase **database passwords** and **edge-function secrets** audit | Supabase dashboard | 🟥 Same access blocker as #12 | 2026-10-22 |
| 14 | Cloudflare WAF allowlist on `sso.tscopier.ai` (VPS + Railway egress IPs only) | Cloudflare (user-controlled) | ⬜ Pending — **highest-value containment for #12** | 2026-10-22 |
| 15 | Railway account hygiene: password, 2FA, activity log, unknown services/vars/domains, registry credentials | Railway dashboard | ⬜ Pending | 2026-10-22 |
| 16 | All other Railway service envs (Trade, Backtest, staging, Unicopier, legacy `TScopier - *`) | Railway dashboard | ⬜ Pending — export first | 2026-10-22 |
| 17 | Git history: committed Expo dev logs (`apps/mobile/.expo/dev/logs/*.log`) contain the leaked service JWT (3 commits back) | Repo hygiene decision (private repos; history rewrite breaks shared ancestry with upstream — see follow-ups) | ⬜ Pending | 2026-10-22 |
| 18 | Customer broker passwords at the broker | **Not planned** — user decision: no customer password changes; contained by #14 + #1 + monitoring (see §5) | ⏸ Accepted residual | 2026-10-22 |

## 4. Root cause

Upstream compromise of Railway's environment-variable storage (encrypted and, for some keys, decrypted contents). Not caused by this codebase; the exposed material is whatever each Railway service carried in its environment at the time. Compounding factor found during our audit: the same Supabase service JWT was also written into committed Expo logs (item 17).

## 5. The fix / response strategy

1. **Containment without rotation access:** WAF-allowlist `sso.tscopier.ai` (item 14) so the leaked service key — which we cannot yet rotate — is unusable from the internet; legit traffic originates from our VPS/Railway only.
2. **Control-plane rotations** (items 2–5): MTAPI pair, worker internal token, sync secret — regenerable on infrastructure we own; kills the attacker's ability to drive our systems.
3. **Encryption key rotation without customer impact:** dual-key transition (decrypt accepts `..._PREVIOUS`, encrypt uses only the primary) + one-shot re-encrypt script (items 1, 6–11 in §5 sequence) — **customers never touch anything**.
4. **Escalation:** items 12–13 to the Supabase project owner (rotate the JWT secret) — closes the remaining control-plane path together with item 14.
5. **Accepted residual (user decision):** already-exfiltrated decrypted broker passwords (if any) are contained by 14 + 1 + monitoring; a leaked trading password cannot withdraw funds on standard brokers (verified bank/card withdrawals only), so worst case is trading damage. Compensating: broker-side login alerts, trade-comment audits (`TScopier:`/`mc:`/expertID 909090), provider usage reviews.

## 6. Files changed (rotation enablers)

- `worker/src/brokerCredentialsCrypto.ts` — dual-key decrypt (primary + comma-separated `BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`), primary-only encrypt.
- `supabase/functions/_shared/brokerCredentialsCrypto.ts` — same contract for the edge runtime.
- `worker/src/diagnostics/reencryptBrokerCredentials.ts` + `reencrypt-credentials[:dev]` scripts — dry-run by default, `--apply` rewrites every `*_encrypted` value, never overwrites undecryptable values, logs counts only.

## 7. Verification

- Worker `tsc` build clean; `brokerCredentialsCrypto.test.ts` + `mtapiSessionManager.test.ts` = **26/26 pass** (round trip, previous-key fallback, both-lists-miss fails closed, multi-previous, format stability, no-key paths).
- Edge copy mirrors the worker contract (Deno not installed locally — edge tests run at deploy time).

## 8. Deployment status

**Not deployed.** Railway builds are paused by the incident; the worker rotation ships via the VPS (`git pull` + `npm --prefix worker run build` + restart). Edge secret (`BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`) set via Supabase secrets when item 13's access allows. Frontend (Netlify) unaffected and already current.

## 9. Follow-ups / closure criteria

This incident closes (status → Fixed, PDF re-rendered) only when **all** tracker rows in §3 are ✅, including: re-encrypt script reports **0** values on the old key → `..._PREVIOUS` deleted everywhere; Supabase JWT rotated by owner; WAF rule live; Telegram sessions invalidated; Railway hygiene done; and a final usage-log review (OpenAI/Cerebras/broker statements) clean. Standing follow-ups carried after closure: move secrets out of Railway envs into a vault (item 17 history decision, secrets-in-repo policy), automated rotation runbook, and a session-termination review for Telegram auth keys exported with the DB.
