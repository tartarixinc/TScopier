import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  PartialTpMonitor,
  historyCloseProven,
  isPartialTpBenignBrokerError,
  isPartialTpTriggered,
  liveTicketAbsent,
  nextPartialFailureCount,
  partialFailureClass,
  partialRetryDelayMs,
  shouldTerminatePartialLeg,
  shouldMonitorPartialTpLeg,
} from './partialTpMonitor'
import type { FxsocketBrokerClient } from './fxsocketClient'
import type { SupabaseClient } from '@supabase/supabase-js'

// Single-mode trades ride to the LAST configured-bucket TP at the broker.
// The earlier TPs are partial-closes fired by the worker: a long basket's
// early TP fires when the BID rises to the trigger (we'd sell at bid); a
// short basket's early TP fires when the ASK falls to the trigger (we'd
// buy back at ask).

test('isPartialTpTriggered: buy fires when bid >= trigger', () => {
  // anchor=1850, TP1=1855 ⇒ bid touches 1855.
  assert.equal(isPartialTpTriggered(true, 1855, 1855, 1855.05), true)
  assert.equal(isPartialTpTriggered(true, 1855, 1856, 1856.05), true)
})

test('isPartialTpTriggered: buy does NOT fire while bid < trigger', () => {
  assert.equal(isPartialTpTriggered(true, 1855, 1854.95, 1855.05), false)
  assert.equal(isPartialTpTriggered(true, 1855, 1840, 1840.1), false)
})

test('isPartialTpTriggered: sell fires when ask <= trigger', () => {
  assert.equal(isPartialTpTriggered(false, 1845, 1844.9, 1845), true)
  assert.equal(isPartialTpTriggered(false, 1845, 1840, 1840.1), true)
})

test('isPartialTpTriggered: sell does NOT fire while ask > trigger', () => {
  assert.equal(isPartialTpTriggered(false, 1845, 1844.9, 1845.05), false)
  assert.equal(isPartialTpTriggered(false, 1845, 1855, 1855.1), false)
})

test('isPartialTpTriggered: rejects invalid inputs', () => {
  assert.equal(isPartialTpTriggered(true, 0, 1855, 1855.05), false)
  assert.equal(isPartialTpTriggered(true, NaN, 1855, 1855.05), false)
  assert.equal(isPartialTpTriggered(true, 1855, NaN, 1855.05), false)
  assert.equal(isPartialTpTriggered(false, 1845, 1840, NaN), false)
})

test('isPartialTpBenignBrokerError: unknown ticket is benign (prod incident 2026-08-10)', () => {
  assert.equal(isPartialTpBenignBrokerError('unknown ticket'), true)
  assert.equal(isPartialTpBenignBrokerError('OrderClose: unknown ticket'), true)
  assert.equal(isPartialTpBenignBrokerError('UNKNOWN TICKET'), true)
})

test('isPartialTpBenignBrokerError: existing benign replies still match', () => {
  assert.equal(isPartialTpBenignBrokerError('trade not found'), true)
  assert.equal(isPartialTpBenignBrokerError('position already closed'), true)
  assert.equal(isPartialTpBenignBrokerError('invalid ticket'), true)
  assert.equal(isPartialTpBenignBrokerError('no such order'), true)
})

test('isPartialTpBenignBrokerError: MT4 error 4108 invalid request is benign (duplicate-close race)', () => {
  assert.equal(isPartialTpBenignBrokerError('MT4 error 4108: Invalid request'), true)
  assert.equal(isPartialTpBenignBrokerError('4108 Invalid request'), true)
})

test('isPartialTpBenignBrokerError: real broker failures stay retryable', () => {
  assert.equal(isPartialTpBenignBrokerError('Insufficient funds'), false)
  assert.equal(isPartialTpBenignBrokerError('trade context busy'), false)
  assert.equal(isPartialTpBenignBrokerError('Invalid stops'), false)
  assert.equal(isPartialTpBenignBrokerError('HTTP 500'), false)
})

test('pending parent trade => zero quote calls and no leg mutation', () => {
  let quoteCalls = 0
  let legMutations = 0
  const monitorable = shouldMonitorPartialTpLeg(
    { broker_account_id: 'healthy-broker', trade_id: 'pending-trade' },
    new Set(),
    new Set(),
  )
  if (monitorable) {
    quoteCalls += 1
    legMutations += 1
  }
  assert.equal(quoteCalls, 0)
  assert.equal(legMutations, 0)
})

// Retry classification. The 2026-10-05 loop came from a failure that no
// classifier recognised: the leg failed, was rolled back to pending and was
// retried on every tick because nothing marked it unresolvable.

test('partialFailureClass: identity / reconciliation failures are unresolvable', () => {
  assert.equal(
    partialFailureClass('partial close reconciliation required: stored ticket has no live position match'),
    'unresolvable',
  )
  assert.equal(partialFailureClass('stored ticket maps to multiple live positions'), 'unresolvable')
  assert.equal(partialFailureClass('identity ambiguous for XAUUSD'), 'unresolvable')
})

test('partialFailureClass: rate limits and network errors are transient', () => {
  assert.equal(partialFailureClass('Too many requests'), 'transient')
  assert.equal(partialFailureClass('MTAPI OrderClose timed out'), 'transient')
  assert.equal(partialFailureClass('network error'), 'transient')
  assert.equal(partialFailureClass(''), 'transient')
})

test('partialRetryDelayMs: unresolvable failures back off exponentially from 30s', () => {
  assert.equal(partialRetryDelayMs(0, 'unresolvable'), 30_000)
  assert.equal(partialRetryDelayMs(1, 'unresolvable'), 30_000)
  assert.equal(partialRetryDelayMs(2, 'unresolvable'), 60_000)
  assert.equal(partialRetryDelayMs(3, 'unresolvable'), 120_000)
  assert.equal(partialRetryDelayMs(4, 'unresolvable'), 240_000)
})

test('partialRetryDelayMs: transient failures stay short so a real close is not delayed', () => {
  assert.equal(partialRetryDelayMs(1, 'transient'), 5_000)
  assert.equal(partialRetryDelayMs(2, 'transient'), 10_000)
  assert.equal(partialRetryDelayMs(4, 'transient'), 40_000)
})

test('partialRetryDelayMs: never exceeds the class cap, then parks', () => {
  assert.equal(partialRetryDelayMs(10, 'unresolvable'), 30 * 60_000)
  // Default park threshold is 3× TERMINAL_CANCEL_AFTER = 12: from there the leg
  // stops re-checking every 30 min and settles on a long delay.
  assert.equal(partialRetryDelayMs(12, 'unresolvable'), 6 * 60 * 60_000)
  assert.equal(partialRetryDelayMs(1_000, 'unresolvable'), 6 * 60 * 60_000)
  assert.equal(partialRetryDelayMs(10, 'transient'), 60_000)
  assert.equal(partialRetryDelayMs(1_000, 'transient'), 60_000)
})

test('nextPartialFailureCount: counters are per class and restart on a class change', () => {
  // First failure of a class starts at 1 (so the very first delay is the base).
  assert.equal(nextPartialFailureCount(undefined, 'unresolvable'), 1)
  assert.equal(nextPartialFailureCount(undefined, 'transient'), 1)
  // Same class keeps counting.
  assert.equal(nextPartialFailureCount({ count: 1, cls: 'unresolvable' }, 'unresolvable'), 2)
  assert.equal(nextPartialFailureCount({ count: 7, cls: 'transient' }, 'transient'), 8)
  // A different class starts that class at 1 — a flapping rate limit can never
  // grow the unresolvable counter towards the terminal-cancel threshold.
  assert.equal(nextPartialFailureCount({ count: 3, cls: 'unresolvable' }, 'transient'), 1)
  assert.equal(nextPartialFailureCount({ count: 3, cls: 'transient' }, 'unresolvable'), 1)
  // And a transient failure therefore also erases unresolvable progress.
  const afterFlap = nextPartialFailureCount({ count: 3, cls: 'unresolvable' }, 'transient')
  assert.equal(afterFlap, 1)
})

test('shouldTerminatePartialLeg: needs failure count, health, absence and close proof together', () => {
  // Threshold injected explicitly: the gate's contract must not depend on
  // PARTIAL_TP_TERMINAL_CANCEL_AFTER happening to be unset in this process.
  const after = 4
  const proven = { unresolvableCount: after, healthOk: true, absentFromLive: true, historyCloseMatched: true }
  // The full gate — and the only combination that may cancel a leg.
  assert.equal(shouldTerminatePartialLeg(proven, after), true)
  // Too few failures: backoff has not had its chance yet.
  assert.equal(shouldTerminatePartialLeg({ ...proven, unresolvableCount: after - 1 }, after), false)
  assert.equal(shouldTerminatePartialLeg({ ...proven, unresolvableCount: 0 }, after), false)
  // Unhealthy session proves nothing about the position.
  assert.equal(shouldTerminatePartialLeg({ ...proven, healthOk: false }, after), false)
  // Ticket still live (or the read was incomplete): never cancel.
  assert.equal(shouldTerminatePartialLeg({ ...proven, absentFromLive: false }, after), false)
  // History has no genuine close row (open-position echo / sibling comment).
  assert.equal(shouldTerminatePartialLeg({ ...proven, historyCloseMatched: false }, after), false)
  // A very high count cannot substitute for missing proof.
  assert.equal(
    shouldTerminatePartialLeg(
      { unresolvableCount: 99, healthOk: true, absentFromLive: false, historyCloseMatched: false },
      after,
    ),
    false,
  )
  // The threshold itself is honoured: a lower one widens the gate, a higher one narrows it.
  assert.equal(shouldTerminatePartialLeg({ ...proven, unresolvableCount: 2 }, 2), true)
  assert.equal(shouldTerminatePartialLeg(proven, after + 1), false)
})

// Absence proof for the terminal cancel. Two independent reads are required,
// because a single empty /OpenedOrders answer is not proof a position is gone
// (a live session can answer empty while syncing or for the wrong account).

const absentTrade = (over: Record<string, unknown> = {}) => ({
  id: 'trade-1',
  signal_id: 'abcd1234-0000-0000-0000-000000000000',
  metaapi_order_id: '111',
  symbol: 'XAUUSD.s',
  direction: 'buy',
  lot_size: 0.1,
  entry_price: 4140,
  ...over,
})

const liveRow = (ticket: number, over: Record<string, unknown> = {}) => ({
  ticket,
  operation: 'Buy',
  symbol: 'XAUUSD.s',
  lots: 0.1,
  openPrice: 4140,
  ...over,
})

/** /OpenedOrders stub that replays one result per call (an Error is thrown). */
function apiReturning(reads: unknown[]): FxsocketBrokerClient {
  let i = 0
  return {
    openedOrders: async () => {
      const next = reads[Math.min(i, reads.length - 1)]
      i += 1
      if (next instanceof Error) throw next
      return next
    },
  } as unknown as FxsocketBrokerClient
}

test('liveTicketAbsent: two empty reads on a flat account prove absence', async () => {
  assert.equal(await liveTicketAbsent(apiReturning([[], []]), 's', absentTrade()), true)
})

test('liveTicketAbsent: a position present in EITHER read blocks the cancel', async () => {
  // Present on the second read (false-empty first snapshot).
  assert.equal(await liveTicketAbsent(apiReturning([[], [liveRow(111)]]), 's', absentTrade()), false)
  // Present on the first read: no second read is needed.
  assert.equal(await liveTicketAbsent(apiReturning([[liveRow(111)], []]), 's', absentTrade()), false)
})

test('liveTicketAbsent: a live position with the SAME attributes still counts as present', async () => {
  // Fail-safe: an identical-looking sibling position blocks the cancel rather
  // than being mistaken for ours being gone.
  assert.equal(
    await liveTicketAbsent(apiReturning([[liveRow(999)], [liveRow(999)]]), 's', absentTrade()),
    false,
  )
})

test('liveTicketAbsent: a failed or incomplete read proves nothing', async () => {
  assert.equal(await liveTicketAbsent(apiReturning([new Error('Too many requests')]), 's', absentTrade()), null)
  assert.equal(await liveTicketAbsent(apiReturning([null]), 's', absentTrade()), null)
  assert.equal(await liveTicketAbsent(apiReturning([[], new Error('boom')]), 's', absentTrade()), null)
})

test('liveTicketAbsent: a trade row without identity attributes proves nothing', async () => {
  const unrecognisable = absentTrade({ symbol: null, lot_size: null, entry_price: null })
  assert.equal(await liveTicketAbsent(apiReturning([[], []]), 's', unrecognisable), null)
})

test('liveTicketAbsent: a trade with no stored ticket was never looked up, so it proves nothing', async () => {
  // The resolver answers "missing" for an invalid stored ticket WITHOUT
  // reading the rows — that must not be reported as a proven absence.
  const noTicket = absentTrade({ metaapi_order_id: null })
  assert.equal(await liveTicketAbsent(apiReturning([[], []]), 's', noTicket), null)
  const badTicket = absentTrade({ metaapi_order_id: 'nonsense' })
  assert.equal(await liveTicketAbsent(apiReturning([[], []]), 's', badTicket), null)
})

/** OrderHistory stub: replays one result per call (an Error is thrown). */
function apiHistory(reads: unknown[]): FxsocketBrokerClient {
  let i = 0
  return {
    orderHistory: async () => {
      const next = reads[Math.min(i, reads.length - 1)]
      i += 1
      if (next instanceof Error) throw next
      return next
    },
  } as unknown as FxsocketBrokerClient
}

test('historyCloseProven: only a real closing row counts, per the account provider', async () => {
  // FxSocket deal-level row matched on `position`, judged as FxSocket.
  const close = { ticket: 777, order: 0, position: 111, entry: 'Out', lots: 0.1, symbol: 'XAUUSD.s', price: 4129.67, profit: 6.42, time: '2026-10-05T20:29:50.987Z' }
  assert.equal(await historyCloseProven(apiHistory([[close]]), 's', absentTrade(), 'fxsocket'), true)
  // Opening deal of the same position: not proof.
  assert.equal(
    await historyCloseProven(apiHistory([[{ ...close, entry: 'In' }]]), 's', absentTrade(), 'fxsocket'),
    false,
  )
  // Partial-close deal (order !== 0): not proof.
  assert.equal(
    await historyCloseProven(apiHistory([[{ ...close, order: 42, lots: 0.05 }]]), 's', absentTrade(), 'fxsocket'),
    false,
  )
  // MTAPI position-level row, judged as MTAPI: close time present.
  const mtRow = { ticket: 111, symbol: 'XAUUSD.s', lots: 0.1, orderType: 'Buy', state: 'Started', openPrice: 4140, closeTime: '2026-10-05T20:29:50.987', closePrice: 4129.67 }
  assert.equal(await historyCloseProven(apiHistory([[mtRow]]), 's', absentTrade(), 'mtapi'), true)
  // An MTAPI open-position echo (no close time) proves nothing.
  assert.equal(
    await historyCloseProven(apiHistory([[{ ...mtRow, closeTime: undefined, closePrice: undefined }]]), 's', absentTrade(), 'mtapi'),
    false,
  )
  // Judged with the wrong provider: fails closed to `false`, never `true`.
  assert.equal(await historyCloseProven(apiHistory([[close]]), 's', absentTrade(), 'mtapi'), false)
  assert.equal(await historyCloseProven(apiHistory([[mtRow]]), 's', absentTrade(), 'fxsocket'), false)
  // Empty history (or null reply): no proof, so no cancel.
  assert.equal(await historyCloseProven(apiHistory([[]]), 's', absentTrade(), 'fxsocket'), false)
  assert.equal(await historyCloseProven(apiHistory([null]), 's', absentTrade(), 'fxsocket'), false)
  // Failed read: proves nothing (null, never true).
  assert.equal(await historyCloseProven(apiHistory([new Error('Too many requests')]), 's', absentTrade(), 'fxsocket'), null)
})

// markFired: the post-close write. Leaving the row `pending` means the next
// tick closes the same slice again, so the exact states the row can be in
// (ours, or reset by the stale-claim reaper) must be covered.

type MarkOutcome = { data: { id: string } | null; error: { message: string } | null }

function markHarness(outcomes: MarkOutcome[]): { monitor: unknown; calls: MarkOutcome[][] } {
  const calls: MarkOutcome[][] = []
  let i = 0
  const query = {
    from: () => query,
    update: () => query,
    eq: () => query,
    is: () => query,
    select: () => query,
    maybeSingle: async () => {
      const next = outcomes[Math.min(i, outcomes.length - 1)]
      i += 1
      calls.push([next])
      return next
    },
  }
  const monitor = new PartialTpMonitor({ from: () => query } as unknown as SupabaseClient)
  return { monitor, calls }
}

const ok: MarkOutcome = { data: { id: 'p1' }, error: null }
const noMatch: MarkOutcome = { data: null, error: null }
const dbError: MarkOutcome = { data: null, error: { message: 'connection reset' } }

test('markFired: our own claim is recorded on the first write', async () => {
  const { monitor, calls } = markHarness([ok])
  const result = await (monitor as { markFired(id: string, at: string): Promise<string> }).markFired('p1', 'now')
  assert.equal(result, 'ok')
  assert.equal(calls.length, 1)
})

test('markFired: a claim the reaper reset mid-flight is still recorded', async () => {
  const { monitor, calls } = markHarness([noMatch, ok])
  const result = await (monitor as { markFired(id: string, at: string): Promise<string> }).markFired('p1', 'now')
  assert.equal(result, 'ok')
  assert.equal(calls.length, 2, 'fallback CAS runs when our own claim is gone')
})

test('markFired: a row another worker owns is reported, never overwritten', async () => {
  // Both predicates miss on every attempt: someone else re-claimed it.
  const { monitor, calls } = markHarness([noMatch])
  const result = await (monitor as { markFired(id: string, at: string): Promise<string> }).markFired('p1', 'now')
  assert.equal(result, 'superseded')
  assert.equal(calls.length, 6, '3 attempts x primary + fallback, none written')
})

test('markFired: a database error is retried and reported, not swallowed', async () => {
  const { monitor, calls } = markHarness([dbError])
  const result = await (monitor as { markFired(id: string, at: string): Promise<string> }).markFired('p1', 'now')
  assert.equal(result, 'error')
  assert.equal(calls.length, 3, 'every attempt was tried before giving up')
})
