import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  KucoinSizingError,
  baseToLots,
  childOrderLinkId,
  copierOrderLinkId,
  formatPrice,
  lotsToBase,
  parseContracts,
  resolveKucoinSymbol,
  sizeKucoinPosition,
  ticketFromChildLinkId,
  ticketFromEntryLinkId,
  SL_PREFIX,
} from './symbols'

function row(symbol: string, extra: Record<string, unknown> = {}) {
  return {
    symbol,
    status: 'Open',
    baseCurrency: symbol.replace(/(USDT|USDC)M$/, ''),
    settleCurrency: 'USDT',
    multiplier: 0.001,
    lotSize: 1,
    tickSize: 0.1,
    maxOrderQty: 1_000_000,
    marketMaxOrderQty: 4000,
    maxLeverage: 100,
    isInverse: false,
    supportCross: true,
    ...extra,
  }
}

const contracts = parseContracts([
  row('XBTUSDTM', { baseCurrency: 'XBT' }),
  row('ETHUSDTM', { multiplier: 0.01, tickSize: 0.01 }),
  row('1000PEPEUSDTM', { multiplier: 1, tickSize: 0.000001 }),
  row('SOLUSDCM', { settleCurrency: 'USDC', multiplier: 0.1 }),
  row('XBTUSDM', { settleCurrency: 'USD', isInverse: true }),
  row('HALTUSDTM', { status: 'Paused' }),
])

test('parseContracts reads lot rules and ignores junk', () => {
  const btc = contracts.get('XBTUSDTM')!
  assert.equal(btc.multiplier, 0.001)
  assert.equal(btc.lotSize, 1)
  assert.equal(btc.maxMarketQty, 4000)
  assert.equal(btc.maxLeverage, 100)
  assert.equal(parseContracts(null).size, 0)
  assert.equal(parseContracts([null, 3, {}]).size, 0)
})

test('resolveKucoinSymbol maps signal names to linear contracts', () => {
  assert.equal(resolveKucoinSymbol('BTCUSDT', contracts)?.symbol, 'XBTUSDTM')
  assert.equal(resolveKucoinSymbol('BTC/USDT', contracts)?.symbol, 'XBTUSDTM')
  assert.equal(resolveKucoinSymbol('btcusdt.p', contracts)?.symbol, 'XBTUSDTM')
  assert.equal(resolveKucoinSymbol('XBTUSDTM', contracts)?.symbol, 'XBTUSDTM')
  assert.equal(resolveKucoinSymbol('ETHUSD', contracts)?.symbol, 'ETHUSDTM')
  assert.equal(resolveKucoinSymbol('PEPEUSDT', contracts)?.symbol, '1000PEPEUSDTM')
  assert.equal(resolveKucoinSymbol('SOLUSDC', contracts)?.symbol, 'SOLUSDCM')
})

test('resolveKucoinSymbol skips inverse, paused and unknown contracts', () => {
  assert.equal(resolveKucoinSymbol('XBTUSDM', contracts), null)
  assert.equal(resolveKucoinSymbol('HALTUSDT', contracts), null)
  assert.equal(resolveKucoinSymbol('NOPEUSDT', contracts), null)
  assert.equal(resolveKucoinSymbol('', contracts), null)
})

test('formatPrice rounds to the tick and keeps its decimals', () => {
  assert.equal(formatPrice(65000.07, { tickSize: 0.1 }), '65000.1')
  assert.equal(formatPrice(65000, { tickSize: 0.1 }), '65000.0')
  assert.equal(formatPrice(0.0123456, { tickSize: 0.000001 }), '0.012346')
  assert.equal(formatPrice(12.3, { tickSize: 1 }), '12')
})

test('lots and base units convert without float noise', () => {
  assert.equal(lotsToBase(15, { multiplier: 0.001 }), 0.015)
  assert.equal(lotsToBase(3, { multiplier: 0.1 }), 0.3)
  assert.equal(baseToLots(0.015, { multiplier: 0.001 }), 15)
  assert.equal(baseToLots(0.3, { multiplier: 0.1 }), 3)
})

test('sizeKucoinPosition floors margin x leverage / price / multiplier to whole lots', () => {
  const btc = contracts.get('XBTUSDTM')!
  // 100 x 10 = 1000 USDT / 65000 = 0.01538 BTC = 15.38 lots
  assert.equal(sizeKucoinPosition({ marginUsdt: 100, leverage: 10, price: 65_000, contract: btc }), 15)
  const pepe = contracts.get('1000PEPEUSDTM')!
  assert.equal(sizeKucoinPosition({ marginUsdt: 100, leverage: 10, price: 0.02, contract: pepe }), 4000)
  assert.equal(sizeKucoinPosition({ marginUsdt: 10, leverage: 10, price: 0.02, contract: pepe }), 4000)
  assert.equal(sizeKucoinPosition({ marginUsdt: 1, leverage: 10, price: 0.02, contract: pepe }), 500)
})

test('sizeKucoinPosition caps market orders at the market maximum and limits at the limit maximum', () => {
  const btc = contracts.get('XBTUSDTM')!
  assert.equal(sizeKucoinPosition({ marginUsdt: 1_000_000, leverage: 100, price: 1000, contract: btc }), 4000)
  assert.equal(
    sizeKucoinPosition({ marginUsdt: 1_000_000, leverage: 100, price: 1000, contract: btc, kind: 'limit' }),
    1_000_000,
  )
})

test('sizeKucoinPosition rejects bad inputs with a clear message', () => {
  const btc = contracts.get('XBTUSDTM')!
  assert.throws(() => sizeKucoinPosition({ marginUsdt: 1, leverage: 1, price: 65_000, contract: btc }), (error: unknown) => {
    assert.ok(error instanceof KucoinSizingError)
    assert.match((error as Error).message, /below one XBTUSDTM lot/)
    return true
  })
  assert.throws(() => sizeKucoinPosition({ marginUsdt: 100, leverage: 200, price: 65_000, contract: btc }), /above the KuCoin maximum of 100x/)
  assert.throws(() => sizeKucoinPosition({ marginUsdt: 0, leverage: 10, price: 65_000, contract: btc }), /margin is not set/)
  assert.throws(() => sizeKucoinPosition({ marginUsdt: 100, leverage: 10, price: 0, contract: btc }), /unavailable/)
})

test('client order ids round-trip the leg ticket', () => {
  const ticket = 450_000_000_001
  const entry = copierOrderLinkId('TScopier:chan:abcdef12', ticket)
  assert.ok(entry.length <= 40)
  assert.equal(ticketFromEntryLinkId(entry), ticket)
  const stop = childOrderLinkId(SL_PREFIX, ticket, 'ab12')
  assert.ok(stop.length <= 40)
  assert.equal(ticketFromChildLinkId(stop, SL_PREFIX), ticket)
  assert.equal(ticketFromChildLinkId(entry, SL_PREFIX), null)
})
