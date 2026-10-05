import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { reconcileUnknownSend, resolveUnknownSendFromOrders } from './reconcileUnknownSend'

const intent = (over: Partial<Parameters<typeof resolveUnknownSendFromOrders>[1]> = {}) => ({
  symbol: 'XAUUSD.s',
  operation: 'Buy',
  volume: 0.1,
  comment: 'TScopier:Gold:abcd1234',
  ...over,
})

test('adopts the single matching live position', () => {
  const r = resolveUnknownSendFromOrders([
    { ticket: 111, symbol: 'XAUUSD.s', operation: 'Buy', openPrice: 4140, stopLoss: 4130, lots: 0.1, comment: 'TScopier:Gold:abcd1234' },
    { ticket: 222, symbol: 'EURUSD', operation: 'Buy', lots: 0.1 },
  ], intent())
  assert.equal(r.status, 'adopted')
  if (r.status === 'adopted') {
    assert.equal(r.ticket, 111)
    assert.equal(r.openPrice, 4140)
    assert.equal(r.stopLoss, 4130)
  }
})

test('a market order with no match is absent (safe to resend)', () => {
  const r = resolveUnknownSendFromOrders([
    { ticket: 222, symbol: 'EURUSD', operation: 'Buy', lots: 0.1 },
  ], intent())
  assert.equal(r.status, 'absent')
})

test('a pending order with no match is inconclusive (never resend)', () => {
  const r = resolveUnknownSendFromOrders([], intent({ operation: 'BuyStop' }))
  assert.equal(r.status, 'inconclusive')
})

test('two identical matches are inconclusive', () => {
  const r = resolveUnknownSendFromOrders([
    { ticket: 111, symbol: 'XAUUSD.s', operation: 'Buy', lots: 0.1, comment: 'TScopier:Gold:abcd1234' },
    { ticket: 333, symbol: 'XAUUSD.s', operation: 'Buy', lots: 0.1, comment: 'TScopier:Gold:abcd1234' },
  ], intent())
  assert.equal(r.status, 'inconclusive')
})

test('direction mismatch is not adopted', () => {
  const r = resolveUnknownSendFromOrders([
    { ticket: 111, symbol: 'XAUUSD.s', operation: 'Sell', lots: 0.1, comment: 'TScopier:Gold:abcd1234' },
  ], intent())
  assert.equal(r.status, 'absent')
})

test('a non-list OpenedOrders response is inconclusive', () => {
  const r = resolveUnknownSendFromOrders('nope' as unknown as unknown[], intent())
  assert.equal(r.status, 'inconclusive')
})

test('reconcileUnknownSend treats a read failure as inconclusive', async () => {
  const api = { openedOrders: async () => { throw new Error('boom') } }
  const r = await reconcileUnknownSend(api as never, 'session', intent())
  assert.equal(r.status, 'inconclusive')
})

test('reconcileUnknownSend adopts from a live snapshot', async () => {
  const api = { openedOrders: async () => [
    { ticket: 111, symbol: 'XAUUSD.s', operation: 'Buy', lots: 0.1, comment: 'TScopier:Gold:abcd1234' },
  ] }
  const r = await reconcileUnknownSend(api as never, 'session', intent())
  assert.equal(r.status, 'adopted')
})
