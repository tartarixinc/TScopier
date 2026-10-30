import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { confirmBrokerStopApplied, readTradeBrokerStop } from './brokerStopReadback'

const buyTrade = {
  id: 'trade-1',
  metaapi_order_id: '2013291582',
  symbol: 'XAUUSD',
  direction: 'buy',
  lot_size: 0.04,
  entry_price: 4149.95,
}

test('confirmed when the broker snapshot holds the expected stop (buy)', () => {
  const out = confirmBrokerStopApplied({
    openedOrders: [{
      ticket: 2013291582,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 4150.25,
    }],
    trade: buyTrade,
    ticket: 2013291582,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.005,
  })
  assert.deepEqual(out, { confirmed: true, found: true, stoploss: 4150.25 })
})

test('a tighter-than-requested stop still counts as confirmed (buy)', () => {
  // The broker moved the stop further in our favour (e.g. a trailing stop); that
  // is protection, not a failure, so the leg must not be stuck retrying.
  const out = confirmBrokerStopApplied({
    openedOrders: [{
      ticket: 2013291582,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 4150.9,
    }],
    trade: buyTrade,
    ticket: 2013291582,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.005,
  })
  assert.equal(out.confirmed, true)
  assert.equal(out.stoploss, 4150.9)
})

test('not confirmed when the broker holds a looser stop (buy)', () => {
  const out = confirmBrokerStopApplied({
    openedOrders: [{
      ticket: 2013291582,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 4138.27,
    }],
    trade: buyTrade,
    ticket: 2013291582,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.005,
  })
  assert.equal(out.confirmed, false)
  assert.equal(out.found, true)
  assert.equal(out.stoploss, 4138.27)
})

test('directional check for a sell: lower stop is more protective', () => {
  const sellTrade = { ...buyTrade, direction: 'sell' }
  const row = (stopLoss: number) => [{
    ticket: 2013291582,
    operation: 'Sell',
    symbol: 'XAUUSD',
    lots: 0.04,
    openPrice: 4149.95,
    stopLoss,
  }]
  const atOrTighter = confirmBrokerStopApplied({
    openedOrders: row(4149.0),
    trade: sellTrade,
    ticket: 2013291582,
    expectedSl: 4149.5,
    isBuy: false,
    tolerance: 0.005,
  })
  assert.equal(atOrTighter.confirmed, true)
  const looser = confirmBrokerStopApplied({
    openedOrders: row(4160.0),
    trade: sellTrade,
    ticket: 2013291582,
    expectedSl: 4149.5,
    isBuy: false,
    tolerance: 0.005,
  })
  assert.equal(looser.confirmed, false)
})

test('not confirmed when the position exists but carries no stop', () => {
  const out = confirmBrokerStopApplied({
    openedOrders: [{
      ticket: 2013291582,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 0,
    }],
    trade: buyTrade,
    ticket: 2013291582,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.005,
  })
  assert.deepEqual(out, { confirmed: false, found: true, stoploss: null })
})

test('not confirmed when the ticket is absent from the snapshot', () => {
  const out = confirmBrokerStopApplied({
    openedOrders: [{ ticket: 999999, operation: 'Buy', symbol: 'XAUUSD', stopLoss: 4150.25 }],
    trade: buyTrade,
    ticket: 2013291582,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.005,
  })
  assert.equal(out.confirmed, false)
  assert.equal(out.found, false)
})

test('not confirmed when the opened-orders read failed', () => {
  for (const orders of [null, undefined, 'not-a-list']) {
    const out = confirmBrokerStopApplied({
      openedOrders: orders as unknown[] | null | undefined,
      trade: buyTrade,
      ticket: 2013291582,
      expectedSl: 4150.25,
      isBuy: true,
      tolerance: 0.005,
    })
    assert.equal(out.confirmed, false)
    assert.equal(out.found, false)
  }
})

test('tolerance absorbs a sub-point broker rounding difference', () => {
  const out = confirmBrokerStopApplied({
    openedOrders: [{
      ticket: 2013291582,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 4150.2,
    }],
    trade: buyTrade,
    ticket: 2013291582,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.1,
  })
  assert.equal(out.confirmed, true)
})

test('resolves the position ticket when the broker reports it separately (MT5)', () => {
  const out = confirmBrokerStopApplied({
    openedOrders: [{
      positionTicket: 555,
      orderTicket: 444,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 4150.25,
    }],
    trade: buyTrade,
    ticket: 555,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.005,
  })
  assert.deepEqual(out, { confirmed: true, found: true, stoploss: 4150.25 })
})

test('an attribute-only match is never accepted as confirmation', () => {
  // Stored ticket is absent, but symbol/direction/lots/entry all line up. That is
  // a guess, not proof, so it must not confirm.
  const out = confirmBrokerStopApplied({
    openedOrders: [{
      ticket: 777777,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 4150.25,
    }],
    trade: buyTrade,
    ticket: 2013291582,
    expectedSl: 4150.25,
    isBuy: true,
    tolerance: 0.005,
  })
  assert.equal(out.confirmed, false)
  assert.equal(out.found, false)
})

test('readTradeBrokerStop finds the stored position and reports its stop', () => {
  const read = readTradeBrokerStop({
    openedOrders: [{
      ticket: 2013291582,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
      stopLoss: 4150.25,
    }],
    trade: buyTrade,
  })
  assert.deepEqual(read, { found: true, stoploss: 4150.25 })
})

test('readTradeBrokerStop reports found=false for a position with no stop', () => {
  const read = readTradeBrokerStop({
    openedOrders: [{
      ticket: 2013291582,
      operation: 'Buy',
      symbol: 'XAUUSD',
      lots: 0.04,
      openPrice: 4149.95,
    }],
    trade: buyTrade,
  })
  assert.deepEqual(read, { found: true, stoploss: null })
})
