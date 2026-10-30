# Incident: User could not link Telegram — assistant claimed a code was sent when none was

- **Date:** 2026-09-17
- **Status:** Fixed — edge functions live on production; worker fix on staging
- **Severity:** Low (one user, no trades affected)
- **Affected user:** `iman_90@web.de` (Supabase `e0d1844e-bba3-4812-aa0f-e1e23f3a10da`)
- **Component:** assistant chat — `supabase/functions/_shared/assistantKnowledge.ts`, `supabase/functions/assistant-chat/index.ts`
- **Rendered report:** `docs/incidents/incident-2026-09-17-telegram-link-assistant-confusion.pdf` (source HTML: same basename `.html`)

## Plain English

A new user could not work out how to connect their Telegram account. They asked the
in-app assistant for help, typing "i cant add my telegram". The assistant opened a
phone-number box inside the chat and then told the user that a code had already been
sent to their Telegram. **No code was ever sent.** Nothing had been sent to Telegram at
all — the assistant simply opened an empty input box and then described it incorrectly.

The user waited, said "i didnt recieve anything", was told to try again, and eventually
gave up and was passed to live chat support. They never entered a phone number, so the
real linking process never started.

We fixed the assistant so it now sends the user to the Channels page and tells them to
enter their phone number there — the same form that already works elsewhere in the app.
We also added record-keeping so we can see every Telegram linking attempt in the database
instead of having to guess.

## Issue encountered

- User reported "i cant add my telegram" through the in-app assistant on 2026-09-17 13:41 UTC.
- The assistant called the `start_telegram_link` tool, which only opens a client-side
  phone-input card. It does **not** contact the worker or the Telegram API.
- The assistant then told the user "a code has been sent to Telegram", which was false.
- The user waited for a code that was never sent, got frustrated, and was escalated to support.
- No `send_code` was ever invoked. There was no server-side trace of the attempt at all.

## Affected user(s)

| User | Supabase id | Plan | Created (UTC) | Telegram session | Telegram claim | Signals / trades |
|------|-------------|------|---------------|------------------|----------------|------------------|
| iman_90@web.de | `e0d1844e-…3a10da` | Advanced (trialing) | 2026-09-16 21:44 | **none** | **none** | **none** |

No trades were affected — the copier never ran for this user. This incident is only about
the Telegram linking experience and the misleading assistant message.

## Root cause

1. **The assistant was instructed to prefer the wrong tool.** The system prompt
   (`assistantKnowledge.ts`) told the assistant to "Prefer start_telegram_link (in-chat
   phone + OTP secure cards)" for Telegram linking.
2. **That tool does not send anything.** `start_telegram_link` in
   `assistant-chat/index.ts` returns `{ queued: true }` and a pending client action that
   opens `AssistantTelegramLinkCard`. It makes no server call.
3. **The tool result gave the model no guidance.** Because the result was just
   `{ queued: true }`, the model invented the plausible-sounding but false statement that a
   code had been sent.
4. **There was no audit trail.** Client-side tool calls were not recorded anywhere, so the
   only evidence of the attempt was the chat transcript itself.

## The fix

- `assistantKnowledge.ts` — the "Link Telegram" instruction now tells the assistant to
  navigate to `/channels` and direct the user to the Telegram connection form at the top of
  that page. Behavior rule #4 no longer recommends `start_telegram_link`, and the
  `telegram_link` feature topic and page descriptions were updated to match.
- `assistant-chat/index.ts` — the `start_telegram_link` tool result now carries an explicit
  hint: the card is empty, no code has been sent, and the user must enter their phone number
  first. This prevents the model from claiming a code was sent.
- **Observability added** — Telegram linking is now recorded in `listener_events`:
  - `assistant_tool_call` — every client-side assistant tool call (navigate, start_telegram_link, open_live_chat, …)
  - `telegram_link_attempt` — when `send_code` or `verify_code` is called
  - `telegram_link_success` — when `finalizeAuth` completes
  - `telegram_link_failed` — with the step and error at every worker failure point

## Files changed

- `supabase/functions/_shared/assistantKnowledge.ts` — prompt now routes to `/channels`.
- `supabase/functions/assistant-chat/index.ts` — tool hint no longer implies a code was sent; client-side tool calls logged.
- `supabase/functions/telegram-auth/index.ts` — logs `telegram_link_attempt` on send_code / verify_code.
- `supabase/functions/_shared/listenerEvents.ts` — **new** shared helper for writing `listener_events` from edge functions.
- `worker/src/authService.ts` — logs `telegram_link_failed` at each failure point and `telegram_link_success` on finalize.
- `worker/src/listenerEvents.ts` — new `telegram_link_*` event types plus failure/success helpers.

## Verification

- Confirmed against production DB: `assistant_threads` holds the transcript; `telegram_sessions`,
  `telegram_auth_pending`, `telegram_account_claims`, `copier_listener_health`,
  `broker_accounts`, and `signals` are all empty for this user.
- Confirmed in Railway logs across all worker services: no `send_code`, `verify_code`, or
  `finalize_auth` events for this user.
- Worker typecheck (`npx tsc --noEmit`) passes.
- Subagent code review: PASS_WITH_NOTES. The one HIGH finding (the `telegram_link_success`
  log was unreachable because `finalize` is not a proxied route) was fixed by moving the
  success log into the worker's `finalizeAuth`. The duplicate-failure-log finding was fixed
  by removing the edge function's copy and keeping the worker as the single source.

## Deployment status

- **Edge functions** (`assistant-chat`, `telegram-auth`): deployed to **production**
  (`sxkpcovbyaficvtkpsdo`), **staging** (`axdcledcyhyvzrnfkwat`), and the Migration preview
  branch (`supmsgcubipmmowrzoub`).
- **Worker**: deployed to **staging** via Railway (commit `0af6685b`, SUCCESS on both
  Listener and Trade). Not yet on the production worker.
- **Git**: pushed to `origin/staging` and `origin/main` (`5453dbd4`), and to
  `upstream/staging` (`0af6685b`).

On production today the assistant now routes users to `/channels` and no longer claims a
code was sent, and `assistant_tool_call` / `telegram_link_attempt` rows are written to
`listener_events`. The worker-side `telegram_link_failed` / `telegram_link_success` rows
will only appear once the worker fix reaches the production worker.

## Follow-ups

- Deploy the worker fix to the production worker so failure/success rows are recorded there too.
- Watch `listener_events` for `telegram_link_failed` rows to catch future linking problems early.
- Consider surfacing a user-visible "we couldn't start your Telegram login" message rather
  than relying on the assistant's wording alone.
