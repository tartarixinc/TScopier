import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closePriceKeysetFilter,
  extractClosePricesByTicket,
  historyWindow,
  nextClosePriceCursor,
  planClosePriceUpdates,
  tallyBrokerBatch,
  type ClosedTradeClosePriceRow,
} from './closedTradeClosePrice'
import { resolveMtClosePrice, resolveMtPositionTicket } from './mtTradeFields'

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

test('extractClosePricesByTicket: indexes rows by ticket and skips unusable rows', () => {
  const prices = extractClosePricesByTicket(
    [
      { ticket: 101, closePrice: 1.1001 },
      { Ticket: 102, ClosePrice: 1.1002 },
      { ticket: 103 }, // no close price
      { closePrice: 1.1004 }, // no ticket
      { ticket: 104, closePrice: 0 }, // zero is not a fill price
      null,
      'garbage',
    ],
    'trades',
  )
  assert.equal(prices.get(101), 1.1001)
  assert.equal(prices.get(102), 1.1002)
  assert.equal(prices.size, 2)
})

test('extractClosePricesByTicket: reads nested deal rows after flattening', () => {
  const prices = extractClosePricesByTicket(
    [{ dealInternalOut: { ticket: 205, closePrice: 1742.55 } }],
    'trades',
  )
  assert.equal(prices.get(205), 1742.55)
})

test('planClosePriceUpdates: matches by broker ticket and leaves the rest unmatched', () => {
  const trades: ClosedTradeClosePriceRow[] = [
    { id: 't1', broker_account_id: 'b1', metaapi_order_id: '101', closed_at: null },
    { id: 't2', broker_account_id: 'b1', metaapi_order_id: '999', closed_at: null },
    { id: 't3', broker_account_id: 'b1', metaapi_order_id: null, closed_at: null },
    { id: 't4', broker_account_id: 'b1', metaapi_order_id: 'not-a-ticket', closed_at: null },
    { id: 't5', broker_account_id: 'b1', metaapi_order_id: '102', closed_at: null },
  ]
  const prices = new Map<number, number>([
    [101, 1.1001],
    [102, 1.1002],
  ])
  const updates = planClosePriceUpdates(trades, prices)
  assert.deepEqual(updates, [
    { id: 't1', close_price: 1.1001 },
    { id: 't5', close_price: 1.1002 },
  ])
})

test('planClosePriceUpdates: empty price map produces no updates (rows stay null for retry)', () => {
  const trades: ClosedTradeClosePriceRow[] = [
    { id: 't1', broker_account_id: 'b1', metaapi_order_id: '101', closed_at: null },
  ]
  assert.deepEqual(planClosePriceUpdates(trades, new Map()), [])
})

test('historyWindow: three days before the earliest close to three days past the latest close, naive ISO bounds', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  const trades: ClosedTradeClosePriceRow[] = [
    { id: 't1', broker_account_id: 'b1', metaapi_order_id: '1', closed_at: '2026-09-10T08:00:00.000Z' },
    { id: 't2', broker_account_id: 'b1', metaapi_order_id: '2', closed_at: '2026-06-01T00:00:00.000Z' },
    { id: 't3', broker_account_id: 'b1', metaapi_order_id: '3', closed_at: null },
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
  const window = historyWindow(
    [{ id: 't1', broker_account_id: 'b1', metaapi_order_id: '1', closed_at: 'not-a-date' }],
    now,
  )
  assert.equal(window.from, '2026-09-22T12:00:00')
  assert.equal(window.to, '2026-09-28T12:00:00')
})

// FxSocket OrderHistory rows are deal-level (probe capture,
// scratchpad-close-price-backfill-2026-09-26): `position` is the id the
// trades table stores, `price` carries the fill, `entry: "Out"` marks closes.
test('extractClosePricesByTicket (fxsocket): keys the position id from a closing deal', () => {
  const prices = extractClosePricesByTicket(
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
  assert.equal(prices.get(3249434704), 4255.57)
  assert.equal(prices.has(2694451250), false, 'deal ticket must not be keyed')
})

test('extractClosePricesByTicket (fxsocket): open deals and balance rows never contribute', () => {
  const prices = extractClosePricesByTicket(
    [
      { ticket: 2692983348, order: 3249434704, position: 3249434704, entry: 'In', price: 4370.1, time: '2026-09-18T09:51:47.000Z' },
      { ticket: 700001, order: 0, entry: 'Balance', price: 100, time: '2026-09-18T10:00:00.000Z' }, // no position
      { ticket: 700002, order: 0, position: 3249999999, entry: 'Out', time: '2026-09-18T11:00:00.000Z' }, // no price
      { ticket: 700003, order: 0, position: 3249999998, entry: 'Out', price: 0, time: '2026-09-18T11:00:00.000Z' }, // zero price
    ],
    'trades',
    'fxsocket',
  )
  assert.equal(prices.size, 0)
})

test('extractClosePricesByTicket (fxsocket): the final close deal beats partial closes, in either order', () => {
  const partial = { ticket: 2693017040, order: 3249470795, position: 3249434704, entry: 'Out', price: 4310.5, time: '2026-09-18T10:00:30.000Z' }
  const partial2 = { ticket: 2693064531, order: 3249522050, position: 3249434704, entry: 'Out', price: 4290.25, time: '2026-09-18T10:13:56.000Z' }
  const final = { ticket: 2694451250, order: 0, position: 3249434704, entry: 'Out', price: 4255.57, time: '2026-09-18T13:53:56.000Z' }

  const forward = extractClosePricesByTicket([partial, partial2, final], 'trades', 'fxsocket')
  assert.equal(forward.get(3249434704), 4255.57)

  const reversed = extractClosePricesByTicket([final, partial2, partial], 'trades', 'fxsocket')
  assert.equal(reversed.get(3249434704), 4255.57, 'a final deal must never be overwritten by an older partial')
})

test('extractClosePricesByTicket (fxsocket): partial closes never contribute, even alone', () => {
  const partial = { ticket: 2693017040, order: 3249470795, position: 3249434704, entry: 'Out', price: 4310.5, time: '2026-09-18T10:00:30.000Z' }
  const laterPartial = { ticket: 2693064531, order: 3249522050, position: 3249434704, entry: 'Out', price: 4290.25, time: '2026-09-18T10:13:56.000Z' }
  const prices = extractClosePricesByTicket([laterPartial, partial], 'trades', 'fxsocket')
  assert.equal(prices.size, 0, 'a batch without the closing deal stays null for retry, never a partial fill')
})

test('extractClosePricesByTicket (mtapi): explicit provider keeps the position-level ticket behavior', () => {
  const prices = extractClosePricesByTicket(
    [{ ticket: 3275713716, position_ticket: 2717757165, closePrice: 4255.565 }],
    'trades',
    'mtapi',
  )
  assert.equal(prices.get(3275713716), 4255.565)
  assert.equal(prices.has(2717757165), false)
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

test('nextClosePriceCursor: only a full batch with a non-null closed_at advances', () => {
  const row = (i: number, closedAt: string | null): ClosedTradeClosePriceRow => ({
    id: `id-${i}`,
    broker_account_id: 'b1',
    metaapi_order_id: String(i),
    closed_at: closedAt,
  })
  const full = [row(1, '2026-09-25T10:00:00+00'), row(2, '2026-09-25T09:00:00+00'), row(3, '2026-09-25T09:00:00+00')]
  assert.deepEqual(nextClosePriceCursor(full, 3), { closedAt: '2026-09-25T09:00:00+00', id: 'id-3' })
  assert.equal(nextClosePriceCursor(full.slice(0, 2), 3), null, 'short batch resets the cursor')
  assert.equal(nextClosePriceCursor([], 3), null, 'empty batch resets the cursor')
  assert.equal(nextClosePriceCursor([row(1, null), row(2, null)], 2), null, 'anchor needs a closed_at')
})

test('closePriceKeysetFilter: strict compound keyset for (closed_at desc, id desc)', () => {
  assert.equal(
    closePriceKeysetFilter({ closedAt: '2026-09-25T09:00:00+00', id: 'id-3' }),
    'closed_at.lt.2026-09-25T09:00:00+00,and(closed_at.eq.2026-09-25T09:00:00+00,id.lt.id-3)',
  )
})

test('tallyBrokerBatch: unmatched = never-matched plus failed writes; only confirmed writes fill', () => {
  assert.deepEqual(
    tallyBrokerBatch(10, 7, 7, 0),
    { filled: 7, unmatched: 3 },
    'trades with no history match stay unmatched',
  )
  assert.deepEqual(
    tallyBrokerBatch(10, 7, 5, 2),
    { filled: 5, unmatched: 5 },
    'planned updates whose write failed count as unmatched, not filled',
  )
  assert.deepEqual(
    tallyBrokerBatch(4, 0, 0, 0),
    { filled: 0, unmatched: 4 },
    'no matches at all → the whole slice is unmatched',
  )
})
