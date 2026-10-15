import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  BybitSizingError,
  childOrderLinkId,
  commentFromOrderLinkId,
  copierOrderLinkId,
  floorToStep,
  formatPrice,
  formatQuantity,
  hashOrderId,
  parseInstruments,
  resolveBybitSymbol,
  sizeBybitPosition,
  ticketFromChildLinkId,
  ticketFromEntryLinkId,
  ticketToken,
  type BybitSymbolRules,
} from './symbols'

function row(symbol: string, extra: Record<string, unknown> = {}) {
  return {
    symbol,
    contractType: 'LinearPerpetual',
    status: 'Trading',
    settleCoin: 'USDT',
    priceFilter: { tickSize: '0.10' },
    lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '40', minNotionalValue: '5' },
    leverageFilter: { minLeverage: '1', maxLeverage: '100', leverageStep: '0.01' },
    ...extra,
  }
}

const symbols = parseInstruments({
  list: [
    row('BTCUSDT'),
    row('XAUUSDT'),
    row('BTCPERP', { settleCoin: 'USDC' }),
    row('BTC-26DEC25', { contractType: 'LinearFutures' }),
    row('HALTUSDT', { status: 'Settling' }),
  ],
})

test('parseInstruments reads steps, caps and leverage limits and merges pages', () => {
  const rules = symbols.get('BTCUSDT')!
  assert.equal(rules.tickSize, 0.1)
  assert.equal(rules.qtyStep, 0.001)
  assert.equal(rules.minQty, 0.001)
  assert.equal(rules.maxQty, 100)
  assert.equal(rules.maxMarketQty, 40)
  assert.equal(rules.minNotional, 5)
  assert.equal(rules.maxLeverage, 100)
  assert.equal(symbols.get('BTCPERP')!.settleCoin, 'USDC')
  const merged = parseInstruments({ list: [row('ETHUSDT')] }, symbols)
  assert.ok(merged.has('ETHUSDT') && merged.has('BTCUSDT'))
  assert.equal(parseInstruments(null).size, 0)
})

test('resolveBybitSymbol maps signal names to linear contracts', () => {
  assert.equal(resolveBybitSymbol('XAUUSD', symbols)?.symbol, 'XAUUSDT')
  assert.equal(resolveBybitSymbol('btc/usdt', symbols)?.symbol, 'BTCUSDT')
  assert.equal(resolveBybitSymbol('BTCUSDT.P', symbols)?.symbol, 'BTCUSDT')
  assert.equal(resolveBybitSymbol('BTC/USDC', symbols)?.symbol, 'BTCPERP')
  assert.equal(resolveBybitSymbol('BTC', symbols)?.symbol, 'BTCUSDT')
  assert.equal(resolveBybitSymbol('BTC-26DEC25', symbols)?.symbol, 'BTC-26DEC25', 'exact dated futures name wins')
  assert.equal(resolveBybitSymbol('HALTUSDT', symbols), null, 'non-trading contracts are skipped')
  assert.equal(resolveBybitSymbol('NOPE', symbols), null)
  assert.equal(resolveBybitSymbol('', symbols), null)
})

test('floorToStep rounds down without float drift', () => {
  assert.equal(floorToStep(0.0153846, 0.001), 0.015)
  assert.equal(floorToStep(0.3, 0.1), 0.3)
  assert.equal(floorToStep(1.005, 0.01), 1)
  assert.equal(floorToStep(0.0009, 0.001), 0)
  assert.equal(formatQuantity(0.5, { qtyStep: 0.001 }), '0.500')
  assert.equal(formatPrice(64_000.04, { tickSize: 0.1 }), '64000.0')
  assert.equal(formatPrice(2000.126, { tickSize: 0.01 }), '2000.13')
})

test('sizeBybitPosition computes margin x leverage / price and floors to the step', () => {
  const rules = symbols.get('BTCUSDT')!
  assert.equal(sizeBybitPosition({ marginUsdt: 100, leverage: 10, price: 65_000, rules }), 0.015)
})

test('sizeBybitPosition caps market orders at maxMktOrderQty and limit orders at maxOrderQty', () => {
  const rules = symbols.get('BTCUSDT')!
  assert.equal(sizeBybitPosition({ marginUsdt: 1e9, leverage: 10, price: 65_000, rules, kind: 'market' }), 40)
  assert.equal(sizeBybitPosition({ marginUsdt: 1e9, leverage: 10, price: 65_000, rules, kind: 'limit' }), 100)
})

test('sizeBybitPosition rejects leverage above the symbol max and sizes below the minimum', () => {
  const rules: BybitSymbolRules = symbols.get('BTCUSDT')!
  assert.throws(() => sizeBybitPosition({ marginUsdt: 100, leverage: 101, price: 65_000, rules }), BybitSizingError)
  assert.throws(() => sizeBybitPosition({ marginUsdt: 0.1, leverage: 1, price: 65_000, rules }), /below the Bybit minimum order/)
  assert.throws(() => sizeBybitPosition({ marginUsdt: 0, leverage: 1, price: 65_000, rules }), /margin is not set/)
  assert.throws(() => sizeBybitPosition({ marginUsdt: 100, leverage: 1, price: 0, rules }), /price .* unavailable/)
})

test('copierOrderLinkId encodes the signal tail in 36 safe characters and round-trips', () => {
  const ticket = 450_000_000_001
  const id = copierOrderLinkId('TScopier:44sClub:979b6ac0:rg5.tp1', ticket)
  assert.ok(id.length <= 36, id)
  assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.equal(id, `TScopier_979b6ac0_rg5-tp1_${ticketToken(ticket)}`)
  assert.equal(ticketFromEntryLinkId(id), ticket)
  assert.equal(commentFromOrderLinkId(id), 'TScopier:979b6ac0:rg5.tp1')
})

test('copierOrderLinkId truncates a long tail but keeps the ticket recoverable', () => {
  const ticket = 450_000_000_002
  const id = copierOrderLinkId('TScopier:chan:abcdef12:' + 'x'.repeat(60), ticket)
  assert.equal(id.length, 36)
  assert.equal(ticketFromEntryLinkId(id), ticket)
  assert.match(id, /^[A-Za-z0-9_-]+$/)
})

test('a comment without a signal id still yields a unique valid link id', () => {
  const ticket = 450_000_000_003
  const id = copierOrderLinkId('manual', ticket)
  assert.equal(id, `TScopier_${ticketToken(ticket)}`)
  assert.equal(ticketFromEntryLinkId(id), ticket)
  assert.equal(commentFromOrderLinkId(id), 'TScopier')
  assert.equal(copierOrderLinkId(undefined, ticket), id)
})

test('stop and close link ids carry the leg ticket', () => {
  const ticket = 450_000_000_004
  const sl = childOrderLinkId('TSL', ticket, 'a1b2')
  assert.equal(sl, `TSL_${ticket}_a1b2`)
  assert.ok(sl.length <= 36)
  assert.equal(ticketFromChildLinkId(sl, 'TSL'), ticket)
  assert.equal(ticketFromChildLinkId(sl, 'TST'), null)
  assert.equal(ticketFromEntryLinkId(sl), null)
})

test('hashOrderId maps UUID order ids to stable positive integers', () => {
  const a = hashOrderId('c6f055d9-7f21-4079-913d-e6523a9cfffa')
  assert.equal(a, hashOrderId('c6f055d9-7f21-4079-913d-e6523a9cfffa'))
  assert.ok(Number.isSafeInteger(a) && a > 0)
  assert.notEqual(a, hashOrderId('c6f055d9-7f21-4079-913d-e6523a9cfffb'))
})
