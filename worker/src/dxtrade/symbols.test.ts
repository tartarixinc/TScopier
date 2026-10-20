import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DxtradeSizingError,
  actionOrderCode,
  commentFromOrderCode,
  entryOrderCode,
  formatNumber,
  isCopierOrderCode,
  lotsToUnits,
  matchInstrument,
  oppositeSide,
  orderTypeForOperation,
  protectionOrderCode,
  roundPrice,
  sideForOperation,
  ticketFromCode,
  unitsToLots,
  type DxtradeInstrument,
} from './symbols'

const EURUSD: DxtradeInstrument = { symbol: 'EUR/USD', lotSize: 100_000, quantityIncrement: 1_000, priceIncrement: 0.00001 }
const GOLD: DxtradeInstrument = { symbol: 'XAUUSD.m', lotSize: 100, quantityIncrement: 1, priceIncrement: 0.01 }

test('matchInstrument handles separators, exact names and short suffixes', () => {
  const list = [EURUSD, GOLD, { symbol: 'GBPUSD', lotSize: 1 }, { symbol: 'GBPUSD.pro', lotSize: 1 }]
  assert.equal(matchInstrument(list, 'EURUSD')?.symbol, 'EUR/USD')
  assert.equal(matchInstrument(list, 'XAUUSD')?.symbol, 'XAUUSD.m')
  assert.equal(matchInstrument(list, 'GBPUSD')?.symbol, 'GBPUSD')
  assert.equal(matchInstrument(list, 'USDJPY'), undefined)
  assert.equal(matchInstrument(list, ''), undefined)
})

test('lotsToUnits multiplies by lot size and floors to the quantity increment', () => {
  assert.equal(lotsToUnits(0.01, EURUSD), 1_000)
  assert.equal(lotsToUnits(0.015, EURUSD), 1_000)
  assert.equal(lotsToUnits(1.25, EURUSD), 125_000)
  assert.equal(lotsToUnits(0.5, GOLD), 50)
})

test('lotsToUnits rejects zero and sub-increment sizes', () => {
  assert.throws(() => lotsToUnits(0, EURUSD), DxtradeSizingError)
  assert.throws(() => lotsToUnits(0.0001, EURUSD), /needs at least 1000 units/)
})

test('unitsToLots inverts lotsToUnits', () => {
  assert.equal(unitsToLots(125_000, EURUSD), 1.25)
  assert.equal(unitsToLots(10, undefined), 10)
})

test('formatNumber never emits exponent notation', () => {
  assert.equal(formatNumber(1.5), '1.5')
  assert.equal(formatNumber(0.0000001), '0.0000001')
  assert.equal(formatNumber(Number.NaN), '0')
})

test('entry order codes are stable inside a two minute bucket and bounded', () => {
  const base = {
    comment: 'TScopier:gold-room:abcdef12-3456:1',
    symbol: 'EUR/USD',
    operation: 'Buy',
    units: 1_000,
    stopLoss: 1.08,
    takeProfit: 1.09,
    now: 1_790_000_000_000,
  }
  const a = entryOrderCode(base)
  assert.equal(a, entryOrderCode({ ...base, now: base.now + 30_000 }))
  assert.notEqual(a, entryOrderCode({ ...base, now: base.now + 5 * 60_000 }))
  assert.notEqual(a, entryOrderCode({ ...base, units: 2_000 }))
  assert.ok(a.length <= 60, a)
  assert.ok(isCopierOrderCode(a))
  assert.equal(protectionOrderCode(a, 'SL'), `${a}_SL`)
  assert.ok(protectionOrderCode(a, 'TP').length <= 64)
})

test('comments survive the round trip through an order code', () => {
  const code = entryOrderCode({
    comment: 'TScopier:gold-room:abcdef12-3456:1',
    symbol: 'EUR/USD',
    operation: 'Buy',
    units: 1_000,
    now: 1_790_000_000_000,
  })
  const comment = commentFromOrderCode(code)
  assert.match(comment, /^TScopier:/)
  assert.match(comment, /abcdef12/)
  assert.equal(commentFromOrderCode('manual-order-1'), '')
})

test('action order codes are unique per nonce and bounded', () => {
  const a = actionOrderCode('TSX', 42, 1_790_000_000_000, 'a')
  const b = actionOrderCode('TSX', 42, 1_790_000_000_000, 'b')
  assert.notEqual(a, b)
  assert.ok(a.length <= 64)
  assert.ok(a.startsWith('TSX_42_'))
})

test('ticketFromCode uses numeric codes directly and hashes the rest', () => {
  assert.equal(ticketFromCode('12345'), 12345)
  assert.equal(ticketFromCode(12345), 12345)
  const hashed = ticketFromCode('TSC_abc')
  assert.ok(Number.isInteger(hashed) && hashed > 0)
  assert.equal(hashed, ticketFromCode('TSC_abc'))
})

test('operation helpers', () => {
  assert.equal(sideForOperation('SellLimit'), 'SELL')
  assert.equal(sideForOperation('Buy'), 'BUY')
  assert.equal(orderTypeForOperation('BuyLimit'), 'LIMIT')
  assert.equal(orderTypeForOperation('SellStop'), 'STOP')
  assert.equal(orderTypeForOperation('Sell'), 'MARKET')
  assert.equal(oppositeSide('BUY'), 'SELL')
  assert.equal(oppositeSide('SELL'), 'BUY')
})

test('roundPrice snaps to the price increment', () => {
  assert.equal(roundPrice(1.234567, EURUSD), 1.23457)
  assert.equal(roundPrice(2345.678, GOLD), 2345.68)
  assert.equal(roundPrice(1.2345, undefined), 1.2345)
})
