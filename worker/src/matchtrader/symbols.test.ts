import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  MatchtraderSizingError,
  entryKey,
  lotLimits,
  matchInstrument,
  operationFor,
  orderTypeForOperation,
  parseServerTime,
  priceDecimals,
  resolveComments,
  roundPrice,
  sideForOperation,
  sizeLots,
  tagKey,
  ticketFromId,
  type MatchtraderInstrument,
} from './symbols'

function inst(partial: Partial<MatchtraderInstrument> & { symbol: string }): MatchtraderInstrument {
  return {
    alias: '', volumeMin: undefined, volumeMax: undefined, volumeStep: undefined, volumePrecision: undefined,
    contractSize: undefined, pricePrecision: undefined, sizeOfOnePoint: undefined, quoteCurrency: undefined,
    ...partial,
  }
}

test('matchInstrument prefers exact names and aliases, then a short broker suffix', () => {
  const list = [
    inst({ symbol: 'XAUUSD.test', alias: 'XAUUSD' }),
    inst({ symbol: 'EURUSD.x' }),
    inst({ symbol: 'EURUSDCHFJPY' }),
    inst({ symbol: 'GBPUSD' }),
  ]
  assert.equal(matchInstrument(list, 'XAUUSD')?.symbol, 'XAUUSD.test')
  assert.equal(matchInstrument(list, 'GBPUSD')?.symbol, 'GBPUSD')
  assert.equal(matchInstrument(list, 'EURUSD')?.symbol, 'EURUSD.x')
  assert.equal(matchInstrument(list, 'XAU/USD')?.symbol, 'XAUUSD.test')
  assert.equal(matchInstrument(list, 'NOPE'), undefined)
  assert.equal(matchInstrument(list, ''), undefined)
})

test('lot limits trust values that look like lots and ignore unit-like ones', () => {
  assert.deepEqual(lotLimits({ volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, volumePrecision: 2 }), { step: 0.01, min: 0.01, max: 50 })
  // The docs sample (min 10, step 10, contract size 1) reads as units: the step falls back to the precision.
  assert.deepEqual(lotLimits({ volumeMin: 10, volumeMax: 1_000_000, volumeStep: 10, volumePrecision: 2 }), { step: 0.01, min: 0.01, max: undefined })
  assert.deepEqual(lotLimits({ volumeMin: undefined, volumeMax: undefined, volumeStep: undefined, volumePrecision: undefined }), { step: 0.01, min: 0.01, max: undefined })
  assert.deepEqual(lotLimits({ volumeMin: undefined, volumeMax: undefined, volumeStep: undefined, volumePrecision: 1 }), { step: 0.1, min: 0.1, max: undefined })
})

test('sizeLots floors to the step and checks the limits', () => {
  const i = { volumeMin: 0.01, volumeMax: 5, volumeStep: 0.01, volumePrecision: 2 }
  assert.equal(sizeLots(0.237, 'EURUSD', i), 0.23)
  assert.equal(sizeLots(1, 'EURUSD', i), 1)
  assert.throws(() => sizeLots(0.004, 'EURUSD', i), (error: unknown) => error instanceof MatchtraderSizingError && /at least 0\.01/.test(error.message))
  assert.throws(() => sizeLots(6, 'EURUSD', i), /at most 5/)
  assert.throws(() => sizeLots(0, 'EURUSD', i), /above 0/)
})

test('prices are rounded to the instrument precision', () => {
  assert.equal(priceDecimals({ pricePrecision: 5, sizeOfOnePoint: undefined }), 5)
  assert.equal(priceDecimals({ pricePrecision: undefined, sizeOfOnePoint: 0.01 }), 2)
  assert.equal(priceDecimals({ pricePrecision: undefined, sizeOfOnePoint: undefined }), 5)
  assert.equal(roundPrice(1.0950004, { pricePrecision: 5, sizeOfOnePoint: undefined }), 1.095)
})

test('ids become tickets by their digits and tags meet on the same digits', () => {
  assert.equal(ticketFromId('W6910422326264457'), 6910422326264457)
  assert.equal(ticketFromId('9000'), 9000)
  assert.equal(ticketFromId('abc'), 0)
  assert.equal(ticketFromId('W99999999999999999999'), 0)
  assert.equal(ticketFromId(undefined), 0)
  assert.equal(tagKey('W123'), tagKey('123'))
})

test('operations map to a side and an order type', () => {
  assert.equal(sideForOperation('SellLimit'), 'SELL')
  assert.equal(sideForOperation('Buy'), 'BUY')
  assert.equal(orderTypeForOperation('BuyLimit'), 'limit')
  assert.equal(orderTypeForOperation('SellStop'), 'stop')
  assert.equal(orderTypeForOperation('Sell'), 'market')
  assert.equal(operationFor('LIMIT', 'BUY'), 'BuyLimit')
  assert.equal(operationFor('STOP', 'SELL'), 'SellStop')
  assert.equal(operationFor('MARKET', 'SELL'), 'Sell')
})

test('server times without a zone are read as UTC', () => {
  assert.equal(parseServerTime('2024-07-13T04:30:35'), Date.UTC(2024, 6, 13, 4, 30, 35))
  assert.equal(parseServerTime('2024-07-13T04:30:35Z'), Date.UTC(2024, 6, 13, 4, 30, 35))
  assert.equal(parseServerTime('2024-07-13T05:30:35+01:00'), Date.UTC(2024, 6, 13, 4, 30, 35))
  assert.equal(parseServerTime(''), undefined)
  assert.equal(parseServerTime('garbage'), undefined)
})

test('an entry key is stable for the same order inside two minutes and differs otherwise', () => {
  const base = { comment: 'c', symbol: 'EURUSD', operation: 'Buy', qty: 0.1, price: null, stopLoss: 1.09, takeProfit: null, now: 1_790_000_000_000 }
  assert.equal(entryKey(base), entryKey({ ...base, now: base.now + 30_000 }))
  assert.notEqual(entryKey(base), entryKey({ ...base, qty: 0.2 }))
  assert.notEqual(entryKey(base), entryKey({ ...base, now: base.now + 600_000 }))
})

test('comments resolve by exact id first, then by symbol, side and time, each tag used once', () => {
  const tags = new Map([
    ['100', { comment: 'exact', symbol: 'EURUSD', side: 'buy' as const, at: 0 }],
    ['200', { comment: 'near', symbol: 'EURUSD', side: 'buy' as const, at: 1_000_000 }],
    ['300', { comment: 'sell', symbol: 'EURUSD', side: 'sell' as const, at: 1_000_000 }],
  ])
  const out = resolveComments([
    { id: 'W100', symbol: 'EURUSD', side: 'buy', at: 5 },
    { id: 'W101', symbol: 'EURUSD.x', side: 'buy', at: 1_010_000 },
    { id: 'W102', symbol: 'EURUSD', side: 'buy', at: 1_020_000 },
    { id: 'W103', symbol: 'EURUSD', side: 'buy', at: 2_000_000 },
    { id: 'W104', symbol: 'GBPUSD', side: 'buy', at: 1_000_000 },
  ], tags)
  assert.equal(out.get('W100'), 'exact')
  assert.equal(out.get('W101'), undefined)
  assert.equal(out.get('W102'), 'near')
  assert.equal(out.get('W103'), undefined)
  assert.equal(out.get('W104'), undefined)
})
