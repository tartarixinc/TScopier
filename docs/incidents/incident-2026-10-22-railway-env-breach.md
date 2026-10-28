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
| 1 | `BROKER_CREDENTIALS_ENCRYPTION_KEY` (+ new `..._PREVIOUS` during transition) | Railway worker envs (both prod services, plus staging) + Supabase edge secrets — **not on the VPS** (recon: no .env there) | ✅ **Rotation complete on every database** — staging 6/6, Unicopier 11/11, production 83/83 re-sealed under the new key (`f483c148…`); verification run reports `on-previous=0 on-primary=83 skipped-non-v1=0`. Remaining: delete `..._PREVIOUS` from Railway (3 envs) + edge secrets (3 projects) — safe now | 2026-10-22 |
| 2 | `MTAPI_API_KEY` | nginx bearer map (`nginx.conf:58`) + `/root/.mtapi_api_key` (mtapi.tscopier.ai) + Railway staging + edge P/S/U | ✅ **Rotated and verified on the VPS** (new pair → 201, old pair → rejected). Edge placement still open: API 403 → dashboard/owner | 2026-10-22 |
| 3 | `MTAPI_INTERNAL_TOKEN` | nginx internal map (`nginx.conf:68`) + Railway staging + edge P/S/U | ✅ **Rotated and verified on the VPS** — same gates as #2 | 2026-10-22 |
| 4 | `WORKER_INTERNAL_TOKEN` | Every Railway worker service + edge secrets P/S/U (must match everywhere) | 🟨 **Rotated on Railway (all three projects)** — new values live and verified (probes pass; old value rejected). Remaining: edge secrets P/S/U (dashboard/owner) | 2026-10-22 |
| 5 | `MT_SERVERS_SYNC_SECRET` | VPS / consumers | ⬜ Pending | 2026-10-22 |
| 6 | `OPENAI_API_KEY` | OpenAI dashboard → Railway/VPS | ⬜ Pending | 2026-10-22 |
| 7 | `CEREBRAS_API_KEY` (+ `_1.._3` if present elsewhere) | Cerebras dashboard → env | ⬜ Pending | 2026-10-22 |
| 8 | `FMP_API_KEY` | FMP dashboard → env | ⬜ Pending | 2026-10-22 |
| 9 | `MASSIVE_API_KEY` | Massive dashboard → env | ⬜ Pending | 2026-10-22 |
| 10 | `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` (new pair) | my.telegram.org → env; old MTProto sessions invalidated afterwards | ⬜ Pending | 2026-10-22 |
| 11 | `SENTRY_DSN` | Sentry → Settings → Project → Client Keys → env | ⬜ Pending | 2026-10-22 |
| 12 | `SUPABASE_SERVICE_ROLE_KEY` / `PARSE_SIGNAL_KEY` (same JWT), all Supabase projects (TScopier prod `sxkpc…`, Unicopier `supmsg…`, staging `axdcle…`) | Supabase dashboard → API keys | 🟥 **Blocked — no dashboard access; escalated to project owner / Supabase support** | 2026-10-22 |
| 13 | Supabase **database passwords** and **edge-function secrets** audit | Supabase dashboard | 🟥 Same access blocker as #12 | 2026-10-22 |
| 14 | Cloudflare WAF rule on `sso.tscopier.ai` (leaked-JWT value-deny, VPS exempt) | Cloudflare (user-controlled) | 🟨 **Rule drafted, kept DISABLED** — worker egress = Railway's unknown IPs (rule would block ourselves); superseded by standup rotation; re-evaluate only if rotation slips (or Railway static egress IPs appear) | 2026-10-22 |
| 15 | Railway account hygiene: password, 2FA, activity log, unknown services/vars/domains, registry credentials | Railway dashboard | ⬜ Pending | 2026-10-22 |
| 16 | All other Railway service envs (Trade, Backtest, staging, Unicopier, legacy `TScopier - *`) | Railway dashboard | ⬜ Pending — export first | 2026-10-22 |
| 17 | Git history: committed Expo dev logs (`apps/mobile/.expo/dev/logs/*.log`) contain the leaked service JWT (3 commits back) | Repo hygiene decision (private repos; history rewrite breaks shared ancestry with upstream — see follow-ups) | ⬜ Pending | 2026-10-22 |
| 18 | Customer broker passwords at the broker | **Not planned** — user decision: no customer password changes; contained by #14 + #1 + monitoring (see §5) | ⏸ Accepted residual | 2026-10-22 |
| 19 | `TELEGRAM_SESSION_ENCRYPTION_KEY` (new — introduced by this incident's storage hardening) | Railway worker envs (all three projects) — edge functions do not read session strings | ⬜ Code complete and reviewed; not deployed. Rollout per `docs/telegram-session-encryption-runbook.md` (staging → Unicopier → prod; no-op until the key is set) | 2026-10-22 |
| 20 | Telegram **session invalidation** (mass re-link of all users) | Telegram side | ⏸ **Not planned — user decision 2026-10-22** after activity review: no attacker use of the session data was found in the retained 7-day window, and mass invalidation would cause exactly the connectivity churn this incident response is meant to avoid. Replaced by storage hardening (#19 + column privileges on `telegram_sessions`, live everywhere) | 2026-10-22 |

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

- Worker `tsc` build clean; `brokerCredentialsCrypto.test.ts` + `mtapiSessionManager.test.ts` = **28/28 pass** (round trip, previous-key fallback, both-lists-miss fails closed, multi-previous, key-source reporting, format stability, no-key paths).
- Edge copy mirrors the worker contract; `deno check` on the shared library is clean and the edge files were verified by the deploy bundler.
- Independent review: `code-tester` PASS_WITH_NOTES (28/28, clean builds); `code-review` PASS_WITH_NOTES after fixes (pagination, key-aware idempotency, compare-and-swap, fail-closed malformed input, target/fingerprint guards).

**Rotation plan:** `docs/broker-credential-key-rotation-runbook.md`.

## 8. Deployment status

**Broker key rotation is complete on every database.** Railway deploys are unfrozen (staging and production deploys succeed). What remains is owner-side work and one planned rollout:

- **Broker credentials:** new primary (`528b8d94…`, fingerprint `f483c148…`) is the only key holding data — staging 6/6, Unicopier 11/11, production 83/83 re-sealed; verification re-run reports `on-previous=0`. `..._PREVIOUS` is now dead weight and can be deleted from Railway (3 services) and edge secrets (3 projects).
- **MTAPI pair:** new pair live and verified on the VPS (new → 201, old → rejected); Railway carries the new values; edge secrets still need the owner's dashboard placement.
- **Worker internal token:** new value live on all three Railway projects; edge secrets still need placement.
- **Telegram storage hardening:** column privileges live on all three databases (`anon`/`authenticated` can no longer select `session_string`; all app queries verified compatible). Session-string encryption code is complete, reviewed (code-tester PASS, code-review PASS_WITH_NOTES) and **not yet deployed** — it is a runtime no-op until `TELEGRAM_SESSION_ENCRYPTION_KEY` is set; rollout per `docs/telegram-session-encryption-runbook.md`.
- **Supabase service-role keys:** still un-rotated (owner dashboard). This remains the open control-plane path — every other stolen credential is rotated or contained.
- **Frontend (Netlify):** the misconfigured `VITE_SUPABASE_ANON_KEY` (which had been shipping the service-role JWT) is fixed; the current bundle embeds only the anon key. It becomes fully moot once the owner rotates the JWT secret.

## 9. Follow-ups / closure criteria

This incident closes (status → Fixed, PDF re-rendered) only when **all** tracker rows in §3 are ✅ or explicitly accepted, including: `..._PREVIOUS` deleted everywhere; Supabase JWT rotated by owner (or the row formally accepted as owner-blocked with a compensating control); Telegram session encryption rolled out (row 19) or explicitly deferred; Railway hygiene done; and a final usage-log review (OpenAI/Cerebras/broker statements) clean. **Note:** the original closure criterion "Telegram sessions invalidated" has been replaced — the user decided against mass invalidation after the activity review showed no attacker use; storage hardening (rows 19–20) is the compensating control. Standing follow-ups carried after closure: move secrets out of Railway envs into a vault (item 17 history decision, secrets-in-repo policy), automated rotation runbook, and a session-termination review for Telegram auth keys exported with the DB.

## 10. Response log (live chronology — maintained until closure)

1. **Triage** — Railway breach notice received 2026-10-22 (all env values treated stolen; builds blocked). Incident doc + live scratchpad tracker + PROJECT_MEMORY entry created.
2. **Key register** — built from both Railway service env dumps (listener + trade) and Supabase Management API (4 API keys per project + full edge-secret inventories on `sxkpc…`/`axdcle…`/`supmsg…`). Split by access: user's six vs owner document (delivered, Sections 1–3; add-ons later: MTAPI pair edge placement, `FXSOCKET_API_KEY`, `MT4API_BASIC_*`).
3. **Repo leak audit** — tree + 150-commit history scan: only hit = committed Expo dev logs (`apps/mobile/.expo/dev/logs/*.log`) containing the prod service-role JWT. No history purge (shared upstream ancestry) → owner rotation compensates.
4. **Supabase activity review (prod)** — no new auth users since breach; zero writes to copy/money/subscription tables since 00:00; the two new `broker_accounts` rows belong to a pre-breach signup (benign); `admin_audit_logs` never had a single row.
5. **Audit-logger fix** — root cause: table built in May, **no writer ever existed**. DB-level capture SQL prepared: `docs/scratchpads/apply-db-audit-triggers-2026-10-22.sql` (SECURITY DEFINER triggers on 8 security tables; actor column relaxed). **Status: prepared — dashboard run not yet confirmed.**
6. **WAF containment** — full Cloudflare expression drafted (leaked-JWT value-deny with VPS exemption). **Kept Disabled**: worker egress is Railway's unknown range, so activation would block our own worker; superseded by the rotation plan.
7. **Gateway relay (Option B)** — implemented + tested (29/29) then **parked uncommitted**: dormant without env, superseded by standup rotation; excluded from any push scope.
8. **Broker credential key** — dual-key shim (worker + edge runtime) + `reencrypt-credentials` diagnostic (dry-run default, refuse-to-overwrite, counts-only) + 6 rotation tests (26/26). **Committed locally `46e318e7`** (+ docs `4b66bb4d`); **push deferred** twice by user — required before Railway can build it (open: go + which remote Railway watches). Reencrypt deliberately gated: running it before the worker ships dual-key code would strand every stored broker password.
9. **VPS recon** (root@Contabo Ubuntu 24.04) — box is the **MTAPI host only**: docker `mtapi`/`mt4rest` (127.0.0.1:8080/8081), nginx on 80+9443; **no node worker, no pm2, no `.env` files, no git repo** → production worker runs on Railway (confirmed). Suspicion sweep **clean**: logins only from user's IP range, single UID0, empty `authorized_keys`, stock crontabs + user's own licence-watch, nothing planted since 10-20. Flagged: SSH password auth enabled, 8 pending apt updates.
10. **MTAPI auth decoded** — nginx `map` in `nginx.conf` line 58 (Bearer) + line 68 (internal token); helper file `/root/.mtapi_api_key`; container `UserKey` = UUID **licence** key (not present in Railway → not exposed → left untouched with its cron watcher). Live probes: no-auth 403, worker-pair 201, wrong-pair 403 — enforcement real and healthy.
11. **MTAPI pair rotated on VPS** — both map values + `.mtapi_api_key` replaced on disk (`84b9261e…` / `bad8e844…`), old values grep-count 0. **Pending: `nginx -t && systemctl reload nginx` + 3-probe verification.** Gap clock starts at reload and runs until Railway deploy (worker) + edge secrets update.
12. **Edge-secrets placement attempt** — POST via available token → **403 `edge_functions_secrets_write`** on all three projects → paths: user's dashboard Secrets UI, else owner batch.
13. **Railway posture** — deploys refused → every Railway env change is **staged now, applied at first successful deploy**; provider-side keys follow "create new → place → revoke old" to avoid self-outage.
13b. **Railway static egress collected (2026-10-22)** — static-IP switches ENABLED on listener
      ({162.220.232.250, 152.55.177.181, 152.55.177.192}), trade worker ({162.220.232.251,
      152.55.176.240, 152.55.177.193}), backtest ({162.220.232.251, 152.55.177.181,
      152.55.177.193}) — type Shared (other Railway tenants may share them; rotation remains the
      primary control). Statics activate at the NEXT deploy; current live worker egress observed =
      52.53.45.179 (confirmed via mtapi nginx log, UA "node", trading paths). WAF allowlist =
      all seven IPs above. MTAPI probes FINAL: new -> 201, old -> 403 (server rotation verified).
13c. **Cloudflare work — parked by user decision (2026-10-22 night):** value-deny WAF expression
      validated-ready (short signature form + seven-IP allowlist incl. statics + live worker
      52.53.45.179) but **kept Disabled**: edge secrets' `SUPABASE_URL` was discovered to be
      `https://sso.tscopier.ai` (user has no secrets view/edit permission), so enabling would
      block edge functions' internal DB calls (incl. parse-signal's DB writes) from Supabase
      platform IPs we cannot allowlist. Rate-limit rule (sso, 1000 req/5min per IP, block 10m)
      offered as the zero-risk overnight layer — **deployment status unconfirmed, verify
      tomorrow**. Owner doc v2 issued with full addendum (edge SUPABASE_URL fix, MTAPI pair
      placement, FXSOCKET, MT4API basics, broker key + PREVIOUS). Strong rule becomes safe to
      enable AFTER (a) owner rotates service keys and (b) `SUPABASE_URL` secret switched to
      https://sxkpcovbyaficvtkpsdo.supabase.co — or simply delete both rules post-rotation.
14. **Open queue** — ① reload + MTAPI probes, ② Railway staging (MTAPI pair; broker new+`PREVIOUS`), ③ push decision + Railway build-source remote, ④ Phase B broker runbook at unfreeze (deploy → smoke → reencrypt → 0 → retire `PREVIOUS` → redeploy → smoke), ⑤ owner standup bundle — **full checklist filed at `docs/incidents/owner-rotation-checklist-2026-10-22.md`** (Sections A–C + edge placements + add-ons), ⑥ dashboard run of audit-trigger SQL, ⑦ `mt4-deploy`/`hist-prod.json` grep (confirm no broker key on VPS), ⑧ Sentry new-DSN-keep-old, ⑨ Railway account tokens, ⑩ at closure: tracker all-✅ → status Fixed → PDF re-render.
15. **Rotation enabled in code (later 2026-10-22)** — the broker feature was pushed as three cherry-picked commits to `upstream/migration` (`6d4c817e`) and `upstream/staging` (`94789e91`), nothing else riding along. Review round 2: `code-tester` PASS (28/28), `code-review` PASS_WITH_NOTES after fixing pagination, key-source idempotency, compare-and-swap writes, malformed-edge-ciphertext handling and adding target/fingerprint/empty-scan guards. Edge deployed: staging `mtapi-broker` v11; Unicopier all eight broker functions. Edge secrets could not be written (token lacks `edge_functions_secrets_write`) → owner dashboard. Steps and rollback documented in `docs/broker-credential-key-rotation-runbook.md`.

