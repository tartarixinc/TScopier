import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { classifyOpenTrade, historyTicketCloseMatch } from './openTradeClassification'

const trade = (over: Partial<Parameters<typeof classifyOpenTrade>[0]['trade']> = {}) => ({
  id: 'trade-1',
  signal_id: 'abcd1234-0000-0000-0000-000000000000',
  broker_account_id: 'acct-1',
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

test('an unhealthy broker read is never classified (unknown)', () => {
  const r = classifyOpenTrade({ trade: trade(), openedOrders: [], closedOrders: [], openedHealthy: false })
  assert.equal(r.status, 'unknown')
})

test('exact stored ticket resolves as live', () => {
  const r = classifyOpenTrade({
    trade: trade({ metaapi_order_id: '111' }),
    openedOrders: [liveRow(111)],
    closedOrders: [],
    openedHealthy: true,
  })
  assert.equal(r.status, 'live')
  if (r.status === 'live') assert.equal(r.matchedBy, 'canonical_ticket')
})

test('multiple identical positions classify as ambiguous, not missing', () => {
  const r = classifyOpenTrade({
    trade: trade({ metaapi_order_id: '999' }),
    openedOrders: [liveRow(222), liveRow(333)],
    closedOrders: [],
    openedHealthy: true,
  })
  assert.equal(r.status, 'ambiguous')
})

test('a not-live trade found in history by ticket is closed', () => {
  const r = classifyOpenTrade({
    trade: trade({ metaapi_order_id: '555' }),
    openedOrders: [],
    closedOrders: [{ ticket: 555, closePrice: 4160, closeTime: 1_760_000_000 }],
    openedHealthy: true,
  })
  assert.equal(r.status, 'closed')
  if (r.status === 'closed') {
    assert.equal(r.matchedBy, 'ticket')
    assert.equal(r.closePrice, 4160)
  }
})

test('a not-live trade found in history by signal comment is closed', () => {
  const r = classifyOpenTrade({
    trade: trade({ metaapi_order_id: '555' }),
    openedOrders: [],
    closedOrders: [{ ticket: 7777, comment: 'TScopier:GoldSignals:abcd1234' }],
    openedHealthy: true,
  })
  assert.equal(r.status, 'closed')
  if (r.status === 'closed') assert.equal(r.matchedBy, 'comment')
})

test('neither live nor in history is missing (a data gap to escalate)', () => {
  const r = classifyOpenTrade({
    trade: trade({ metaapi_order_id: '555' }),
    openedOrders: [],
    closedOrders: [],
    openedHealthy: true,
  })
  assert.equal(r.status, 'missing')
})

// Terminal-cancel proof (partialTpMonitor). A leg may only be cancelled when
// THIS trade's ticket is gone from live positions AND history shows a real
// closing row for it — never on a comment match or an open-position echo.

const closedMtRow = (over: Record<string, unknown> = {}) => ({
  ticket: 111,
  symbol: 'XAUUSD.s',
  lots: 0.1,
  orderType: 'Buy',
  state: 'Started',
  openPrice: 4140,
  closeTime: '2026-10-05T20:29:50.987',
  closePrice: 4129.67,
  ...over,
})

test('historyTicketCloseMatch: a real MTAPI close row for our ticket proves closure', () => {
  assert.equal(historyTicketCloseMatch(trade(), [closedMtRow()]), true)
})

test('historyTicketCloseMatch: an open-position echo carries the ticket but proves nothing', () => {
  // MTAPI echoes open positions into OrderHistory — no close time.
  assert.equal(historyTicketCloseMatch(trade(), [closedMtRow({ closeTime: undefined, closePrice: undefined })]), false)
  assert.equal(historyTicketCloseMatch(trade(), [closedMtRow({ closeTime: null })]), false)
})

test('historyTicketCloseMatch: a sibling comment match is not proof for this ticket', () => {
  // First row matches by signal comment (what matchClosedHistory returns) but
  // belongs to another position — our own row comes later.
  const sibling = { ticket: 7777, comment: 'TScopier:GoldSignals:abcd1234', closeTime: '2026-10-05T17:15:28.735' }
  const ours = closedMtRow()
  assert.equal(historyTicketCloseMatch(trade(), [sibling, ours]), true, 'our own close row still found')
  assert.equal(historyTicketCloseMatch(trade(), [sibling]), false, 'sibling alone proves nothing')
})

test('historyTicketCloseMatch: an FxSocket closing deal counts, its opening deal does not', () => {
  const deal = (entry: string, over: Record<string, unknown> = {}) => ({
    ticket: 999, // deal ticket
    position: 111, // what trades.metaapi_order_id stores
    entry,
    order: 0,
    lots: 0.1,
    symbol: 'XAUUSD.s',
    price: 4129.67,
    profit: 6.42,
    time: '2026-10-05T20:29:50.987Z',
    ...over,
  })
  assert.equal(historyTicketCloseMatch(trade(), [deal('out')], 'fxsocket'), true)
  assert.equal(historyTicketCloseMatch(trade(), [deal('in')], 'fxsocket'), false)
  assert.equal(
    historyTicketCloseMatch(trade(), [deal('out')], 'mtapi'),
    false,
    'the wrong provider must fail closed, never prove closure',
  )
})

// Real FxSocket history shape (fixture copied from closedTradeFill.test.ts):
// history is deal-level, `ticket` is the DEAL ticket, `position` is what
// `trades.metaapi_order_id` stores. Without reading `position` the gate could
// never match on this provider, and without the `order === 0` rule a
// partial-close deal — which this very monitor creates — would count as proof.
const fxsocketTrade = { id: 't1', signal_id: 'abcd1234-0000-0000-0000-000000000000', metaapi_order_id: '3249434704', symbol: 'XAUUSDm', direction: 'sell', lot_size: 0.01, entry_price: 4255.57 }

test('historyTicketCloseMatch: FxSocket closing deal matched on `position`, not the deal ticket', () => {
  const finalClose = {
    ticket: 2694451250, // deal ticket — must NOT be the key
    order: 0,
    position: 3249434704,
    entry: 'Out',
    symbol: 'XAUUSDm',
    type: 'Sell',
    volume: 0.01,
    price: 4255.57,
    profit: -26.27,
    time: '2026-09-18T13:53:56.000Z', // real shape: deal rows carry `time`, never `closeTime`
  }
  assert.equal(historyTicketCloseMatch(fxsocketTrade, [finalClose], 'fxsocket'), true)
  // Opening deal of the same position proves nothing.
  assert.equal(
    historyTicketCloseMatch(fxsocketTrade, [{ ...finalClose, ticket: 999, entry: 'In', order: 555 }], 'fxsocket'),
    false,
  )
  // A partial-close deal (order !== 0) is NOT proof the position is gone.
  assert.equal(
    historyTicketCloseMatch(fxsocketTrade, [{ ...finalClose, order: 987654 }], 'fxsocket'),
    false,
  )
  // Deal ticket alone (no `position`) does not match what the trade stores.
  assert.equal(
    historyTicketCloseMatch(fxsocketTrade, [{ ...finalClose, position: undefined }], 'fxsocket'),
    false,
  )
  // Told the wrong provider: each branch only recognises its own row shape,
  // so it must fail closed rather than prove a live position closed.
  assert.equal(historyTicketCloseMatch(fxsocketTrade, [finalClose]), false)
  // MTAPI rows judged as FxSocket rows prove nothing either.
  assert.equal(historyTicketCloseMatch(trade(), [closedMtRow()], 'fxsocket'), false)
})

test('historyTicketCloseMatch: missing ticket in the row or in the trade proves nothing', () => {
  assert.equal(historyTicketCloseMatch(trade(), [{ closeTime: '2026-10-05T20:29:50.987' }]), false)
  assert.equal(historyTicketCloseMatch(trade({ metaapi_order_id: null }), [closedMtRow()]), false)
  assert.equal(historyTicketCloseMatch(trade(), []), false)
  assert.equal(historyTicketCloseMatch(trade(), [null, 'nonsense', [1, 2]]), false)
})
