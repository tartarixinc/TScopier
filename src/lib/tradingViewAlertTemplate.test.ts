import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_TRADINGVIEW_ALERT_CONFIG,
  buildTradingViewAlertJson,
  buildTradingViewAlertTemplates,
  normalizeTradingViewAlertConfig,
} from './tradingViewAlertTemplate.ts'

describe('normalizeTradingViewAlertConfig', () => {
  it('returns defaults for nullish input', () => {
    assert.deepEqual(normalizeTradingViewAlertConfig(null), DEFAULT_TRADINGVIEW_ALERT_CONFIG)
  })

  it('clamps tpCount and normalizes kind/symbol', () => {
    const config = normalizeTradingViewAlertConfig({
      kind: 'strategy',
      includeSl: true,
      includeTp: true,
      tpCount: 99,
      symbol: '  eurusd  ',
    })
    assert.equal(config.kind, 'strategy')
    assert.equal(config.tpCount, 5)
    assert.equal(config.symbol, 'EURUSD')
  })
})

describe('buildTradingViewAlertJson', () => {
  it('builds strategy JSON with sl and multiple tps', () => {
    const json = buildTradingViewAlertJson({
      kind: 'strategy',
      includeSl: true,
      includeTp: true,
      tpCount: 2,
    }, 'strategy')
    const parsed = JSON.parse(json) as Record<string, unknown>
    assert.equal(parsed.action, '{{strategy.order.action}}')
    assert.equal(parsed.symbol, '{{ticker}}')
    assert.equal(parsed.price, '{{close}}')
    assert.equal(parsed.sl, 0)
    assert.deepEqual(parsed.tp, [0, 0])
    assert.equal(parsed.id, '{{timenow}}')
  })

  it('omits sl/tp when toggles are off', () => {
    const json = buildTradingViewAlertJson({
      kind: 'indicator',
      includeSl: false,
      includeTp: false,
      tpCount: 3,
      symbol: 'XAUUSD',
    }, 'buy')
    const parsed = JSON.parse(json) as Record<string, unknown>
    assert.equal(parsed.action, 'buy')
    assert.equal(parsed.symbol, 'XAUUSD')
    assert.equal('sl' in parsed, false)
    assert.equal('tp' in parsed, false)
  })

  it('builds buy and sell templates for indicator', () => {
    const templates = buildTradingViewAlertTemplates({
      kind: 'indicator',
      includeSl: true,
      includeTp: true,
      tpCount: 1,
      symbol: 'BTCUSD',
    })
    assert.ok(templates.buy)
    assert.ok(templates.sell)
    assert.equal(templates.strategy, undefined)
    assert.equal(JSON.parse(templates.buy!).action, 'buy')
    assert.equal(JSON.parse(templates.sell!).action, 'sell')
    assert.equal(JSON.parse(templates.buy!).symbol, 'BTCUSD')
  })
})
