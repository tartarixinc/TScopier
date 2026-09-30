# Incident: Signal failed with "no position opened" — edited message bypassed the AI and the entry price was never read

- **Date:** 2026-09-18 (signal), diagnosed 2026-09-19
- **Status:** Fix written — not yet committed or deployed
- **Severity:** Medium (one user, one trade not opened)
- **Affected user:** `k.eloifabien@gmail.com` (Supabase `ce0fc42d-8597-44f7-8733-5ea90cfbd6be`)
- **Component:** Telegram edit/revision path — `worker/src/userListener.ts`, `worker/src/signalRevision.ts`, `worker/src/parseSignal.ts`
- **Signal:** `4e530999-4767-4825-8f24-aff19cb15892`, channel "Lorax Layer VIP" (`a54bb642-101e-40b0-872f-5fc688a3ccc3`), Telegram message `89381`
- **Rendered report:** `docs/incidents/incident-2026-09-18-entry-not-opened-revision-fastpath.pdf` (source HTML: same basename `.html`)

## Plain English

A signal provider posted a gold buy setup, then **edited** the message a minute later to add the full details — entry zone, take profits, and stop loss. The copier handled the edited message differently from a brand-new message. On an edit, it first tries to understand the message using its built-in rules, and only asks the AI if those rules fail.

The built-in rules accepted the edited message because it had a stop loss and take profits and the same direction as before. Those rules never check whether an entry price is present. The copier's rules also do not recognise the format "ENTRY ZONE: 4358" when only a single price is given — they only understand a range like "4358-4360".

So the copier accepted the signal without an entry price, never asked the AI for help, and then could not open the trade. The user saw "No position opened".

## Issue encountered

- At `2026-09-18 16:05:29 UTC`, Telegram message `89381` arrived in "Lorax Layer VIP" and signal `4e530999` was created.
- At `2026-09-18 16:06:20 UTC`, the provider **edited** the same message to the full setup:
  ```
  🟢 BUY: XAU/USD

  📍 ENTRY ZONE: 4358

  🎯 TP1: 4368 (+100 pips)
  🎯 TP2: 4378 (+200 pips)
  🎯 TP3: 4388 (+300 pips)
  🎯 FINAL TP: Open

  🛑 SL: 4348 (-100 pips )
  ```
- The listener logged `source=live_edit` and dispatched the revision.
- The stored parse had `entry_price: null`, `entry_zone_low: null`, `entry_zone_high: null`, with `sl: 4348` and `tp: [4368, 4378, 4388]`.
- Dispatch failed with `entry_not_opened` — there was no entry price to send to the broker.
- The admin dashboard showed "OSS context interpretation — Not reached (fast lane / AI disabled)".

## Affected user(s)

| User | Supabase id | Channel | Signal | Trades |
|------|-------------|---------|--------|--------|
| k.eloifabien@gmail.com | `ce0fc42d-…bd6be` | Lorax Layer VIP (`a54bb642-…`) | `4e530999` | 0 on this channel; 2 open sells elsewhere |

No trades were placed for this signal. No money was at risk from it.

## Root cause

The failure is the combination of two defects, triggered by the **message-edit path**.

1. **Edits take a different code path than new messages.** `tryApplyMessageRevisionInner` (`worker/src/userListener.ts:1983`) handles Telegram edits. It first calls `tryDeterministicRevisionCompletion` (`worker/src/userListener.ts:2306`) and only calls the AI (`parseUniversalSignal`) if that returns `null` (`worker/src/userListener.ts:2056`).

2. **The revision fast-path does not require an entry anchor.** `revisionHasDeterministicActionableParse` (`worker/src/signalRevision.ts:238`) accepts a revised parse when:
   - the action is `buy`/`sell`,
   - it carries explicit stops or targets (`parsedHasExplicitStopsOrTargets`), and
   - the prior action is `null` or the same direction (`worker/src/signalRevision.ts:258-266`).

   It never checks for `entry_price` / `entry_zone_low` / `entry_zone_high`. So the deterministic parse was trusted and the AI was skipped.

3. **The parser does not read `ENTRY ZONE: <single price>`.** `extractOptionalEntryAnchor` (`worker/src/parseSignal.ts`, single-price block at line 1108) understands `entry price:`, `entry:`, `entry level:`, `@price`, `buy at price`, and two-price ranges (`4358-4360`) — but not a single price after the words "ENTRY ZONE". The entry therefore came back `null`.

4. **Result:** a buy signal with SL/TP but no entry was accepted, the AI was never consulted, and dispatch failed with `entry_not_opened`.

### Why this is surprising

The AI normally *would* have caught this. Production runs the AI on the large majority of signals: over the last 7 days, 8,840 of 9,081 signals carried a verification chain (`fast_lane` 2,526 / `stage2_veto` 2,600 / `stage3` 2,094 / `stage2` 1,124). With `UNIVERSAL_PARSE_MODE=fastpath` and `UNIVERSAL_PARSE_FASTPATH_CONFIDENCE=0.99`, a 0.93-confidence signal would normally be sent to the AI. The **edit path** is the exception, because it does not apply the confidence threshold — it decides purely on the parsed shape.

## The fix

Applied:

- **A. Parser gap.** `worker/src/parseSignal.ts` — added a single-price `entry\s*zone\s*[:=]?\s*<price>` pattern in the `if (entry_zone_low == null)` block, with a negative lookahead so a range (`ENTRY ZONE: 4358 / 4360`) is still read as a zone. Also added `zone|area` and `/` to the `entrySlashZone` range pattern so an "ENTRY ZONE" slash range is not misread as a single price.
- **B. Revision fast-path.** `worker/src/signalRevision.ts` — both `revisionCompletesSettleableEntry` and `revisionHasDeterministicActionableParse` now return `false` when the message **labels an entry** (new helper `messageLabelsEntryAnchor` in `worker/src/signalEntryNowRequirement.ts`) but the deterministic parse has no anchor. This is the precise parser-gap signal; a genuine market entry ("Gold buy now", no entry label) is still accepted deterministically.
- **C. Fast-lane guard.** `worker/src/signalIntent/universalSignalParser.ts` — `deterministicQualifiesForFastPath` now also returns `false` for a buy/sell when the message labels an entry the parser missed, so the normal new-message route cannot fast-lane an incomplete parse either. The shared helper `parsedMissesLabeledEntry` backs both B and C.
- **D. Phantom entry from numbered TP/SL `@` separators.** `worker/src/parseSignal.ts` — `parseAtPriceExcludingSlTp` did not exclude numbered SL/TP labels, so `TP1 @ 4256` (and `TP 1 @`, `TP(1) @`, `TP1: @`, `Take Profit 1 @`) was read as the entry price, which could turn a "SELL NOW" market signal into a limit order at the take-profit price. The exclusion now covers numbered labels with optional separators. The same pattern is mirrored in `messageLabelsEntryAnchor` so the parser and the guard agree. The word `target` is deliberately **not** in the exclusion list, so an entry written as `Entry Target @4235` is still read as the entry (a first attempt added `target` and broke that case).

### Why not "require an entry anchor" (rejected approach)

The first attempt at Fix B required an entry anchor on the revised parse. The post-implementation review found this broke a legitimate flow: a bare market entry ("Gold buy now") edited to add SL/TP has **no** entry anchor by design. It also would not have been caught by `evaluateParsedSignalExecutionEligibility`, which returns `eligible: true` for the incident parse because `tradeableFromParsed` accepts labeled stops with a zero entry price. The label-gap check avoids both problems: it only rejects when the text names an entry the parser failed to read.

## Files changed

- `worker/src/parseSignal.ts` — Fix A: single-price `entry zone` pattern with range lookahead; `entrySlashZone` accepts `zone|area` and `/`. Fix D: numbered SL/TP `@` exclusion.
- `worker/src/signalRevision.ts` — Fix B: `revisedMissesLabeledEntry` guard on both revision helpers.
- `worker/src/signalEntryNowRequirement.ts` — new exported `messageLabelsEntryAnchor` and `parsedMissesLabeledEntry` helpers.
- `worker/src/signalIntent/universalSignalParser.ts` — Fix C: fast-lane guard.
- `worker/src/parseSignal.test.ts` — tests for the exact incident message, the slash-range zone, and numbered TP/SL `@` separators.
- `worker/src/signalRevision.test.ts` — tests for the label-gap rejection, the anchor-present acceptance, the market-entry acceptance, and the completes-settleable path.
- `worker/src/signalEntryNowRequirement.test.ts` — table tests for `messageLabelsEntryAnchor` / `parsedMissesLabeledEntry`.
- `worker/src/signalIntent/parseRouting.test.ts` — Fix C tests (missed labeled entry rejected; market entry and prose fast-laned).

## Verification

- Confirmed against production DB (`signals`): signal `4e530999` has `entry_price`/`entry_zone_low`/`entry_zone_high` all `null`, `sl: 4348`, `tp: [4368,4378,4388]`, `confidence: 0.93`, `skip_reason: entry_not_opened`, and no `_verification` chain.
- Confirmed in Railway listener logs (deployment `59949940`, prod): `message revision dispatch … signalId=4e530999 … source=live_edit`.
- Confirmed production runs the AI on most signals: 8,840/9,081 signals in the last 7 days have a verification chain.
- Confirmed the parser gap by re-parsing the exact message locally: `entry_price: null` (before fix).
- After Fix A: the exact message parses `entry_price: 4358`, `sl: 4348`, `tp: [4368, 4378, 4388]`; `ENTRY ZONE: 4358 / 4360` parses as zone 4358–4360 with `entry_price: null`.
- After Fix B: a labeled entry the parser missed returns `false` (AI consulted); the same message with an anchor returns `true`; the SIGNALS PRO market entry still returns `true`.
- After Fix C: a high-confidence parse that missed a labeled entry is not fast-laned; market entries and incidental prose ("target 200 pips from 2640", "support area 4350", "wait for a good entry") are still fast-laned.
- After Fix D: `TP1 @ 4256`, `TP 1 @ 4256`, `TP(1) @ 4256`, `TP1: @ 4256`, `TP#1 @ 4256`, and `Take Profit 1 @ 4256` no longer set `entry_price`; a legitimate `BUY XAUUSD @ 4358` still parses `entry_price: 4358`.
- Review regression (`signalsProEditFlow.test.ts:42`) found on the first attempt was fixed by the label-gap approach; the test now passes.
- `npm --prefix worker run build` (tsc) passes clean.
- 260 tests pass across all affected test files, 0 failures (incl. `parseSignal` 91/91, `signalRevision` 10/10, `signalsProEditFlow` 6/6, `signalEntryNowRequirement` 5/5, `parseRouting` 16/16).

## Post-implementation review

Two review subagents were run per the project policy.

- **code-tester: PASS.** Typecheck clean; all targeted suites green.
- **code-review: several passes.** Fix B's first attempt (require an entry anchor) was rejected as CRITICAL because it broke the legitimate market-entry completion. The reworked label-gap guard then drew a HIGH false positive (`buy|sell at` matched "SELL AT MARKET"), then two MEDIUM items (`price[:=]` matching "TP price:"/"Target price:", and the `modify` branch running before the guard). Fix C and the label additions then drew a HIGH (`\bfrom\s+\d` matching prose) plus MEDIUMs (`area`, bare `entry`, the `@` SL/TP separator, and numbered `TP1`/`TP 1` forms). All were fixed and re-verified. The final pass returned PASS_WITH_NOTES with only LOW/INFO items.
- One confirmation pass could not run because the review subagent returned "Insufficient Balance"; that intermediate diff was reviewed manually.

## Deployment status

Fix written, reviewed, and tested locally. Not committed and not deployed.

## Follow-ups

1. Commit and deploy to staging, then prod.
2. Consider whether the revision path should also respect a confidence threshold, or always consult the AI when the revised parse lacks an entry anchor.
3. The guard is a regex allow-list; a label neither the parser nor the guard recognises can still skip the AI on an edit. Known residual examples: `BUY ZONE 4358`, `buy area 4358`. No channel fixture proves a concrete bypass, but it is an inherent limitation to revisit if another such incident appears.
4. LOW: `parseSlFromText` reads the ordinal in `SL2 @ 4276` as the stop price (pre-existing, untouched by this fix).
5. LOW: prose ending in "entry <n>" (e.g. "wait for a good entry 2 hours ago") is treated as an entry label; the effect is only an unnecessary AI call (fail-safe), not a wrong trade.
