import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  STRATEGY_MAX,
  TradelockerSizingError,
  closedTradesFromHistory,
  commentFromStrategyId,
  entryStrategyId,
  grossProfit,
  matchInstrument,
  roundToTick,
  sizeLots,
  ticketFromId,
} from './symbols'

test('matchInstrument prefers exact names, then a short broker suffix', () => {
  const list = [{ name: 'XAU/USD' }, { name: 'EURUSD.x' }, { name: 'EURUSDCHFJPY' }, { name: 'GBPUSD' }]
  assert.equal(matchInstrument(list, 'XAUUSD')?.name, 'XAU/USD')
  assert.equal(matchInstrument(list, 'GBPUSD')?.name, 'GBPUSD')
  assert.equal(matchInstrument(list, 'EURUSD')?.name, 'EURUSD.x')
  assert.equal(matchInstrument(list, 'USDJPY'), undefined)
})

test('sizeLots floors to the step and enforces the minimum and maximum', () => {
  const rules = { lotStep: 0.01, minLot: 0.01, maxLot: 50 }
  assert.equal(sizeLots(0.237, 'EURUSD', rules), 0.23)
  assert.equal(sizeLots(0.1 + 0.2, 'EURUSD', rules), 0.3)
  assert.throws(() => sizeLots(0.004, 'EURUSD', rules), TradelockerSizingError)
  assert.throws(() => sizeLots(0, 'EURUSD', rules), /above 0/)
  assert.throws(() => sizeLots(60, 'EURUSD', rules), /at most 50/)
  assert.equal(sizeLots(0.05, 'EURUSD', {} as never), 0.05)
  assert.throws(() => sizeLots(0.4, 'US30', { lotStep: 1, minLot: 1, maxLot: undefined }), /at least 1 lots/)
})

test('roundToTick snaps prices without float noise', () => {
  assert.equal(roundToTick(1.100004, 0.00001), 1.1)
  assert.equal(roundToTick(2345.678, 0.01), 2345.68)
  assert.equal(roundToTick(2345.678, undefined), 2345.678)
})

test('entry strategy ids are stable within a bucket, short, and carry the signal tail', () => {
  const base = {
    comment: 'TScopier:gold-vip:3fa85f64-5717-4562-b3fc-2c963f66afa6:tp1',
    symbol: 'XAU/USD',
    operation: 'Buy',
    qty: 0.1,
    price: undefined,
    stopLoss: 2300,
    takeProfit: 2400,
    now: 1_790_000_000_000,
  }
  const id = entryStrategyId(base)
  assert.equal(id, entryStrategyId({ ...base, now: base.now + 30_000 }))
  assert.notEqual(id, entryStrategyId({ ...base, now: base.now + 5 * 60_000 }))
  assert.notEqual(id, entryStrategyId({ ...base, qty: 0.2 }))
  assert.ok(id.length <= STRATEGY_MAX, id)
  assert.match(id, /^TSC\.3fa85f645717\./)
  assert.equal(commentFromStrategyId(id), 'TScopier:3fa85f645717')
  assert.equal(commentFromStrategyId('manual'), '')
  assert.ok(entryStrategyId({ ...base, comment: undefined }).length <= STRATEGY_MAX)
  assert.equal(commentFromStrategyId(entryStrategyId({ ...base, comment: undefined })), '')
})

test('ticketFromId keeps numeric ids and hashes anything else', () => {
  assert.equal(ticketFromId('1234567'), 1234567)
  assert.equal(ticketFromId('abc'), ticketFromId('abc'))
  assert.ok(ticketFromId('abc') > 0)
})

test('closedTradesFromHistory pairs the opening fill with each opposite-side fill', () => {
  const names = new Map([[11, 'EURUSD']])
  const history = [
    { id: '900', positionId: '700', status: 'Filled', side: 'sell', filledQty: 0.1, avgPrice: 1.09, tradableInstrumentId: 11, createdDate: 1000, lastModified: 1100, strategyId: 'TSC.abc.x.y', stopLoss: 1.095, takeProfit: 1.08 },
    { id: '901', positionId: '700', status: 'Filled', side: 'buy', filledQty: 0.1, avgPrice: 1.085, tradableInstrumentId: 11, createdDate: 5000, lastModified: 5100 },
    { id: '902', positionId: '701', status: 'Filled', side: 'buy', filledQty: 0.2, avgPrice: 1.1, tradableInstrumentId: 11, createdDate: 2000, lastModified: 2100 },
    { id: '903', positionId: '702', status: 'Cancelled', side: 'buy', qty: 0.1, tradableInstrumentId: 11, createdDate: 3000 },
    { id: '904', positionId: '', status: 'Filled', side: 'buy', filledQty: 0.1, tradableInstrumentId: 11, createdDate: 3500 },
  ]
  const trades = closedTradesFromHistory(history, names)
  assert.equal(trades.length, 1)
  assert.deepEqual(trades[0], {
    positionId: '700',
    closeId: '901',
    symbol: 'EURUSD',
    positionSide: 'sell',
    lots: 0.1,
    openPrice: 1.09,
    closePrice: 1.085,
    openedAt: 1000,
    closedAt: 5100,
    stopLoss: 1.095,
    takeProfit: 1.08,
    strategyId: 'TSC.abc.x.y',
  })
})

test('grossProfit only answers when no currency conversion is needed', () => {
  const same = { side: 'buy' as const, lots: 1, openPrice: 2300, closePrice: 2310, contractSize: 100, quotingCurrency: 'USD', accountCurrency: 'usd' }
  assert.equal(grossProfit(same), 1000)
  assert.equal(grossProfit({ ...same, side: 'sell' }), -1000)
  assert.equal(grossProfit({ ...same, accountCurrency: 'EUR' }), undefined)
  assert.equal(grossProfit({ ...same, contractSize: undefined }), undefined)
  assert.equal(grossProfit({ ...same, closePrice: undefined }), undefined)
})
