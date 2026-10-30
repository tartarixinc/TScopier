# `listener_events` reference

Audit trail for the Telegram listener layer. Every row records one thing the listener
did or saw for a user's channel: a message parsed, a signal reconciled, a Telegram
error, a channel disabled, and so on. It is append-only.

Retention is enforced by `prune_listener_events` (hourly pg_cron job). The window
depends on `event_type`: **7 days** for high-volume diagnostics, **30 days** for
everything else (default), **90 days** for rare incident/ops events.

Columns: `user_id`, `channel_row_id`, `telegram_message_id`, `event_type`,
`detail` (jsonb), `created_at`.

---

## 1. Message delivery / Telegram transport

| event | meaning | kind | kept |
|---|---|---|---|
| `unmapped_channel` | A message arrived from a monitored channel but could not be mapped to a `telegram_channels` row; it was ignored. | info | 30d |
| `poll_error` | Fetching new messages from Telegram failed (general poll failure, including repeated AUTH_KEY duplication). | error | 7d |
| `peer_resolve_failed` | A channel's Telegram entity (peer) could not be resolved, so it cannot be read/sent to. Emitted while warming a channel entity. | error | 7d |
| `poll_peer_resolve_failed` | Same peer-resolution failure, but during the poll cycle. | error | 7d |
| `catchup_get_messages_failed` | Defined in the worker's type list; **no code path emits it.** | error | 30d |
| `poll_flood_backoff` | Telegram rate-limited us (FloodWait / retry burst); polling paused and backed off, escalating on repeats. | throttle | 30d |

## 2. AI parsing

| event | meaning | kind | kept |
|---|---|---|---|
| `ai_entry_parsed` | The AI parse pipeline produced a successful **entry** (new-trade) result. | success | 30d |
| `ai_entry_skipped` | The AI parse pipeline returned a non-parsed result for an entry-intent message (skip reason). | info | 30d |
| `ai_modification_parsed` | The AI parse pipeline produced a successful **modification** result. | success | 30d |
| `ai_modification_skipped` | A modification-intent message or message-revision was not parsed (skip reason). Also emitted when a revision's AI parse is in rate-limit cooldown. | info | 7d |
| `ai_modification_failed` | AI parsing of a **message revision** threw an error. | error | 30d |
| `ai_parse_fallback` | The deterministic parser did not succeed or the AI flagged a reason, so a fallback path was used (`aiMeta.fallbackReason`). | info | 30d |
| `ai_parse_review_required` | The parse was flagged uncertain/risky (`aiMeta.reviewRequired`); human-review email + Telegram notification were sent. | warning | 30d |

## 3. Message edits (revisions)

| event | meaning | kind | kept |
|---|---|---|---|
| `message_revision_applied` | An edit to a stored signal was parsed and applied to the signal (and is about to be dispatched). | info | 30d |
| `message_revision_stale_skipped` | An edit was older than the revision we already had (out of order); ignored. | info | 30d |
| `message_revision_dispatch_deduped` | A revision was applied, but that same edit had already been dispatched; the duplicate dispatch was blocked. | info | 30d |
| `entry_settle_poll_mismatch` | The scheduled follow-up re-read of an entry message found the live Telegram text differs from what we stored; a revision is then attempted. | warning | 30d |
| `entry_settle_poll_applied` | The revision triggered by that follow-up re-read was applied. | info | 30d |
| `teaser_completion_merge_applied` | A partial "teaser" message was later completed; the completion was merged into the anchor signal. | info | 30d |

## 4. Signal reconciliation (stored signals vs. real Telegram messages)

| event | meaning | kind | kept |
|---|---|---|---|
| `signal_reconcile_checked` | A sweep checked one or more stored signals against Telegram and found **no** mismatch. Heartbeat; the highest-volume event by far. | info | 7d |
| `signal_reconcile_mismatch` | A stored signal differed from the live message — either the raw text changed or the stored parse drifted (see next row). A revision is attempted. | warning | 30d |
| `signal_reconcile_parsed_drift` | The raw text is unchanged, but re-parsing it yields different SL/TP targets than stored — the stored parse is stale. | warning | 7d |
| `signal_reconcile_sweep_error` | The reconcile sweep errored, either resolving the peer or fetching messages (`phase` in `detail`). | error | 30d |

## 5. Channel health

| event | meaning | kind | kept |
|---|---|---|---|
| `channel_invalid_detected` | A channel returned a confirmed invalid-channel error; counted toward the auto-disable threshold. | warning | 90d |
| `channel_auto_disabled` | The threshold was reached and the channel was disabled (`is_active=false`). Also emitted, with `persisted:false`, if the disable DB update failed. | warning | 90d |
| `channel_reactivated` | A previously failed/auto-disabled channel polled successfully again and was re-enabled. | success | 90d |
| `channel_shadow_mismatch` | Shadow ingest: the canonical (channel-level) parse and the per-user signal parse disagreed on status/action. | warning | 30d |
| `channel_reconcile_mismatch` | Channel-canonical reconcile: stored `channel_signals.raw_message` differs from the live Telegram text. | warning | 30d |

## 6. Telegram account linking / assistant audit

| event | meaning | kind | kept |
|---|---|---|---|
| `telegram_link_attempt` | A user started linking Telegram (QR login start) or the auth proxy handled a `send_code`/`verify_code` request. | info | 90d |
| `telegram_link_success` | Linking completed successfully. | success | 90d |
| `telegram_link_failed` | Linking failed (auth step error / QR login failure). | error | 90d |
| `telegram_link_disconnect` | The user's Telegram account was disconnected. | info | 90d |
| `assistant_tool_call` | The AI assistant invoked a **client-side** tool (audit only for client-side tools). | info | 90d |

---

## Error / problem events (the ones to alert on)

**Hard errors**
- `poll_error`
- `peer_resolve_failed`
- `poll_peer_resolve_failed`
- `catchup_get_messages_failed` (not currently emitted)
- `parse_http_failed` (legacy Python)
- `signal_persist_failed` (legacy Python)
- `signal_reconcile_sweep_error`
- `ai_modification_failed`
- `telegram_link_failed`

**Warnings / data-integrity signals**
- `ai_parse_review_required`
- `signal_reconcile_mismatch`
- `signal_reconcile_parsed_drift`
- `entry_settle_poll_mismatch`
- `channel_invalid_detected`
- `channel_auto_disabled`
- `channel_shadow_mismatch`
- `channel_reconcile_mismatch`

**Throttling**
- `poll_flood_backoff`

---

## Legacy / not-currently-emitted event types

These exist in the codebase or in historical prod data but are **not** written by the
current worker. They still get the default 30-day retention if they are ever written.

| event | where | meaning |
|---|---|---|
| `catchup_get_messages_failed` | worker `listenerEvents.ts` union | defined, never emitted |
| `channel_shadow_mismatch` | worker `channelCanonicalIngest.ts` | canonical vs per-user parse mismatch; only when shadow ingest is enabled |
| `channel_reconcile_mismatch` | worker `channelReconcileMonitor.ts` | canonical channel reconcile; depends on `channel_signals`/`channel_messages`, which are empty in prod |
| `channel_row_ambiguous` | legacy Python listener | multiple `telegram_channels` rows matched a message; one was picked (exact chat-id preferred) |
| `image_only_message` | legacy Python listener | message had no text (image only; no OCR) |
| `heuristic_rejected` | legacy Python listener | text did not look like a trading signal; skipped before parse |
| `duplicate_message_skipped` | legacy Python listener | a signal already existed for this message and no revision was applied |
| `parse_http_failed` | legacy Python listener | the parse HTTP call failed; force-AI retry attempted |
| `signal_persist_failed` | legacy Python listener | upsert of the signal row failed |
| `message_edit_applied` | historical only (June 2026) | no longer written |
| `message_edit_sweep_detected` | historical only (June 2026) | no longer written |

## Writers

- `worker/src/listenerEvents.ts` — shared writer + Telegram link helpers.
- `worker/src/userListener.ts` — most events.
- `worker/src/authService.ts` — `telegram_link_attempt`, `telegram_link_success`,
  `telegram_link_failed`.
- `worker/src/sessionManager.ts` — `telegram_link_disconnect`.
- `worker/src/channelCanonicalIngest.ts`, `worker/src/channelReconcileMonitor.ts`,
  `worker/src/tradeExecutor/basketMerge/mergeRouting.ts` — channel/merge events.
- `supabase/functions/_shared/listenerEvents.ts` and
  `supabase/functions/telegram-auth/index.ts` — `telegram_link_attempt`;
  `supabase/functions/assistant-chat/index.ts` — `assistant_tool_call`.
- `telegram-listener/app/listener_events.py` — legacy Python listener.
