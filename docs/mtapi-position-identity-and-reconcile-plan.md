# MTAPI position identity and open-trade reconciliation — follow-up plan

Date: 2026-10-06
Status: B2 implemented on the `staging` checkout (uncommitted draft, reviewed); B1 proposed
Related: `docs/scratchpads/scratchpad-health-check-sentry-2026-10-06.md`, `docs/PROJECT_MEMORY.md`

This document covers two pieces of follow-up work found while investigating a
production loop where the auto-breakeven monitor retried five trades forever:

- **B2 — record the broker position identity at fill time.** The real fix for
  the identity mismatch.
- **B1 — reconciliation must be able to close a leg that is genuinely gone,
  even when sibling legs of the same basket are still open.** This is what
  stops the production loop today.

They are documented in that order because B2 removes the cause and B1 repairs
the class of rows that are already wedged.

Note on state: the staging → production pull request (the close-reason feature)
has **not** been merged yet. Neither item below is part of it. The draft worker
change currently sitting uncommitted on the `staging` checkout (a nearest-entry
tie-break plus a per-basket claim set) is **not** to be merged as written — see
"Why the draft is not the fix" in B2.

---

## Background

A signal opened a basket of fourteen identical gold legs on one MT5 account
connected through the MTAPI bridge (account `13da4830`, signal `02f0e36f`).
Every leg: same symbol, same direction, same 0.05 lot size, entries within a
few cents of each other.

The auto-breakeven monitor could not decide which live position belonged to
each database row, so it refused to act ("reconciliation required") and retried
forever. On production this retry has no slow-down at all (the staging build
does have one), which is why it never stops.

The purpose of these two items is that the copier should always be able to
answer "which broker position is this row?" — and, when the position is
genuinely gone, to close the row rather than refuse forever.

---

## B2 — Capture the broker position identity right after a fill

### The problem

After a market order fills we store the ticket number the bridge returns. On
MT5 there are two different identifiers: the **order** ticket and the
**position** ticket. The live-position reads (used by auto-breakeven,
reconciliation, closing and P&L backfill) are keyed on the **position**
identity. When the stored number is an order ticket, every later lookup has to
guess by matching symbol, direction, size and price — which is exactly what
fails for a basket of identical legs.

### What the bridge actually gives us (evidence)

- Sending: the send response carries a single `ticket` plus price, size and
  state. There is **no** separate position identifier at send time
  (`docs/mtapi-conformance.md`, "OrderSend / OrderSendSafe").
- Later reads: live positions and history carry a nested object
  (`position` / `dealInternalIn`) from which the position ticket can be read.
  We already parse it — `resolveMtPositionTicket()`
  (`worker/src/mtTradeFields.ts:277`) and the identity set built by
  `parseLivePosition()` (`worker/src/livePositionIdentity.ts:78-99`).
- Live evidence from the affected basket: ten of the fourteen legs resolved
  normally and had their break-even applied between 14:34:41 and 14:34:50.
  Only four did not. So the data needed to identify a position **is available
  on a read taken just after the fill**; the gap is that we never record it.

### Proposed design

1. Immediately after a market fill is confirmed, read the broker's open
   positions for that account (bounded, one read per account per batch) and
   resolve the position for the ticket we just stored. This is the same idea
   already used for pending orders (`worker/src/brokerPendingFillDetect.ts`).
2. Store that resolved position number on the trade row. Preferred: add a
   dedicated column (for example `broker_position_ticket`) and keep
   `metaapi_order_id` as the order ticket, so order operations and position
   lookups each use the right number. Acceptable fallback: overwrite
   `metaapi_order_id` with the position ticket, which is what the readers
   already expect.
3. When the position number cannot be resolved (no matching position yet, or a
   genuinely ambiguous read), store nothing. Do **not** write a guess.
4. Keep every closing path strictly refusing when it is not certain. The
   identity captured here is authoritative; a guess is not.

### Why the draft is not the fix

The uncommitted draft adds a nearest-entry tie-break and a per-basket claim
set, and lets the existing code persist the matched number. The independent
design review rejected that (no-go) because persisting a **guessed** number
would:

- turn the safe "refuse because uncertain" close behaviour into "close
  confidently" on a guess, and
- permanently mis-assign close price and profit, which the P&L backfill writes
  once and cannot repair.

The data supports the reviewer: three legs share the identical entry
`4146.66000`, so "nearest entry" cannot actually tell them apart. A guess must
never be persisted. B2 obtains an authoritative number instead of a guess.

### Open questions for B2

- Confirm on a live account that the first read after a fill reliably exposes
  the nested position object for the account types we serve (the conformance
  note was captured when no positions were open).
- Decide the storage shape: dedicated column versus overwriting the ticket.
  The dedicated column is cleaner but needs a migration and changes to readers.
- Decide how to repair rows already stored with an order ticket (see B1
  remediation).

### Acceptance

- After a basket fill, every leg row carries a position identity that the live
  reads recognise, with no guessing.
- For a deliberately ambiguous basket, no guessed number is ever written.
- Existing tests for pending-order fill detection still pass.

---

## B1 — Reconciliation must close a leg that is genuinely gone

### The problem

Four legs of the basket never had break-even applied. Because break-even was
never applied, their take-profit (4149) was never cleared, and the price
reaching it closed those positions at the broker. The database rows are still
`open`, and reconciliation is not closing them.

### How reconciliation decides today (`worker/src/openTradeReconcile.ts`)

- It reads the broker's open positions for the account.
- For each open database row it resolves the live position:
  - resolved → nothing to do;
  - **ambiguous → it logs `identity ambiguous … deferring close` and does
    nothing**;
  - missing → the row is a candidate ghost.
- A row is only closed if it is missing from **two** separate complete
  snapshots (`missing` on both).
- A flat (empty) snapshot is additionally corroborated against closed history
  before anything is closed (`GHOST_UNCONFIRMED_BY_HISTORY` otherwise).

### Why it wedges on a basket

When a leg is genuinely gone, its stored ticket matches no live position, so
the resolver falls back to matching by symbol, direction, size and price —
and that matches its **still-open sibling legs**, which look identical. The
result is `ambiguous`, not `missing`, on both snapshots. Reconciliation
therefore defers the closed leg forever, and the auto-breakeven monitor keeps
failing on the same row for the same reason.

So the two symptoms have one cause: a lookup that cannot distinguish a leg
from its siblings can neither act on it nor conclude it is gone.
The `OPEN_TRADE_RECONCILE_FAILED` event (reason code of the same name) accounts
for roughly 128,000 production events in 24 hours, with
`user_impact: manual_review_required`.

### Proposed design

1. Resolve a basket **as a whole**, not one leg at a time: assign each stored
   leg to a distinct live position so that no two legs claim the same position.
   Legs left over with no candidate after the assignment are genuinely gone and
   can be closed. This is the claim-set idea, but used for the assignment
   decision only — it must not persist a guessed identity.
2. Where a unique per-leg marker exists (for example a per-leg order comment),
   use it to identify the leg's position or to conclude it is gone. Production
   has no comment column on trades today, so this needs a column or reuse of an
   existing field.
3. Once B2 is in place, the identity match becomes authoritative and this whole
   class disappears for new trades: the ticket either matches a live position
   or it does not.
4. Remediation for the rows already wedged (the four legs here, and any similar
   baskets): correct their stored identity by hand, or close them, after
   confirming against the broker history that the positions are gone.

### Open questions for B1

- Confirm for the four stuck rows, against the broker's closed history, that
  the positions really are closed and that the closure is recorded under a
  position or deal number rather than the stored order ticket. This is the same
  ticket-versus-position question as B2 and needs a live read.
- Decide whether the basket assignment belongs in the shared resolver or only
  in the reconciliation path. Closing paths must keep refusing on uncertainty.
- Confirm no basket is ever split across worker shards; production currently
  runs a single trade shard (`worker.shard_count: 1`), so this is not a live
  risk today but should be stated as an assumption.

### Acceptance

- A closed leg whose siblings are still open is marked closed by
  reconciliation within the normal cadence, without touching the siblings.
- No sibling position is ever closed, and no guessed identity is persisted.
- The auto-breakeven loop for such a leg stops as soon as the leg is closed.
- The counts of `OPEN_TRADE_RECONCILE_FAILED` and
  `autoManagementMonitor … errors=` fall back to their normal low level.

---

## Order of work

1. B2 first: capture and store the position identity at fill time (with the
   storage-shape decision), including the "never store a guess" rule.
2. B1 second: make reconciliation able to close a leg that is gone despite
   identical siblings, using basket-level assignment and, where available, a
   unique per-leg marker.
3. Remediate the currently wedged rows and watch the two event counts after
   each step.

Both items need the same live check first: confirm what the MTAPI bridge
reports for an existing position (nested position object, or a position number
on the order). That single check settles the storage shape for B2 and the
closure evidence for B1.

---

## Implementation status

### B2 — draft implemented (this checkout, uncommitted)

- `supabase/migrations/20261006140000_trades_broker_position_ticket.sql` — new
  nullable `text` column. **Not applied yet.**
- `worker/src/captureBrokerPositionIdentity.ts` — new. Resolves the just-filled
  ticket against a broker read with the strict resolver and writes the position
  number only when the resolution is certain; a guessed value is never written.
- `worker/src/tradeExecutor/orderLegExecution.ts` — after a market leg is
  persisted, capture runs once per send batch (one shared `OpenedOrders` read,
  lazily created, so a basket does not produce one read per leg). Capture
  failures are logged and swallowed; they never affect the entry flow.
- `worker/src/livePositionIdentity.ts` — the resolver now prefers
  `broker_position_ticket` when present and falls back to `metaapi_order_id`.
- Readers updated to carry the column and to match on it: the auto-breakeven
  monitor, forward reconciliation (`openTradeReconcile` /
  `openTradeReconcileMonitor`), management scope, news monitor, trailing-stop
  monitor, close-worse-entries, partial take-profit, broker drift, opposite
  close and revision-flip close.
- Tests: `worker/src/captureBrokerPositionIdentity.test.ts` (certain write,
  ambiguous read writes nothing, failed read writes nothing) and two resolver
  preference tests. 118 + 164 worker tests pass on the touched suites; worker
  typecheck clean.

### B2 — remaining before it is complete

1. **Apply the migration** (staging then production) and register it. If the
   column is missing the capture warns and skips, but every reader now selects
   the column, so the build must not be promoted before the migration is in
   place (see the review's deploy-order finding).
2. ~~Redirect `persistCanonicalPositionTicket`~~ — **done**. A certain
   replacement now writes `broker_position_ticket` and leaves the order ticket
   alone, CAS-guarded on the column that supplied the value, with a
   missing-column fallback to the legacy write.
3. SQL lookups that still filter by ticket on `metaapi_order_id` (for example
   `.in('metaapi_order_id', liveTickets)`) were only partly converted — the
   broker-drift prefilter now matches either column; the rest are follow-ups.
4. **Remediate existing rows** stored with an order ticket (for example the
   four wedged legs of the 14-leg basket).

### Known limitation (recorded, not yet implemented)

The capture uses one shared `OpenedOrders` read per send batch, taken lazily at
the first market leg's persist. On a 14-leg basket, a leg that fills after that
read may be absent from it and is then never captured (it writes nothing — safe,
but the leg keeps falling back to the order ticket). The design for a bounded
fix is one extra refresh per batch when a leg's own ticket is not found in the
snapshot; it was left out because every extra read adds load to the same bridge
the change is meant to relieve, and the right threshold needs the live read
described above. Track it with B1.

### Behaviour note (deliberate)

An attribute-only match — same symbol, side, size and price, but no ticket
relationship — is now **never persisted and never acted on**: both the capture
and `persistCanonicalPositionTicket` refuse it, and `resolveCurrentLivePosition`
returns `ambiguous`, so every caller including the close paths keeps refusing.
Those legs are actioned again only once their position identity is captured at
fill time. This is the safe direction the design review required.

### Follow-up (still keyed on the order ticket)

The remaining paths that act or filter on `metaapi_order_id` rather than the
position column: `channelStopApply`, `basketSlTpReconcile`, `rangeBasketTpSync`,
`applySignalOverride`, `basketModFollowUp`, `basketReconcileTargets`,
`forceCloseSignalTrades`, `managementBrokerClose`, `copyLimitFlatten`,
`orderCloseAudit`, and the management executor's direct ticket uses. Pending
(resting) order paths are correct as-is because a resting order has no position
ticket.

### B1 — not started

The reconciliation change (decide a basket as a whole so a genuinely-gone leg is
closed instead of deferred forever) is unchanged from the description above.

### B2 — independent review outcome and fixes

The first review returned FAIL with four HIGH findings. Resolutions:

- **H1 (capture could persist a guess).** Fixed: the capture now rejects any
  resolution whose `matchedBy` is `attributes`, so only a ticket-based match
  (canonical ticket or an explicit order→position relationship) is written.
  Test added for the attribute-only case.
- **H2 (replacement persistence broken once the column is preferred).** Fixed:
  `persistCanonicalPositionTicket` now CASes on the column that supplied the
  stored ticket and writes the **position** column, leaving the order ticket
  alone; if the column does not exist yet it logs once and falls back to the
  legacy `metaapi_order_id` write so reconciliation is not wedged. Tests added
  for the position-column CAS and the fallback.
- **H3 (deploy order can disable monitors).** Release gate, unchanged in code:
  the migration must be applied **and registered** before the worker build is
  promoted. Readers select the new column, so if the build lands first the
  management monitors' queries fail. Decide the exact order at release time and
  verify the column exists before promoting.
- **H4 (trailing stop still modified the order ticket).** Fixed: the trailing
  stop now modifies `broker_position_ticket ?? metaapi_order_id`.
- Also fixed: the auto-breakeven broker-SL snapshot lookup now keys on the same
  resolved ticket the modify uses; the revision-flip close prefers the position
  ticket and declares the field; the broker-drift prefilter now matches either
  column; the resolver treats an empty string as "not captured".
- Left as follow-up (documented above): the remaining stop/close paths that
  still key on `metaapi_order_id` (channel stop apply, basket SL/TP reconcile,
  range TP sync, signal override), and the SQL-filtered ticket lookups.

Tests after the fixes: 17 across the two identity test files; 140 across the
touched monitor suites; 164 tradeExecutor; worker typecheck clean.
