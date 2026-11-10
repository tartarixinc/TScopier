# Telegram and WhatsApp session encryption — runbook

Status: code complete (worker), ready for staged rollout.
Covers: `telegram_sessions.session_string`, `telegram_auth_pending.auth_session_string`
(Telegram) and `whatsapp_auth.creds` / `whatsapp_auth.keys` (WhatsApp).
Origin: storage hardening decided after the 2026-10-22 Railway environment breach
(`docs/incidents/incident-2026-10-22-railway-env-breach.md`).

## Why

A session string is a complete login key: anyone who reads it can take over the
user's Telegram (or WhatsApp) account from another machine, with no password and
no code prompt. Until this rollout the values sit in the database as plain text —
protected only by row-level security and column grants (which stop *API* access
but do nothing for a database dump, a leaked backup, or a leaked service-role key).

Encryption here changes **only how the value is stored**. The session itself is
byte-identical before and after sealing, so Telegram/WhatsApp never see a change:
**this work cannot invalidate a login by design.** The only failure mode is a
reader that cannot decrypt a writer's row, and the rollout order below removes
even that.

## Mechanism

- Shared envelope `v1:<iv>:<ciphertext+tag>` — AES-256-GCM
  (`worker/src/aesGcmEnvelope.ts`), the same format as broker credentials.
- `worker/src/telegramSessionCrypto.ts` (text columns) and
  `worker/src/whatsappAuthCrypto.ts` (jsonb columns; sealed rows hold the
  envelope as a JSON string, unsealed rows keep the legacy object — no schema
  change). Both provide: seal, open (primary then previous keys), fingerprints.
- Reads are **dual-format forever**: plaintext rows and sealed rows both open.
  A sealed row that no configured key opens **throws** — the session is skipped
  loudly and the row is never deleted or overwritten (a decrypt failure is never
  treated as an invalid session).
- Writes seal only when the key is configured; a sealing failure throws instead
  of falling back to plaintext.
- Key env vars (worker only; no edge function reads these columns, so no edge
  secret needs them):

  | Purpose | Telegram | WhatsApp |
  |---|---|---|
  | Primary (seal + open) | `TELEGRAM_SESSION_ENCRYPTION_KEY` | `WHATSAPP_AUTH_ENCRYPTION_KEY` |
  | Previous (open only, comma-separated) | `TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS` | `WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS` |

- Fingerprints (non-reversible SHA-256 prefixes) are printed at boot by every
  process that reads these columns, so each can be confirmed to hold the same
  key without revealing it. Actual formats:
  - worker: `[worker] telegram-session-encryption primary=<16-hex|not-configured> previous=<…>`
  - WhatsApp listener: `[whatsapp] auth-encryption configured=<bool> primary-fingerprint=<16-hex|missing> previous-fingerprints=<…>`

## Hard rules (session safety)

1. **Code before key.** Every service that reads these columns must run the
   dual-format build *before* any key is set. Setting a key on old code (or
   backfilling before the new code deploys) is the one way this rollout breaks
   logins.
2. **All readers, one key.** Every process in an environment that reads session
   rows must carry the *same* primary key at the same time — otherwise one
   replica seals what another cannot open (the "AUTH_KEY loop" failure family).
3. **Never unset a key once set.** Sealed rows become unreadable without it.
   Rollback = keep the key (reads always still accept plaintext); rotation =
   dual-key, never replacement-in-place.
4. **Fingerprint guard before backfill.** The re-encrypt tools refuse `--apply`
   without `--expect-primary-fingerprint=<value printed at boot>`, so rows can
   never be sealed under a key no service holds.
5. **Telethon rows stay plaintext.** The Python listener
   (`telegram-listener/`) has no key; the re-encrypt tool skips
   `listener_engine='telethon'` rows and the listener itself refuses a sealed
   row with a clear log line instead of connecting with ciphertext.
   `telegram_auth_pending.auth_session_string` is shared between both stacks
   (the worker seals it; the Python listener resumes it), so run the backfill
   in a quiet moment: an *in-flight* login older than the run fails its resume
   with a clear error and can simply restart — established logins are never
   affected. As of 2026-11-07 both databases are 100% `gramjs` (0 telethon
   rows), which is why the Python path is dormant today.

## Commands

```bash
# Worker re-encrypt tools (dry-run first; --apply requires the fingerprint guard)
npm --prefix worker run reencrypt-telegram-sessions:dev
npm --prefix worker run reencrypt-telegram-sessions:dev -- --apply --expect-primary-fingerprint=<fp>
npm --prefix worker run reencrypt-whatsapp-auth:dev
npm --prefix worker run reencrypt-whatsapp-auth:dev -- --apply --expect-primary-fingerprint=<fp>
# The WhatsApp table may legitimately be empty (it is today): pass --allow-empty
# to the dry-run so an empty scan reports success.
```

Verification SQL (either project):

```sql
select count(*) filter (where session_string like 'v1:%') as sealed,
       count(*) filter (where session_string not like 'v1:%') as plain,
       count(*) as total
  from public.telegram_sessions;
-- creds/keys are jsonb: a sealed value is a jsonb *string*, so match on
-- jsonb_typeof and unwrap with #>> '{}' (a plain ::text cast adds quotes).
select count(*) filter (where jsonb_typeof(creds) = 'string' and (creds #>> '{}') like 'v1:%') as sealed_creds,
       count(*) filter (where jsonb_typeof(keys) = 'string' and (keys #>> '{}') like 'v1:%') as sealed_keys,
       count(*) as total
  from public.whatsapp_auth;
```

## Rollout — staging first

1. Deploy the worker build (dual-format code) to the staging environment with
   **keys unset** — confirm sessions behave exactly as before (pure no-op).
2. Generate keys (`openssl rand -hex 32`), store them in the owner password
   manager (same custody as the broker-credential keys), then set both keys on
   the **staging** Railway worker services only. Restart; check the boot log:
   `primary-fingerprint=<16 hex>` on worker and WhatsApp listener.
3. Soak: no decrypt errors, all staging listeners stay connected. Grep the
   logs for the exact failure strings the code emits:
   `grep -E "session_string unreadable|Telegram session could not be read|WhatsApp session could not be read"`
   (must be empty; a generic `could not be read` also matches unrelated
   broker-credential constants and proves nothing).
4. Re-encrypt dry-run, then `--apply --expect-primary-fingerprint=<fp>` for both
   tools; re-run to confirm `on-previous=0 plaintext=0`.
5. End-to-end proof: link a fresh Telegram (send-code flow) and a fresh WhatsApp
   QR on staging — both must reconnect after a worker restart (write sealed →
   read sealed), and a staging re-login must still work (dual-format).

## Rollout — production

1. Promote the code to `main` (Railway production branch) **with keys unset**;
   verify the deploy is a behaviour no-op (no seal, all reads plaintext).
2. Set both keys on **every** production worker service that reads sessions
   (listener and trade roles alike — uniformity rule). Restart; compare the
   printed fingerprints between processes.
3. Re-encrypt dry-run → `--apply --expect-primary-fingerprint=<fp>` → re-run
   until `plaintext=0`. (Telegram's 30-minute session rotation would seal rows
   on its own; the tool closes the remainder, including pending-auth rows.)
4. Watch 24 h: listener health, `AUTH_KEY` / decrypt-error greps in Railway
   logs, Sentry critical-health issues, and the verification SQL above.

## Key rotation (both key types)

1. Set `_PREVIOUS=<old>` and primary to the new value **everywhere at once**
   (staging, then production); restart. Reads try new, then old; writes use new.
2. Run the matching re-encrypt tool: dry-run, then `--apply` with the new
   fingerprint until `on-previous=0`.
3. Delete the `_PREVIOUS` variable everywhere.

## Recovery: wrong or missing key

Symptom at boot/first read: `…could not be read…` warnings and sessions
refusing to start — rows are intact, only the key is wrong. Fix = set the
correct primary (from the password manager) or add the lost value as
`_PREVIOUS`. Nothing is deleted on this error, by design. If the key is
genuinely lost, restore the key material from the password-manager history —
**not** the database rows.

## Related

- Column-grant hardening (independent, already applied): `supabase/migrations/20261022150000_telegram_session_column_hardening.sql`
- Broker credentials (separate keys, same envelope): `docs/broker-credential-key-rotation-runbook.md`
- Re-encrypt tools: `worker/src/diagnostics/reencryptTelegramSessions.ts`,
  `worker/src/diagnostics/reencryptWhatsAppAuth.ts`
