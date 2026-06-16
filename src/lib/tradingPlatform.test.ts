import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inferServerPlatform, normalizeTradingPlatform } from './tradingPlatform'

describe('tradingPlatform', () => {
  it('normalizeTradingPlatform defaults to MT5', () => {
    assert.equal(normalizeTradingPlatform(''), 'MT5')
    assert.equal(normalizeTradingPlatform('mt4'), 'MT4')
  })

  it('inferServerPlatform reads common server suffixes', () => {
    assert.equal(inferServerPlatform('ICMarketsSC-MT5'), 'MT5')
    assert.equal(inferServerPlatform('Broker-MT4-Demo'), 'MT4')
    assert.equal(inferServerPlatform('VTMarkets-Demo'), null)
  })
})
