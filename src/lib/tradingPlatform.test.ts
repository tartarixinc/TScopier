import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inferServerPlatform, normalizeTradingPlatform } from './tradingPlatform'

describe('tradingPlatform', () => {
  it('normalizeTradingPlatform defaults to MT5', () => {
    assert.equal(normalizeTradingPlatform(''), 'MT5')
    assert.equal(normalizeTradingPlatform('mt4'), 'MT4')
    assert.equal(normalizeTradingPlatform('ctrader'), 'cTrader')
    assert.equal(normalizeTradingPlatform('binance'), 'Binance')
    assert.equal(normalizeTradingPlatform('bybit'), 'Bybit')
    assert.equal(normalizeTradingPlatform('kucoin'), 'KuCoin')
    assert.equal(normalizeTradingPlatform('KuCoin'), 'KuCoin')
    assert.equal(normalizeTradingPlatform('cTrader'), 'cTrader')
  })

  it('inferServerPlatform reads common server suffixes', () => {
    assert.equal(inferServerPlatform('ICMarketsSC-MT5'), 'MT5')
    assert.equal(inferServerPlatform('Broker-MT4-Demo'), 'MT4')
    assert.equal(inferServerPlatform('VTMarkets-Demo'), null)
  })
})
