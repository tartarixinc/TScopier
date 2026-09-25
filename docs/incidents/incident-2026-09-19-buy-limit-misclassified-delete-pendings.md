# Incident: "Buy limit" signal misclassified as "delete pendings" command

- **Date:** 2026-09-19
- **Status:** Fixed — Emmanuel's pending order routing fix cherry-picked; TP @-separator fix applied; translations added
- **Severity:** Low (one user, no trades affected — the signal was skipped)
- **Affected user:** `k.eloifabien@gmail.com` (Supabase `ce0fc42d-8597-44f7-8733-5ea90cfbd6be`)
- **Component:** signal parsing pipeline — `worker/src/parseSignal.ts`, `worker/src/manualPlanning/executionShape.ts`, `worker/src/tradeExecutor/helpers.ts`
- **Rendered report:** `docs/incidents/incident-2026-09-19-buy-limit-misclassified-delete-pendings.pdf` (source HTML: same basename `.html`)

## Plain English

A user sent a message to the "Lorax Layer VIP" channel that said "XAUUSD buy limit@4347.520" with stop loss and take profit levels. The copier's AI read this message and incorrectly decided it was a command to cancel pending orders, instead of recognizing it as a new buy limit order that should be placed on the broker.

Because the message was sent as a reply to another Telegram message, the copier tried to find the original trade being referenced. But the replied-to message was never a signal the copier had seen before, so it had no idea what trade to cancel. The copier then showed the user a raw internal code "delete pendings no parent" instead of a helpful error message.

We fixed this by pulling in Emmanuel's pending order routing fix, which adds proper recognition of explicit "buy limit" and "buy stop" wording. We also fixed a separate issue where take-profit values using the @ symbol (like "Tp1@4357") were not being parsed correctly, and added missing translations for the error message across all supported languages.

## Issue encountered

- At `2026-09-18 15:04:48 UTC`, user sent this message in the "Lorax Layer VIP" channel as a reply to Telegram message `62159`:
  ```
  XAUUSD buy limit@4347.520
  Sl@4337
  Tp1@4357
  Tp2@4375
  ```
- The AI pipeline classified the intent as `cancel_pending` (confidence 85%) — it interpreted this as "cancel my pending orders for XAUUSD."
- The copier recognized it as a reply-scoped management instruction and tried to find the parent signal.
- Message `62159` was not found in the `signals` table or `channel_messages` table — it was never a signal the copier had parsed.
- The copier skipped the instruction with reason `delete_pendings_no_parent`.
- The user saw the raw internal code "delete pendings no parent" instead of a helpful message.

## Affected user(s)

| User | Supabase id | Plan | Created (UTC) | Channel | Trades |
|------|-------------|------|---------------|---------|--------|
| k.eloifabien@gmail.com | `ce0fc42d-…bd6be` | Unknown | 2026-08-25 19:45 | Lorax Layer VIP | 0 on this channel; 2 open sells on other channels |

No trades were affected — the signal was skipped entirely. The user has 2 open sell positions on gold from other channels, but none from "Lorax Layer VIP."

## Root cause

1. **AI misclassified the intent.** The message "XAUUSD buy limit@4347.520" was clearly a new entry order, but the AI pipeline classified it as `cancel_pending` (85% confidence). This is a classification error in the signal parsing pipeline.

2. **Missing `entry_order_type` field.** Before Emmanuel's fix, the copier did not recognize explicit "BUY LIMIT" or "BUY STOP" wording. The message was parsed as a plain `buy` with an entry price, which the AI then misinterpreted as a cancel command when combined with the reply context.

3. **No parent signal found.** The copier tried to find the original trade referenced by the reply (message `62159`), but that message was never a signal in the copier's database. The copier gave up entirely instead of attempting to place the trade.

4. **Missing translation.** The skip reason `delete_pendings_no_parent` had no user-facing label in any locale, so the fallback at `channelWorkerLogMessage.ts:275` just converted underscores to spaces.

5. **TP parsing did not support @ symbol.** The regex patterns for parsing take-profit values used `[:=\-\s]` as separators but did not include `@`. Messages like "Tp1@4357" were not parsed correctly.

## The fix

- **Emmanuel's pending order routing fix** (cherry-picked from `fd4b1750` and `28f59e79`):
  - Adds `entry_order_type: 'market' | 'limit' | 'stop' | null` to parsed signals.
  - Explicit "BUY LIMIT" and "BUY STOP" wording is now preserved in the parser.
  - The copier routes explicit pending order operations directly to `BuyLimit`, `SellLimit`, `BuyStop`, or `SellStop` instead of converting them to market orders or misclassifying them.

- **TP @-separator fix** (`worker/src/parseSignal.ts`):
  - Added `@` to the regex character class `[:=\-\s]` in TP parsing patterns (lines 565-568, 572-573).
  - Messages like "Tp1@4357" are now correctly parsed as take-profit levels.

- **Missing translations** (all 9 locale files + `copierSkipReasonLabels.ts`):
  - Added `delete_pendings_no_parent`, `delete_pendings_requires_reply`, and `delete_pendings_none` to all locale files.
  - Added labels and detailed explanations to `COPIER_SKIP_REASON_LABELS` and `COPIER_SKIP_REASON_DETAILS`.

## Files changed

- `worker/src/explicitPendingOrder.test.ts` — **new** test file for explicit pending order parsing and routing.
- `worker/src/manualPlanning/executionShape.ts` — added `explicitEntryOrderType` parameter; explicit pending orders bypass legacy market/strict-entry coercion.
- `worker/src/manualPlanning/planManualOrders.ts` — passes `explicitEntryOrderType` to `resolveOpExecAndStrict`.
- `worker/src/manualPlanning/types.ts` — added `EntryOrderType` type and `entry_order_type` field to `ParsedSignal`.
- `worker/src/manualPlanner.ts` — re-exports `EntryOrderType`.
- `worker/src/parseSignal.ts` — added `applyExplicitEntryOrderType` function; added `@` to TP parsing regex patterns.
- `worker/src/tradeExecutor/entryPrepare.ts` — passes `entry_order_type` through the planning pipeline.
- `worker/src/tradeExecutor/helpers.ts` — `operationFor` now maps explicit `entry_order_type` to correct broker operations.
- `src/i18n/channelWorker/en.ts` — added `delete_pendings_no_parent`, `delete_pendings_requires_reply`, `delete_pendings_none`.
- `src/i18n/channelWorker/fr.ts` — French translations.
- `src/i18n/channelWorker/es.ts` — Spanish translations.
- `src/i18n/channelWorker/ar.ts` — Arabic translations.
- `src/i18n/channelWorker/ja.ts` — Japanese translations.
- `src/i18n/channelWorker/nl.ts` — Dutch translations.
- `src/i18n/channelWorker/pl.ts` — Polish translations.
- `src/i18n/channelWorker/ru.ts` — Russian translations.
- `src/i18n/channelWorker/sv.ts` — Swedish translations.
- `src/lib/copierSkipReasonLabels.ts` — added labels and details for `delete_pendings_*` skip reasons.
- `docs/PROJECT_MEMORY-EMMA.md` — Emmanuel's project memory entry for the explicit pending order fix.

## Verification

- Confirmed against production DB: `signals` table shows the skipped signal `bb6b1b85` with `parent_signal_id: null` and `skip_reason: delete_pendings_no_parent`.
- Confirmed the replied-to message `62159` does not exist in `signals` or `channel_messages` — it was never a signal the copier had parsed.
- Parser test: "XAUUSD buy limit@4347.520\nSl@4337\nTp1@4357\nTp2@4375" now correctly parses with `entry_order_type: limit` and `tp: [4357, 4375]`.
- All 3 explicit pending order tests pass.
- Worker typecheck (`npx tsc --noEmit`) passes.

## Deployment status

- **Code**: cherry-picked to the `migration` branch and staged. Not yet committed or deployed.
- **Pending**: commit, push to staging, deploy to production worker.

## Follow-ups

- Investigate why the AI pipeline misclassified "XAUUSD buy limit" as a `cancel_pending` intent. The message format is clearly a new entry, not a cancel command. The classification confidence was 85%, which suggests a systematic issue with how the AI distinguishes between entry orders and cancel commands.
- Deploy the fix to staging and production.
- Consider adding a more robust fallback: if a management instruction fails to find a parent signal, surface a clear user-facing message instead of a raw code.
