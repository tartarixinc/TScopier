import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COVERAGE_MARGIN_MS,
  FillAttempts,
  classifyFillOutcome,
  extractClosedTradeFillsByTicket,
  historyCoverage,
  historyWindow,
  missingFillFilter,
  mtCloseRowRejection,
  nextClosedFillCursor,
  planClosedTradeUpdates,
  stillMissingFill,
  tallyBrokerBatch,
  type ClosedTradeFill,
  type ClosedTradeFillRow,
} from './closedTradeFill'
import {
  resolveMtClosePrice,
  resolveMtCloseTimeMs,
  resolveMtPositionTicket,
  resolveMtStoredProfit,
} from './mtTradeFields'

/** DB row as the batch selects it: both fill columns reported so the planner
 * can refuse to rewrite one that is already set. */
const row = (
  id: string,
  ticket: string | null,
  over: Partial<ClosedTradeFillRow> = {},
): ClosedTradeFillRow => ({
  id,
  broker_account_id: 'b1',
  metaapi_order_id: ticket,
  closed_at: null,
  close_price: null,
  profit: null,
  ...over,
})

/** Shape of a real MTAPI OrderHistory row for a closed trade — ticket,
 * size, symbol, state and close time all present (see the sanitized payload
 * samples in `docs/mtapi-conformance-sanitized.md`);
 * `mtCloseRowRejection` requires every one. */
const closedMtRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  symbol: 'EURUSDm',
  lots: 0.01,
  state: 'Filled',
  closeTime: '2026-09-24T09:51:00.000',
  ...over,
})

test('resolveMtClosePrice: first positive key wins, zero never shadows a later value', () => {
  assert.equal(resolveMtClosePrice({ closePrice: 0, ClosePrice: 1.2345 }, 'trades'), 1.2345)
  assert.equal(resolveMtClosePrice({ ClosePrice: 0.5 }, 'trades'), 0.5)
  assert.equal(resolveMtClosePrice({ closePrice: '2.5' }, 'trades'), 2.5)
})

test('resolveMtClosePrice: missing, zero-only, or junk values return null', () => {
  assert.equal(resolveMtClosePrice({}, 'trades'), null)
  assert.equal(resolveMtClosePrice({ closePrice: 0, ClosePrice: 0 }, 'trades'), null)
  assert.equal(resolveMtClosePrice({ closePrice: 'abc' }, 'trades'), null)
  assert.equal(resolveMtClosePrice({ closePrice: null }, 'trades'), null)
})

test('resolveMtCloseTimeMs: reads the same close-time keys the dashboard does', () => {
  assert.notEqual(resolveMtCloseTimeMs({ timeDone: '2026-09-24T09:51:00.000' }, 'trades'), null)
  assert.notEqual(resolveMtCloseTimeMs({ CLOSE_TIME: '2026-09-24T09:51:00.000' }, 'trades'), null)
  assert.notEqual(
    resolveMtCloseTimeMs({ doneBrokerTime: '2026-09-24T09:51:00.000' }, 'trades'),
    null,
  )
  assert.equal(
    resolveMtCloseTimeMs({ time: '2026-09-24T09:51:00.000' }, 'trades'),
    null,
    'an open row only exposes its open time — never a close time',
  )
})

test('resolveMtCloseTimeMs: ISO, epoch seconds and epoch milliseconds parse; zero or absent report null', () => {
  assert.equal(
    resolveMtCloseTimeMs({ closeTime: '2026-09-24T09:51:00.000' }, 'trades'),
    Date.parse('2026-09-24T09:51:00.000Z'),
    'a naive bridge timestamp is UTC, never the local zone',
  )
  assert.equal(
    resolveMtCloseTimeMs({ closeTime: '2026-09-24T09:51:00.000+02:00' }, 'trades'),
    Date.parse('2026-09-24T09:51:00.000+02:00'),
    'an explicit offset is respected as-is',
  )
  assert.equal(
    resolveMtCloseTimeMs({ closeTime: '2026-09-24 09:51:00 ' }, 'trades'),
    Date.parse('2026-09-24T09:51:00Z'),
    'a space-separated, padded naive timestamp is UTC too',
  )
  assert.equal(resolveMtCloseTimeMs({ closeTime: 1758717060 }, 'trades'), 1758717060000)
  assert.equal(resolveMtCloseTimeMs({ closeTime: 1758717060000 }, 'trades'), 1758717060000)
  assert.equal(resolveMtCloseTimeMs({ closeTime: 0 }, 'trades'), null, 'epoch-0 is "never closed"')
  assert.equal(resolveMtCloseTimeMs({}, 'trades'), null)
})

test('resolveMtCloseTimeMs: an unusable key does not shadow a later usable one', () => {
  // First key present is 0 / empty — the value the dashboard would also
  // skip — so the next key in the list must be the one that answers.
  assert.equal(
    resolveMtCloseTimeMs({ closeTime: 0, time_done: '2026-09-24T09:51:00.000' }, 'trades'),
    Date.parse('2026-09-24T09:51:00.000Z'),
    'a zero closeTime falls through to time_done',
  )
  assert.equal(
    resolveMtCloseTimeMs({ CloseTime: '', close_time: 1758717060 }, 'trades'),
    1758717060000,
    'an empty CloseTime falls through to close_time',
  )
  assert.equal(
    resolveMtCloseTimeMs({ closeTime: 'nope', close_time: 0 }, 'trades'),
    null,
    'every key unusable still reports null',
  )
})

test('resolveMtStoredProfit: prefers netProfit, then the deal profit', () => {
  assert.equal(resolveMtStoredProfit({ netProfit: 7.5, profit: 6 }, 'trades'), 7.5)
  assert.equal(resolveMtStoredProfit({ NetProfit: -3.2 }, 'trades'), -3.2)
  assert.equal(resolveMtStoredProfit({ profit: 6 }, 'trades'), 6)
  assert.equal(resolveMtStoredProfit({ Profit: -1.25 }, 'trades'), -1.25)
  assert.equal(resolveMtStoredProfit({}, 'trades'), null)
})

test('resolveMtStoredProfit: only sources describing this close are trusted', () => {
  assert.equal(resolveMtStoredProfit({ netProfit: -4.5 }, 'trades'), -4.5)
  assert.equal(resolveMtStoredProfit({ dealInternalOut: { netProfit: -4.5 } }, 'trades'), -4.5)
  assert.equal(resolveMtStoredProfit({ result: { netProfit: 1.5 } }, 'trades'), 1.5)
  assert.equal(
    resolveMtStoredProfit({ dealInternalIn: { netProfit: -99 }, profit: -4 }, 'trades'),
    -4,
    'an entry-side netProfit must not override the closing deal profit',
  )
  assert.equal(
    resolveMtStoredProfit({ dealInternalIn: { netProfit: -99 } }, 'trades'),
    null,
    'with nothing else to read the entry-side value is discarded, not stored',
  )
})

test('extractClosedTradeFillsByTicket: indexes rows by ticket and skips unusable rows', () => {
  const fills = extractClosedTradeFillsByTicket(
    [
      closedMtRow({ ticket: 101, closePrice: 1.1001 }),
      closedMtRow({ ticket: 102, closePrice: 1.1002, profit: 5 }),
      closedMtRow({ ticket: 103 }), // neither value
      closedMtRow({ closePrice: 1.1004 }), // no ticket
      closedMtRow({ ticket: 104, closePrice: 0 }), // zero price is not a fill, no profit
      null,
      'garbage',
    ],
    'trades',
  )
  assert.deepEqual(fills.get(101), { closePrice: 1.1001, profit: null })
  assert.deepEqual(fills.get(102), { closePrice: 1.1002, profit: 5 })
  assert.equal(fills.size, 2)
})

test('extractClosedTradeFillsByTicket: a later row with only one value never erases an earlier one', () => {
  const withPrice = closedMtRow({ ticket: 4001, closePrice: 1.105 })
  const withProfit = closedMtRow({ ticket: 4001, profit: 5.25 })
  const expected = { closePrice: 1.105, profit: 5.25 }
  assert.deepEqual(extractClosedTradeFillsByTicket([withPrice, withProfit], 'trades').get(4001), expected)
  assert.deepEqual(
    extractClosedTradeFillsByTicket([withProfit, withPrice], 'trades').get(4001),
    expected,
    'order must not matter — a clobber would strand the trade as unfillable',
  )
})

test('extractClosedTradeFillsByTicket: reads nested deal rows after flattening', () => {
  const fills = extractClosedTradeFillsByTicket(
    [closedMtRow({ dealInternalOut: { ticket: 205, closePrice: 1742.55, netProfit: -4.5 } })],
    'trades',
  )
  assert.deepEqual(fills.get(205), { closePrice: 1742.55, profit: -4.5 })
})

test('extractClosedTradeFillsByTicket: a profit with no price still yields a fill', () => {
  const fills = extractClosedTradeFillsByTicket(
    [closedMtRow({ ticket: 210, profit: 12.5 })],
    'trades',
  )
  assert.deepEqual(fills.get(210), { closePrice: null, profit: 12.5 })
})

test('extractClosedTradeFillsByTicket: a zero profit is a real fill, not a missing value', () => {
  const fills = extractClosedTradeFillsByTicket(
    [closedMtRow({ ticket: 211, profit: 0 })],
    'trades',
  )
  assert.deepEqual(fills.get(211), { closePrice: null, profit: 0 })
})

test('mtCloseRowRejection: only what the dashboard would count as a closed leg qualifies', () => {
  assert.equal(mtCloseRowRejection(closedMtRow(), 'trades'), null)
  assert.equal(mtCloseRowRejection(closedMtRow({ closeTime: undefined }), 'trades'), 'no-close-time')
  assert.equal(mtCloseRowRejection(closedMtRow({ closeTime: 0 }), 'trades'), 'no-close-time')
  assert.equal(mtCloseRowRejection(closedMtRow({ state: 'Cancelled' }), 'trades'), 'state')
  assert.equal(mtCloseRowRejection(closedMtRow({ state: 'Placed' }), 'trades'), 'state')
  assert.equal(mtCloseRowRejection(closedMtRow({ lots: 0 }), 'trades'), 'lots')
  assert.equal(mtCloseRowRejection(closedMtRow({ symbol: '  ' }), 'trades'), 'symbol')
  assert.equal(mtCloseRowRejection(closedMtRow({ orderType: 'Balance' }), 'trades'), 'non-trade')
})

test('mtCloseRowRejection: values on a nested deal object are seen, as the dashboard sees them', () => {
  assert.equal(
    mtCloseRowRejection(
      closedMtRow({ state: undefined, dealInternalOut: { state: 'Cancelled' } }),
      'trades',
    ),
    'state',
    'a nested Cancelled must not slip through just because it is not top-level',
  )
  assert.equal(
    mtCloseRowRejection(closedMtRow({ symbol: undefined, dealInternalOut: { symbol: 'XAUUSDm' } }), 'trades'),
    null,
    'a nested symbol is still a symbol',
  )
})

test('extractClosedTradeFillsByTicket (mtapi): open echoes, cancelled pendings and balance rows contribute nothing', () => {
  const fills = extractClosedTradeFillsByTicket(
    [
      closedMtRow({ ticket: 5001, closeTime: undefined, closePrice: 1.101, profit: 3 }),
      closedMtRow({ ticket: 5002, state: 'Cancelled', closePrice: 1.101, profit: 3 }),
      closedMtRow({ ticket: 5003, lots: 0, symbol: '', orderType: 'Balance', profit: 5000 }),
    ],
    'trades',
  )
  assert.equal(fills.size, 0)
})

test('planClosedTradeUpdates: matches by broker ticket, omits absent fields, leaves the rest unmatched', () => {
  const trades: ClosedTradeFillRow[] = [
    row('t1', '101'),
    row('t2', '999'),
    row('t3', null),
    row('t4', 'not-a-ticket'),
    row('t5', '102'),
  ]
  const fills = new Map<number, ClosedTradeFill>([
    [101, { closePrice: 1.1001, profit: 2.5 }],
    [102, { closePrice: null, profit: -3 }],
  ])
  const updates = planClosedTradeUpdates(trades, fills)
  assert.deepEqual(updates, [
    { id: 't1', close_price: 1.1001, profit: 2.5 },
    { id: 't5', profit: -3 },
  ])
})

test('planClosedTradeUpdates: a column already stored is never rewritten', () => {
  const fills = new Map<number, ClosedTradeFill>([[101, { closePrice: 1.1001, profit: 2.5 }]])
  assert.deepEqual(
    planClosedTradeUpdates([row('t1', '101', { close_price: 1.1099 })], fills),
    [{ id: 't1', profit: 2.5 }],
    'a value another writer stored wins over ours',
  )
  assert.deepEqual(
    planClosedTradeUpdates([row('t2', '101', { profit: 9 })], fills),
    [{ id: 't2', close_price: 1.1001 }],
  )
})

test('planClosedTradeUpdates: empty or all-null fills produce no updates (rows stay null for retry)', () => {
  const trades: ClosedTradeFillRow[] = [row('t1', '101')]
  assert.deepEqual(planClosedTradeUpdates(trades, new Map()), [])
  assert.deepEqual(
    planClosedTradeUpdates(trades, new Map([[101, { closePrice: null, profit: null }]])),
    [],
  )
})

test('stillMissingFill: true only when a stored column has no update value', () => {
  const bothNull = row('t1', '101')
  assert.equal(stillMissingFill(bothNull, undefined), true)
  assert.equal(stillMissingFill(bothNull, { id: 't1', close_price: 1.1 }), true, 'profit still null')
  assert.equal(stillMissingFill(bothNull, { id: 't1', profit: 2 }), true, 'close_price still null')
  assert.equal(stillMissingFill(bothNull, { id: 't1', close_price: 1.1, profit: 2 }), false)

  const priced = row('t1', '101', { close_price: 1.1 })
  assert.equal(stillMissingFill(priced, { id: 't1', profit: 2 }), false)
  assert.equal(stillMissingFill(priced, undefined), true)
})

test('FillAttempts: a row is dropped after repeated misses and forgotten on a hit', () => {
  const rows = [row('t1', '1'), row('t2', '2')]
  const attempts = new FillAttempts(2)
  assert.equal(attempts.pending(rows).length, 2)

  attempts.miss('t1')
  assert.equal(attempts.pending(rows).length, 2, 'two misses are not yet enough')
  attempts.miss('t1')
  assert.equal(attempts.pending(rows).length, 1, 'the row stops being batched')
  assert.equal(attempts.pending(rows)[0]?.id, 't2')

  attempts.hit('t1')
  assert.equal(attempts.pending(rows).length, 2, 'progress forgets the row')

  attempts.miss('t1')
  attempts.miss('t1')
  attempts.miss('t2')
  attempts.miss('t2')
  assert.equal(attempts.pending(rows).length, 0)
})

test('FillAttempts: the ledger is bounded — it resets instead of growing forever', () => {
  const attempts = new FillAttempts(3, 2)
  attempts.miss('x')
  attempts.miss('y')
  attempts.miss('z')
  assert.equal(attempts.tracked, 0, 'overflow clears the ledger so every row gets retried')
})

test('historyWindow: three days before the earliest close to three days past the latest close, naive ISO bounds', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  const trades: ClosedTradeFillRow[] = [
    row('t1', '1', { closed_at: '2026-09-10T08:00:00.000Z' }),
    row('t2', '2', { closed_at: '2026-06-01T00:00:00.000Z' }),
    row('t3', '3'),
  ]
  const window = historyWindow(trades, now)
  assert.equal(window.from, '2026-05-29T00:00:00')
  assert.equal(window.to, '2026-09-13T08:00:00')
  assert.ok(!window.from.includes('Z'), 'from must be naive, not RFC3339 with Z')
  assert.ok(!window.to.includes('.'), 'to must have no fractional seconds')
})

test('historyWindow: empty batch covers the last three days', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  const window = historyWindow([], now)
  assert.equal(window.from, '2026-09-22T12:00:00')
  assert.equal(window.to, '2026-09-28T12:00:00')
})

test('historyWindow: batch with only unparsable close times falls back to now', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  const window = historyWindow([row('t1', '1', { closed_at: 'not-a-date' })], now)
  assert.equal(window.from, '2026-09-22T12:00:00')
  assert.equal(window.to, '2026-09-28T12:00:00')
})

// FxSocket OrderHistory rows are deal-level (probe-verified against a live
// response): `position` is the id the trades table stores, `price` carries
// the fill, `entry: "Out"` marks closes.
test('extractClosedTradeFillsByTicket (fxsocket): keys the position id and reads profit from a closing deal', () => {
  const fills = extractClosedTradeFillsByTicket(
    [
      {
        ticket: 2694451250, // deal ticket — must NOT be the key
        order: 0,
        position: 3249434704,
        entry: 'Out',
        symbol: 'XAUUSDm',
        type: 'Sell',
        volume: 0.01,
        price: 4255.57,
        profit: -26.27,
        time: '2026-09-18T13:53:56.000Z',
      },
    ],
    'trades',
    'fxsocket',
  )
  assert.deepEqual(fills.get(3249434704), { closePrice: 4255.57, profit: -26.27 })
  assert.equal(fills.has(2694451250), false, 'deal ticket must not be keyed')
})

test('extractClosedTradeFillsByTicket (fxsocket): open deals and balance rows never contribute', () => {
  const fills = extractClosedTradeFillsByTicket(
    [
      { ticket: 2692983348, order: 3249434704, position: 3249434704, entry: 'In', price: 4370.1, profit: 0, time: '2026-09-18T09:51:47.000Z' },
      { ticket: 700001, order: 0, entry: 'Balance', price: 100, profit: 50, time: '2026-09-18T10:00:00.000Z' }, // no position
      { ticket: 700002, order: 0, position: 3249999999, entry: 'Out', time: '2026-09-18T11:00:00.000Z' }, // no price, no profit
      { ticket: 700003, order: 0, position: 3249999998, entry: 'Out', price: 0, time: '2026-09-18T11:00:00.000Z' }, // zero price, no profit
    ],
    'trades',
    'fxsocket',
  )
  assert.equal(fills.size, 0)
})

test('extractClosedTradeFillsByTicket (fxsocket): the final close deal beats partial closes, in either order', () => {
  const partial = { ticket: 2693017040, order: 3249470795, position: 3249434704, entry: 'Out', price: 4310.5, profit: 10, time: '2026-09-18T10:00:30.000Z' }
  const partial2 = { ticket: 2693064531, order: 3249522050, position: 3249434704, entry: 'Out', price: 4290.25, profit: 20, time: '2026-09-18T10:13:56.000Z' }
  const final = { ticket: 2694451250, order: 0, position: 3249434704, entry: 'Out', price: 4255.57, profit: -26.27, time: '2026-09-18T13:53:56.000Z' }

  const forward = extractClosedTradeFillsByTicket([partial, partial2, final], 'trades', 'fxsocket')
  assert.deepEqual(forward.get(3249434704), { closePrice: 4255.57, profit: -26.27 })

  const reversed = extractClosedTradeFillsByTicket([final, partial2, partial], 'trades', 'fxsocket')
  assert.deepEqual(reversed.get(3249434704), { closePrice: 4255.57, profit: -26.27 }, 'a final deal must never be overwritten by an older partial')
})

test('extractClosedTradeFillsByTicket (fxsocket): partial closes never contribute, even alone', () => {
  const partial = { ticket: 2693017040, order: 3249470795, position: 3249434704, entry: 'Out', price: 4310.5, profit: 10, time: '2026-09-18T10:00:30.000Z' }
  const laterPartial = { ticket: 2693064531, order: 3249522050, position: 3249434704, entry: 'Out', price: 4290.25, profit: 20, time: '2026-09-18T10:13:56.000Z' }
  const fills = extractClosedTradeFillsByTicket([laterPartial, partial], 'trades', 'fxsocket')
  assert.equal(fills.size, 0, 'a batch without the closing deal stays null for retry, never a partial fill')
})

test('extractClosedTradeFillsByTicket (mtapi): explicit provider keeps the position-level ticket behavior', () => {
  const fills = extractClosedTradeFillsByTicket(
    [closedMtRow({ ticket: 3275713716, position_ticket: 2717757165, closePrice: 4255.565, profit: -12.5 })],
    'trades',
    'mtapi',
  )
  assert.deepEqual(fills.get(3275713716), { closePrice: 4255.565, profit: -12.5 })
  assert.equal(fills.has(2717757165), false)
})

test('resolveMtPositionTicket: FxSocket deal rows expose the position id', () => {
  assert.equal(
    resolveMtPositionTicket({ ticket: 2694451250, order: 0, position: 3249434704, entry: 'Out' }, 'trades'),
    3249434704,
  )
  assert.equal(
    resolveMtPositionTicket({ ticket: 2693017040, order: 3249470795, position: 3249434704, entry: 'Out' }, 'trades'),
    3249434704,
    'position must win over the partial-close order id',
  )
  assert.equal(resolveMtPositionTicket({ ticket: 700001, order: 0, entry: 'Balance' }, 'trades'), null)
})

test('nextClosedFillCursor: only a full batch with a non-null closed_at advances', () => {
  const full = [
    row('id-1', '1', { closed_at: '2026-09-25T10:00:00+00' }),
    row('id-2', '2', { closed_at: '2026-09-25T09:00:00+00' }),
    row('id-3', '3', { closed_at: '2026-09-25T09:00:00+00' }),
  ]
  assert.deepEqual(nextClosedFillCursor(full, 3), {
    closedAt: '2026-09-25T09:00:00+00',
    id: 'id-3',
  })
  assert.equal(nextClosedFillCursor(full.slice(0, 2), 3), null, 'short batch resets the cursor')
  assert.equal(nextClosedFillCursor([], 3), null, 'empty batch resets the cursor')
  assert.equal(
    nextClosedFillCursor([row('id-1', '1'), row('id-2', '2')], 2),
    null,
    'anchor needs a closed_at',
  )
})

test('missingFillFilter: no cursor selects either missing column', () => {
  assert.equal(missingFillFilter(), 'close_price.is.null,profit.is.null')
  assert.equal(missingFillFilter(null), 'close_price.is.null,profit.is.null')
})

test('missingFillFilter: cursor is ANDed into each missing-column branch', () => {
  const cursor = { closedAt: '2026-09-25T09:00:00+00', id: 'id-3' }
  assert.equal(
    missingFillFilter(cursor),
    'and(close_price.is.null,closed_at.lt.2026-09-25T09:00:00+00),' +
      'and(close_price.is.null,closed_at.eq.2026-09-25T09:00:00+00,id.lt.id-3),' +
      'and(profit.is.null,closed_at.lt.2026-09-25T09:00:00+00),' +
      'and(profit.is.null,closed_at.eq.2026-09-25T09:00:00+00,id.lt.id-3)',
  )
})

test('tallyBrokerBatch: every trade lands in one bucket, failed writes reported separately', () => {
  assert.deepEqual(
    tallyBrokerBatch(10, 7, 0),
    { filled: 7, pending: 3, errors: 0 },
    'trades with no history match or a partial fill stay pending',
  )
  assert.deepEqual(
    tallyBrokerBatch(10, 7, 2),
    { filled: 7, pending: 3, errors: 2 },
    'errors are a subset of pending, reported for visibility',
  )
  assert.deepEqual(
    tallyBrokerBatch(4, 0, 0),
    { filled: 0, pending: 4, errors: 0 },
    'no matches at all → the whole slice stays pending',
  )
  assert.deepEqual(
    tallyBrokerBatch(4, 9, 1),
    { filled: 4, pending: 0, errors: 1 },
    'a count larger than the slice is clamped',
  )
})

test('extractClosedTradeFillsByTicket: gate reasons are counted in the optional tally', () => {
  const rejections: Record<string, number> = {}
  const fills = extractClosedTradeFillsByTicket(
    [
      closedMtRow({ ticket: 6001, closeTime: undefined }), // open echo
      closedMtRow({ ticket: 6002, state: 'Cancelled' }),
      closedMtRow({ ticket: 6003, closeTime: undefined }), // same reason again
      closedMtRow({ ticket: 6004, closePrice: 1.1004 }), // qualifies
    ],
    'trades',
    'mtapi',
    rejections,
  )
  assert.deepEqual(rejections, { 'no-close-time': 2, state: 1 })
  assert.equal(fills.size, 1)
  assert.equal(fills.has(6004), true)
})

test('classifyFillOutcome: only a readable read may strike', () => {
  const trade = row('t1', '1')
  assert.equal(
    classifyFillOutcome(trade, undefined, false, true),
    'miss',
    'readable and nothing found → one strike',
  )
  assert.equal(
    classifyFillOutcome(trade, undefined, false, false),
    'retry',
    'unproven read (empty, truncated, out of range) must never cost a strike',
  )
})

test('classifyFillOutcome: a landed write is progress until the row leaves the filter', () => {
  const trade = row('t1', '1') // both columns null
  assert.equal(
    classifyFillOutcome(trade, { id: 't1', profit: 5 }, true, false),
    'hit',
    'a column landed even though close_price is still null → fresh budget, stays in the batch',
  )
  assert.equal(
    classifyFillOutcome(trade, { id: 't1', close_price: 1.1, profit: 5 }, true, true),
    'cleared',
    'nothing left to fill → counted as filled',
  )
  assert.equal(
    classifyFillOutcome(trade, { id: 't1', close_price: 1.1, profit: 5 }, true, false),
    'cleared',
    'a real write landed, so readability no longer matters',
  )
})

test('classifyFillOutcome: nothing written — a concurrent writer either finished the row or the strike still applies', () => {
  const trade = row('t1', '1')
  const partial = { id: 't1', profit: 5 } // close_price still null
  assert.equal(
    classifyFillOutcome(trade, partial, false, true),
    'miss',
    'guard matched nothing but the read was whole → strike',
  )
  assert.equal(
    classifyFillOutcome(trade, partial, false, false),
    'retry',
    'unproven read → no strike, no write',
  )
  const done = row('t1', '1', { close_price: 1.1, profit: 5 })
  assert.equal(
    classifyFillOutcome(done, partial, false, true),
    'cleared',
    'nothing left to fill → someone else finished it',
  )
})

test('historyCoverage: an empty or deadline-cut read speaks for nobody; a full read speaks for all', () => {
  const trade = row('t1', '1', { closed_at: '2026-10-01T14:00:00.000Z' })
  assert.equal(historyCoverage([])(trade), false, 'a 200-with-[] response proves nothing about any trade')
  assert.equal(historyCoverage([], { pageCapEngaged: true })(trade), false)
  assert.equal(historyCoverage([closedMtRow()], { deadlineHit: true })(trade), false, 'a cut walk reached no verdict')
  assert.equal(historyCoverage([closedMtRow()])(trade), true, 'a whole-window read covers the batch')
  assert.equal(
    historyCoverage([closedMtRow()], { deadlineHit: true, pageCapEngaged: true })(trade),
    false,
  )
})

test('historyCoverage: a capped read only speaks for trades closed a full day past the boundary', () => {
  const boundaryMs = Date.parse('2026-10-01T00:00:00.000Z')
  const covers = historyCoverage([{ closeTime: '2026-10-01T00:00:00.000Z' }], { pageCapEngaged: true })

  // Fill at 2026-09-30T18:00Z (below the boundary → in the unread region),
  // DB closed_at 2026-10-01T14:00Z (lag 20 h, inside the observed 22.3 h).
  // The fill was never read, so this trade must NOT be struck.
  const unread = row('tx', '1', { closed_at: '2026-10-01T14:00:00.000Z' })
  assert.equal(
    covers(unread),
    false,
    'a trade whose bridge fill may sit in the unread region must never be struck',
  )

  const justInside = row('ti', '2', {
    closed_at: new Date(boundaryMs + COVERAGE_MARGIN_MS).toISOString(),
  })
  assert.equal(
    covers(justInside),
    true,
    'closed_at >= boundary + 24h guarantees the fill was inside the fetched pages',
  )

  const underFloor = row('tb', '3', {
    closed_at: new Date(boundaryMs + COVERAGE_MARGIN_MS - 1).toISOString(),
  })
  assert.equal(covers(underFloor), false, 'the band below the floor is deliberately never struck')

  assert.equal(
    covers(row('tn', '4', { closed_at: null })),
    false,
    'no close time → no verdict, never a strike',
  )
})

test('historyCoverage: capped reads with no usable boundary cover nobody', () => {
  const trade = row('t1', '1', { closed_at: '2026-10-01T14:00:00.000Z' })
  const junk = [null, 'not-an-object', { ticket: 1 }, { closeTime: 0 }, { closeTime: '' }]
  assert.equal(
    historyCoverage(junk, { pageCapEngaged: true })(trade),
    false,
    'no parseable close time among fetched rows → the boundary is unknown',
  )
  assert.equal(
    historyCoverage(junk, { pageCapEngaged: false })(trade),
    true,
    'without the cap there is no unread region to worry about',
  )
})

test('FillAttempts: uncovered reads age out on their own, far larger budget', () => {
  const attempts = new FillAttempts(2, 5_000, 3)
  const trade = row('t1', '1')
  attempts.uncovered('t1')
  attempts.uncovered('t1')
  assert.equal(attempts.pending([trade]).length, 1, 'uncoveredLimit=3: two ticks are not enough')
  attempts.uncovered('t1')
  assert.equal(attempts.pending([trade]).length, 0, 'the third exceeds the uncovered budget')

  attempts.hit('t1')
  assert.equal(attempts.pending([trade]).length, 1, 'progress resets both budgets')
  assert.equal(attempts.tracked, 0)
})
