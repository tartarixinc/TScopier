import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  brokerRowOpenedAt,
  buildAdoptInsertRow,
  classifyOrphanPosition,
  openRowsFromQuery,
  positionFromBrokerRow,
  uuidPrefixRange,
  type OrphanCandidate,
} from './orphanPositionMonitor'

function candidate(over: Partial<OrphanCandidate> = {}): OrphanCandidate {
  return {
    ticket: 3401234567,
    symbol: 'BTCUSDm',
    isBuy: true,
    lots: 0.01,
    comment: 'TScopier:TestSignal:4bfb255e',
    signalPrefix: '4bfb255e',
    openPrice: 80500,
    stopLoss: 79400,
    takeProfit: 83000,
    openedAt: '2026-10-25T00:00:00.000Z',
    ...over,
  }
}

const signal = (
  over: Partial<{ id: string; channel_id: string | null; symbol: string | null; action: string | null }> = {},
) => ({
  id: '4bfb255e-e17f-41f2-b8a2-9e068ff956fe',
  channel_id: '3b491a96-e822-4dcb-ac5e-3076b367a26c',
  symbol: 'BTCUSD',
  action: null,
  ...over,
})

// ---------------------------------------------------------------------------
// positionFromBrokerRow — only our commented positions become candidates
// ---------------------------------------------------------------------------

test('a TScopier-commented position row becomes a candidate with all numbers', () => {
  const row = {
    ticket: 404270084,
    symbol: 'BTCUSDm',
    type: 0,
    lots: 0.01,
    openPrice: 80486.4,
    stopLoss: 79400,
    takeProfit: 83000,
    comment: 'TScopier:TestSignal:4bfb255e:strictEntry',
    time: 1792700000,
  }
  const out = positionFromBrokerRow(row)
  assert.ok(out)
  assert.equal(out!.ticket, 404270084)
  assert.equal(out!.isBuy, true)
  assert.equal(out!.symbol, 'BTCUSDm')
  assert.equal(out!.signalPrefix, '4bfb255e')
  assert.equal(out!.openPrice, 80486.4)
  assert.equal(out!.stopLoss, 79400)
  assert.equal(out!.takeProfit, 83000)
})

test('foreign or missing comments are ignored', () => {
  assert.equal(positionFromBrokerRow({ ticket: 1, symbol: 'EURUSD', type: 0, lots: 0.1, comment: '' }), null)
  assert.equal(positionFromBrokerRow({ ticket: 1, symbol: 'EURUSD', type: 0, lots: 0.1, comment: 'user note' }), null)
  assert.equal(positionFromBrokerRow(null), null)
  assert.equal(positionFromBrokerRow('not an object'), null)
})

test('orphan adoption rejects malformed and non-positive MT broker tickets', () => {
  for (const ticket of ['NaN', 'Infinity', '0', '-1', '1.5', 0, -1, 1.5]) {
    assert.equal(positionFromBrokerRow({
      ticket,
      symbol: 'BTCUSDm',
      type: 0,
      lots: 0.01,
      comment: 'TScopier:TestSignal:4bfb255e',
    }), null, String(ticket))
  }
})

test('broker timestamps in seconds, milliseconds and garbage all resolve', () => {
  const sec = brokerRowOpenedAt({ time: 1792700000 })
  const ms = brokerRowOpenedAt({ openTime: 1792700000000 })
  assert.equal(sec, new Date(1792700000 * 1000).toISOString())
  assert.equal(ms, new Date(1792700000000).toISOString())
  assert.ok(Number.isFinite(Date.parse(brokerRowOpenedAt({}))))
  assert.ok(Number.isFinite(Date.parse(brokerRowOpenedAt({ time: -5 }))))
})

// ---------------------------------------------------------------------------
// classifyOrphanPosition — the decision table (a wrong insert is worse than
// a missed orphan)
// ---------------------------------------------------------------------------

test('a ticket already present in any trades row is tracked, full stop', () => {
  const d = classifyOrphanPosition({
    candidate: candidate(),
    trackedTickets: new Set([3401234567]),
    signals: [],
  })
  assert.deepEqual(d, { kind: 'tracked' })
})

test('exactly one compatible signal adopts', () => {
  const d = classifyOrphanPosition({
    candidate: candidate(),
    trackedTickets: new Set(),
    signals: [signal()],
  })
  assert.equal(d.kind, 'adopt')
  if (d.kind === 'adopt') {
    assert.equal(d.signalId, '4bfb255e-e17f-41f2-b8a2-9e068ff956fe')
    assert.equal(d.channelId, '3b491a96-e822-4dcb-ac5e-3076b367a26c')
  }
})

test('no matching signal alerts instead of guessing', () => {
  const d = classifyOrphanPosition({ candidate: candidate(), trackedTickets: new Set(), signals: [] })
  assert.equal(d.kind, 'alert')
  if (d.kind === 'alert') assert.match(d.reason, /no signal matches/)
})

test('an ambiguous prefix (two signals) alerts instead of guessing', () => {
  const d = classifyOrphanPosition({
    candidate: candidate(),
    trackedTickets: new Set(),
    signals: [signal(), signal({ id: '4bfb255e-0000-0000-0000-000000000001' })],
  })
  assert.equal(d.kind, 'alert')
  if (d.kind === 'alert') assert.match(d.reason, /matches 2 signals/)
})

test('a symbol the signal never traded alerts', () => {
  const d = classifyOrphanPosition({
    candidate: candidate({ symbol: 'XAUUSDm' }),
    trackedTickets: new Set(),
    signals: [signal({ symbol: 'BTCUSD' })],
  })
  assert.equal(d.kind, 'alert')
  if (d.kind === 'alert') assert.match(d.reason, /not compatible/)
})

test('a signal without a symbol trusts the comment match', () => {
  const d = classifyOrphanPosition({
    candidate: candidate(),
    trackedTickets: new Set(),
    signals: [signal({ symbol: null })],
  })
  assert.equal(d.kind, 'adopt')
})

test('a row with no usable volume alerts (never a fabricated lot)', () => {
  const d = classifyOrphanPosition({
    candidate: candidate({ lots: 0 }),
    trackedTickets: new Set(),
    signals: [signal()],
  })
  assert.equal(d.kind, 'alert')
  if (d.kind === 'alert') assert.match(d.reason, /no usable volume/)
})

test('an indeterminate direction alerts instead of guessing a side', () => {
  const d = classifyOrphanPosition({
    candidate: candidate({ isBuy: null }),
    trackedTickets: new Set(),
    signals: [signal()],
  })
  assert.equal(d.kind, 'alert')
  if (d.kind === 'alert') assert.match(d.reason, /does not state a side/)
})

test('a position side that disagrees with the signal side alerts', () => {
  const d = classifyOrphanPosition({
    candidate: candidate({ isBuy: false }),
    trackedTickets: new Set(),
    signals: [signal({ action: 'buy' })],
  })
  assert.equal(d.kind, 'alert')
  if (d.kind === 'alert') assert.match(d.reason, /disagrees with signal side buy/)
})

test('an agreeing signal side adopts', () => {
  const d = classifyOrphanPosition({
    candidate: candidate({ isBuy: true }),
    trackedTickets: new Set(),
    signals: [signal({ action: 'buy' })],
  })
  assert.equal(d.kind, 'adopt')
  if (d.kind === 'adopt') assert.equal(d.signalSide, 'buy')
})

// ---------------------------------------------------------------------------
// Row shapes: pendings must never qualify; bridge word-side rows must.
// ---------------------------------------------------------------------------

test('a resting pending (BuyLimit / Placed) is never a candidate', () => {
  assert.equal(positionFromBrokerRow({
    ticket: 404111222,
    symbol: 'BTCUSDm',
    orderType: 'BuyLimit',
    state: 'Placed',
    lots: 0.01,
    openPrice: 78000,
    comment: 'TScopier:TestSignal:4bfb255e:strictEntry',
  }), null)
  assert.equal(positionFromBrokerRow({
    ticket: 404111333,
    symbol: 'BTCUSDm',
    type: 2, // numeric pending kind
    lots: 0.01,
    comment: 'TScopier:TestSignal:4bfb255e:rg1.tp1',
  }), null)
})

test('a filled MTAPI bridge row (word side) reads as a buy', () => {
  const out = positionFromBrokerRow({
    ticket: 3401998877,
    orderType: 'Buy',
    state: 'Filled',
    symbol: 'BTCUSDm',
    lots: 0.01,
    openPrice: 80500,
    comment: 'TScopier:TestSignal:4bfb255e',
  })
  assert.ok(out)
  assert.equal(out!.isBuy, true, 'word side must not collapse to sell')
  assert.equal(out!.lots, 0.01)
})

test('a sell bridge row reads as a sell', () => {
  const out = positionFromBrokerRow({
    ticket: 3401998878,
    orderType: 'Sell',
    state: 'Filled',
    symbol: 'BTCUSDm',
    lots: 0.02,
    comment: 'TScopier:TestSignal:4bfb255e',
  })
  assert.equal(out!.isBuy, false)
})

test('string broker dates are parsed, not replaced with now', () => {
  const iso = brokerRowOpenedAt({ time: '2026.10.25 10:33:00' })
  assert.ok(Number.isFinite(Date.parse(iso)))
  assert.equal(iso, new Date(Date.parse('2026-10-25 10:33:00')).toISOString())
})

// ---------------------------------------------------------------------------
// UUID prefix range (the signals lookup — `LIKE` on uuid raises 42883).
// ---------------------------------------------------------------------------

test('uuidPrefixRange brackets exactly the prefix range', () => {
  const r = uuidPrefixRange('4bfb255e')
  assert.deepEqual(r, {
    gte: '4bfb255e-0000-0000-0000-000000000000',
    lt: '4bfb255f-0000-0000-0000-000000000000',
  })
  const carry = uuidPrefixRange('0000000f')
  assert.equal(carry!.lt, '00000010-0000-0000-0000-000000000000')
  const innerCarry = uuidPrefixRange('ffffff00')
  assert.equal(innerCarry!.lt, 'ffffff01-0000-0000-0000-000000000000')
})

test('uuidPrefixRange refuses non-hex and the top prefix', () => {
  assert.equal(uuidPrefixRange('nothex9'), null)
  assert.equal(uuidPrefixRange('4bf'), null)
  assert.equal(uuidPrefixRange('ffffffff'), null)
  assert.equal(uuidPrefixRange(''), null)
})

// ---------------------------------------------------------------------------
// The insert payload (pure — no guessing allowed in it either).
// ---------------------------------------------------------------------------

test('buildAdoptInsertRow copies broker numbers without fabricating anything', () => {
  const c = candidate({ isBuy: true, lots: 0.03, openPrice: 80555.5, stopLoss: 79000, takeProfit: 83000 })
  const row = buildAdoptInsertRow({
    userId: 'user-1',
    brokerAccountId: 'broker-1',
    candidate: c,
    decision: {
      kind: 'adopt',
      signalId: '4bfb255e-e17f-41f2-b8a2-9e068ff956fe',
      channelId: '3b491a96-e822-4dcb-ac5e-3076b367a26c',
      parsedSymbol: 'BTCUSD',
      signalSide: 'buy',
    },
  })
  assert.equal(row.direction, 'buy')
  assert.equal(row.lot_size, 0.03)
  assert.equal(row.entry_price, 80555.5)
  assert.equal(row.status, 'open')
  assert.equal(row.metaapi_order_id, '3401234567')
  assert.equal(row.broker_position_ticket, '3401234567')
  assert.equal(row.telegram_channel_id, '3b491a96-e822-4dcb-ac5e-3076b367a26c')
  assert.equal(row.user_id, 'user-1')
  assert.equal(row.signal_id, '4bfb255e-e17f-41f2-b8a2-9e068ff956fe')
})

test('buildAdoptInsertRow writes sell for a sell side', () => {
  const row = buildAdoptInsertRow({
    userId: 'user-1',
    brokerAccountId: 'broker-1',
    candidate: candidate({ isBuy: false, lots: 0.01 }),
    decision: { kind: 'adopt', signalId: 'x', channelId: null, parsedSymbol: null, signalSide: 'sell' },
  })
  assert.equal(row.direction, 'sell')
})

test('tracking is checked on either ticket column (metaapi_order_id side)', () => {
  const d = classifyOrphanPosition({
    candidate: candidate({ ticket: 404999111 }),
    trackedTickets: new Set([404999111]),
    signals: [signal()],
  })
  assert.deepEqual(d, { kind: 'tracked' })
})

// ---------------------------------------------------------------------------
// The fail-closed row contract: only a successful read may enable an insert.
// ---------------------------------------------------------------------------

test('openRowsFromQuery maps a successful read (rows or empty)', () => {
  assert.deepEqual(openRowsFromQuery([], null), [])
  const rows = [{ id: 'a', signal_id: 's', broker_account_id: 'b', metaapi_order_id: '1' }]
  assert.equal(openRowsFromQuery(rows, null), rows)
})

test('openRowsFromQuery returns null on a read error (fail closed)', () => {
  assert.equal(openRowsFromQuery(null, { message: 'boom' }), null)
  assert.equal(openRowsFromQuery([], { message: 'boom' }), null)
})
