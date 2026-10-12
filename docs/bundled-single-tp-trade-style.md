# One-trade-per-TP bundling inside multi style (design)

Status: draft, revised after design review and simplified to a single on/off
env flag (2026-10-12). Not implemented.

## Problem

Today an account has two trade styles, and both have structural weaknesses when
a signal carries several take-profits (TP1, TP2, TP3, …):

- **Single style** opens one broker order and relies on our worker to close the
  agreed share of the lot when each early TP is reached (`partial_tp_legs` +
  `partialTpMonitor`). If the worker is down or delayed at that moment, the
  partial close is missed or late. The broker itself only ever knows one TP.
- **Multi style** splits the lot into legs sized by `multi_trade_leg_percent`
  (default 5% per leg). The number of legs is decided by lot math, not by the
  number of TPs in the signal. This produces odd results: one leg means
  everything closes at TP1; two legs mean TP3 is skipped entirely; five TPs and
  three legs mean two levels get no exit at all.

Neither style expresses the simple intent most users have: "close 50% of the
lot at TP1, 30% at TP2, 20% at TP3 — and have the broker guarantee every one
of those exits."

## Proposal

Keep `trade_style = 'multi'` and, **selected purely by one worker environment
flag**, change how the multi planner builds its legs:

- **Gate denied (today's behaviour for everyone else):** leg count from lot ÷
  leg-percent; legs get TPs by count-weighted Targets % distribution.
- **Gate allowed:** **one leg per take-profit level**, sized directly by the
  Targets % rows, each carrying its own broker-side take-profit. No
  partial-close schedule; `partialTpMonitor` is not involved; every exit is a
  normal broker take-profit on a normal trade.

Example — 1.00 lot, signal with TP1 4093 / TP2 4095 / TP3 4097, default
Targets % (50 / 30 / 20), gate allowed:

| Position | Lots | Broker TP | Closed by |
| --- | --- | --- | --- |
| Leg 1 | 0.50 | 4093 | Broker |
| Leg 2 | 0.30 | 4095 | Broker |
| Leg 3 | 0.20 | 4097 | Broker |

**v1 has no user-facing setting and no UI.** The env gate is the only switch.
A per-account checkbox in Configure (`manual_settings.multi_trade_per_tp`) is
deferred to phase 2, when the behaviour is proven and opened up; the design
below keeps that path open.

### Why multi + gate, not a third style value

The earlier draft proposed `trade_style = 'bundle'`. The design review surfaced
two hard blockers, and both disappear when the feature rides on `multi`:

1. **Send guards pass for free.** The executor refuses multi-leg sends for any
   style other than multi (`entryPrepare.ts:1089-1111`,
   `orderLegExecution.ts:133-152` → `single_style_multi_leg_blocked`). With
   `trade_style = 'multi'`, bundled legs are allowed with no guard changes.
2. **Config completeness checks pass for free.** `channelManualSettingsComplete`
   (worker `channelTradingConfig.ts:162-168`, frontend `:149-155`) only
   accepts `'single' | 'multi'`. A third value would either slip through
   silently or, once normalized, fail the check and stop all copying for that
   channel.

Additionally, every downstream branch that keys on `trade_style === 'multi'`
to mean "basket of legs with per-leg TPs" — `managementModifyBaskets`'s
`multiBasket`, `slTpRefresh`, `postFillFollowUp`, `TradeExecutor`,
`shouldApplySingleTakeProfitTarget` (false for multi), trailing (disabled for
multi), plan limits (multi is advanced-gated) — already treats the account
correctly with no changes.

## Design decisions

### D1. The switch: one environment variable (v1)

A single env var — `TP_BUNDLE_ENABLED` — is the whole feature switch:

- **Unset, `false`, or any invalid value:** feature off; classic multi split,
  byte-identical to today.
- **`true`:** every multi-style account builds bundled legs (D2).

`isTpBundleEnabled(env?)` in a small
`worker/src/manualPlanning/tpBundleRollout.ts` reads it (parse strictly;
anything that is not clearly true counts as off). Nothing is persisted in
`manual_settings` in v1.

Rollout is per environment, not per account: Railway staging and production
are separate services, so staging sets the flag first, production later. The
earlier drafts carried an account allowlist, a kill switch, and a prepare-only
phase copied from the layering-mode rollout — all removed as over-engineering
for a single boolean.

Phase 2 (not v1): promote to a per-account setting
(`manual_settings.multi_trade_per_tp: boolean`, normalized, surfaced as a
checkbox in the multi section of `AccountConfigPage.tsx` with the netting
warning) once production data shows the behaviour is sound. The env gate then
becomes the outer kill switch around the setting.

### D2. Planner: one immediate leg per enabled Targets % row

The multi planner (`planMultiManualOrders.ts`) gains a bundle branch, chosen
early when the flag is on, the account is multi, and
`range_trading !== true`:

1. `finalSl` / `finalTps` come from the existing `deriveManualStopsWithClamp`
   call in `planManualOrders` — pip conversion, override, R:R synthesis and
   min-stop clamping are unchanged.
2. Reuse `resolveTpBucketRows` (`tpBucketDistribution.ts:15-40`) for one
   bucket per TP with its Targets %.
3. For each bucket with `percent > 0` and a finite `finalTps[i]`:
   `lots = floor(manualLot * percent / 100 / lotStep) * lotStep`; skip buckets
   below `minLot`.
4. Emit one immediate `OrderSendArgs` per remaining bucket with
   `takeprofit = finalTps[i]`, shared `stoploss = finalSl`, same `orderBase`
   (comment suffix identifies the level, e.g. `TP2`).
5. Lot accounting:
   - Rounding remainder goes to the **farthest** bucket so the leftover still
     exits at a broker TP.
   - A bucket dropped for falling below `minLot` donates its intended lots to
     the **farthest remaining** bucket.
   - Invariant: emitted lots sum to `manualLot` floored to `lotStep`, except
     when every bucket would be below `minLot` (then
     `skip_reason: 'lot_below_symbol_min'`).
6. Degenerate cases:
   - No finite TPs (teaser / `open_tp`): one full-lot order with
     `takeprofit: 0` (same rule as today's multi at
     `planMultiManualOrders.ts:344-434`).
   - Only one usable bucket: a single order at that TP; no partial schedule.
   - Fewer than two usable buckets: single order, no partial schedule.

**Critical constraint (from design review):** the bundle branch must emit legs
**directly per bucket** as above — never through
`buildDistributedPerLegTakeProfits` / `distributeCountAcrossTpBuckets`. Those
distribute a *leg count* by weight with rounding: 3 legs over 50/30/20 yields
counts `[2, 1, 0]` → prices `[TP1, TP1, TP2]` — no leg at TP3 and two legs at
TP1. That math is fine for classic multi (weights approximate) and wrong for
bundling (identity is the point).

Range trading: when `range_trading === true`, the flag is ignored for
that signal, classic multi splitting applies, and a warning is logged
(layering creates pending legs whose per-rung sizing does not map onto TP
levels; out of scope for v1).

### D3. Identity-preserving per-leg TP model (critical, from design review)

Bundled legs must keep **their own** TP for the life of the trade. Even with
the correct D2 planner, downstream paths that re-derive TPs from counts would
repaint the basket wrongly. Verified repaint hazards:

1. `slTpRefresh.ts:429-461` — non-multi styles overwrite every leg's TP with
   `plan.orders[0]?.takeprofit`. Bundled accounts are `multi`, so they already
   avoid this path.
2. `buildDistributedPerLegTakeProfits` / `takeProfitForLegIndex` /
   `expandPerLegTargetsToCount` (`tpBucketDistribution.ts`) — count-weighted
   redistribution. Used by multi baskets in `managementModifyBaskets`
   (`takeProfitForLegIndex` at `:73-79`), `basketSlTpReconcile`,
   `basketReconcileTargets`, `channelStopApply`, `slTpRefresh`'s
   `buildPerLegStopTargets`. Even when open-leg count equals bucket count, a
   3-leg 50/30/20 basket re-derives as `[TP1, TP1, TP2]`.

Because v1 has no persisted per-account marker, "is this basket bundled?" is
answered by the same env flag at runtime: `isTpBundleEnabled()`.

Rules when the flag is on:

- **Steady state (reconcile, refresh, BE moves):** legs keep the TP they
  already have. Reconcile validates SL/TP presence and broker agreement; it
  never re-derives TPs for bundled baskets.
- **Explicit reladder (channel "SET TP…" / user override):** re-map by **TP
  order, 1:1** — sort open legs by current TP in trade direction (buy:
  ascending; sell: descending), assign the new ladder's levels in order,
  truncating or leaving surplus legs on their existing TP. No weights, no
  counts.
- Implementation: a small helper next to `tpBucketDistribution.ts` (e.g.
  `reorderBundledLegTargets`) used by `managementModifyBaskets`,
  `basketSlTpReconcile`, `basketReconcileTargets`, `channelStopApply`, and
  `slTpRefresh` in place of the count-weighted functions whenever the flag is
  on.

**Operational rule (env-only consequence):** the flag applies to open
baskets as well as new entries, so:

- Turn the flag **off only after bundled baskets have drained** (all legs
  closed). On staging this is easy to arrange; for production, flip during a
  quiet window.
- Turning the flag off stops **new** bundled entries immediately. Open
  bundled baskets keep their broker-side TPs (the exits still work — that is
  the whole point of the feature). The residual risk is that a channel
  "SET TP" reladder arriving after the flag is turned off would take the
  classic count-weighted path on those legs and could repaint them (see
  hazard 2). This window is accepted for v1; if mid-flight flips become
  routine, phase 2's persisted setting (or a per-basket marker in trade
  meta) removes the hazard.

### D4. Partial-close management messages ("CLOSE TPn")

The parser currently flattens `CLOSE TP1..TP4` keywords into one boolean
intent with an optional fraction (`parseSignal.ts:912-917`, `:998-1001`) — the
referenced level is discarded. In single style a bare "CLOSE TP1" therefore
closes half the position by default (`managementExecutor.ts:1213-1215`).

For bundled baskets the level matters and is worth plumbing:

- Parser: carry the referenced level (`close_tp_index`) through
  `ChannelParsedSignal` / `ParsedSignal` alongside `partial_close_fraction`.
- Executor (flag on): `CLOSE TPn` with a matching open leg closes
  that leg **in full** (respecting minLot/lotStep/maxLot) via `orderClose` on
  the leg's ticket.
- No matching open leg (already closed at the broker): **no-op with a log
  line** — the provider's intent is already satisfied.
- Flag off: classic behaviour (multi has no special CLOSE TPn handling
  today; unchanged). Single style unchanged in v1.

### D5. Netting vs hedging accounts

On netting symbols, several same-direction positions on one instrument merge
into one net position — bundling cannot survive (classic multi has the same
exposure today). Stance for v1:

- At plan time, if symbol params expose a positions/hedging mode flag and the
  account is netting, **ignore the bundle flag and emit one full-lot order**
  with the farthest TP (the existing multi min-lot fallback shape at
  `planMultiManualOrders.ts:94-110`), logging `bundle_netting_fallback`. No
  partial schedule — same trade-off that fallback already accepts.
- If FxSocket does not expose positions mode, detect the merge after send
  (leg count reduced) and log it.

**v1 status (deferred):** the pre-implementation check confirmed FxSocket does
**not** expose a hedging/netting positions-mode field on the account or on
`normalizeSymbolParams` (`fxsocketClient.ts`); a repo-wide grep for
`netting`/`hedging`/`positionsMode` finds no such capability. The
plan-time fallback therefore **cannot be implemented in v1** and no post-send
leg-count detection is shipped. Consequence: on a netting symbol a bundle
degrades to a merged net position (same exposure as classic multi today) with
no explicit log. **Follow-up (v1.1):** add post-send fill-count detection and a
`bundle_netting_merge` log line, or a broker-side capability probe if one
becomes available. This is tracked in PROJECT_MEMORY.

### D6. Auto-management (`tp_hit` breakeven)

Bundled accounts are multi, so current multi behaviour applies unchanged:
per-leg broker TPs are kept, and `resolveAutoBeTpHitTriggerPrice` resolves
the trigger from the ladder (`autoManagement.ts:116-144`). Per-leg "BE at own
TP" is a no-op (the leg closes there). The meaningful semantic — "when the
nearest level is hit, move SL on the **remaining** legs" — is new behaviour
and deferred; document it as a v1.1 candidate. No v1 code change.

### D7. Persistence and identity

Each bundled leg is a normal `trades` row with its own `tp` and its own
`metaapi_order_id` — no new tables, and no `manual_settings` change in v1.
Legs share `signal_id` and the basket anchor exactly like classic multi legs,
so basket reconcile, merge, and the dispatch claim machinery treat them as one
family. No `partial_tp_legs` rows are written. The leg ↔ level association
lives in `trades.tp` (D3).

## Rollout

1. Land the planner branch + `tpBundleRollout.ts` + D3 helper and its call
   sites on `staging`, flag unset (off); unit tests green.
2. Set `TP_BUNDLE_ENABLED=true` on the **staging** worker only; trade small;
   watch `trade_execution_logs`, basket reconcile jobs, unknown-ticket
   rates, and specifically for TP repaint (a leg whose TP changed without a
   channel modify message indicates a missed D3 branch).
3. Hold about a week of clean signals; turn the flag off only after open
   bundled baskets have drained (D3).
4. Phase 2 (separate decision): per-account setting + UI checkbox. Production
   enablement of either phase follows the normal staging → main rule: set the
   flag on the production worker only after staging is clean.

## Testing

- Bundle planner branch — 3-level ladder with 50/30/20 produces 3 orders with
  the right lots and TPs (assert exact `[TP1, TP2, TP3]`, not the
  count-weighted `[TP1, TP1, TP2]` trap); remainder assignment; below-minLot
  bucket redistribution; single-bucket degenerate; `open_tp`; pip-unit
  conversion; netting fallback (D5); range_trading ignores the flag.
- `tpBundleRollout.test.ts` — unset/false/invalid all deny; only `true`
  allows.
- Management — "CLOSE TPn" closes the matching leg when the flag is on;
  no-match is a no-op; explicit reladder re-maps 1:1 by TP order;
  reconcile/refresh never repaint TPs when the flag is on (a test per D3
  call site, with a deliberately wrong count-weighted expectation to prove
  the branch is taken).
- Flag-off regression — with the env var unset, every existing
  multi/single test is unchanged and green (the classic path must be
  byte-identical).
- No frontend tests needed in v1 (no UI change).

## Non-goals (v1)

- Per-account setting and UI checkbox (phase 2).
- Range/layering interaction (flag ignored with a warning).
- The AI / non-manual execution path (still uses `tp[0]`; unchanged).
- Per-leg entry offsets — all legs enter at the same planned entry.
- Auto-BE remaining-legs semantics (D6 — v1.1 candidate).
- Upgrading single/classic-multi "CLOSE TPn" to honour the level (D4
  follow-up).
- Changing classic multi or single behaviour when the flag is off.

## Resolved open questions

1. **"CLOSE TP2" with no matching leg** → no-op with a log line (D4).
2. **Leg-count cap** → none needed; leg count is bounded by the enabled
   Targets % rows. `multi_trade_max_orders` does not apply when bundled.
3. **Switch mechanism (this revision)** → one env var,
   `TP_BUNDLE_ENABLED`, is the entire v1 switch (unset/false = off). The
   per-account checkbox is phase 2.

## Pre-implementation verification tasks

- Confirm whether FxSocket exposes hedging/netting mode on account or symbol
  params (D5 gate).
- Dry-run the ordered 1:1 reladder against a hand-built 3-leg basket on
  staging (including one manually closed middle leg) once the flag is on
  for staging.
- Audit every call site listed in D3 to confirm the broker account id is in
  scope; add a test per site.
