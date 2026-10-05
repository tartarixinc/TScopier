import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { classifyOpenTrade } from './openTradeClassification'

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
