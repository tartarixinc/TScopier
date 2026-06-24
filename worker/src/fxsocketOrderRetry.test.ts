import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOrderOpTimedOutMessage, perAccountTradeConcurrency } from './fxsocketClient'

describe('isOrderOpTimedOutMessage', () => {
  it('matches the bridge OrderModify timeout phrasing', () => {
    assert.equal(isOrderOpTimedOutMessage('TradingHelper.OrderModify timed out'), true)
    assert.equal(isOrderOpTimedOutMessage('TradingHelper.OrderClose timed out'), true)
    assert.equal(isOrderOpTimedOutMessage('Invalid stops'), false)
    assert.equal(isOrderOpTimedOutMessage('unknown ticket'), false)
    assert.equal(isOrderOpTimedOutMessage(''), false)
    assert.equal(isOrderOpTimedOutMessage(null), false)
  })
})

describe('perAccountTradeConcurrency', () => {
  it('defaults to 3 and stays within [1, 8]', () => {
    const prev = process.env.MT_PER_ACCOUNT_TRADE_CONCURRENCY
    try {
      delete process.env.MT_PER_ACCOUNT_TRADE_CONCURRENCY
      assert.equal(perAccountTradeConcurrency(), 3)
      process.env.MT_PER_ACCOUNT_TRADE_CONCURRENCY = '2'
      assert.equal(perAccountTradeConcurrency(), 2)
      process.env.MT_PER_ACCOUNT_TRADE_CONCURRENCY = '50'
      assert.equal(perAccountTradeConcurrency(), 8, 'capped at 8')
      process.env.MT_PER_ACCOUNT_TRADE_CONCURRENCY = 'garbage'
      assert.equal(perAccountTradeConcurrency(), 3, 'falls back to default')
    } finally {
      if (prev === undefined) delete process.env.MT_PER_ACCOUNT_TRADE_CONCURRENCY
      else process.env.MT_PER_ACCOUNT_TRADE_CONCURRENCY = prev
    }
  })
})
