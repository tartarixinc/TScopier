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
  it('builds strategy JSON with plot sl and tpN', () => {
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
    assert.equal(parsed.entry, '{{plot("Entry")}}')
    assert.equal(parsed.sl, '{{plot("SL")}}')
    assert.equal(parsed.tp1, '{{plot("TP1")}}')
    assert.equal(parsed.tp2, '{{plot("TP2")}}')
    assert.equal('tp' in parsed, false)
    assert.equal(parsed.id, '{{timenow}}')
  })

  it('omits level fields when toggles are off', () => {
    const json = buildTradingViewAlertJson({
      kind: 'indicator',
      includeSl: false,
      includeTp: false,
      tpCount: 3,
      symbol: 'XAUUSD',
    }, 'buy')
    const parsed = JSON.parse(json) as Record<string, unknown>
    assert.equal(parsed.event, 'entry')
    assert.equal(parsed.side, 'BUY')
    assert.equal(parsed.order, 'MARKET')
    assert.equal(parsed.symbol, 'XAUUSD')
    assert.equal(parsed.price, '{{close}}')
    assert.equal('sl' in parsed, false)
    assert.equal('tp' in parsed, false)
    assert.equal('tp1' in parsed, false)
    assert.equal('entry' in parsed, false)
    assert.equal('action' in parsed, false)
  })

  it('builds indicator buy/sell with plot levels', () => {
    const templates = buildTradingViewAlertTemplates({
      kind: 'indicator',
      includeSl: true,
      includeTp: true,
      tpCount: 3,
      symbol: 'BTCUSD',
    })
    assert.ok(templates.buy)
    assert.ok(templates.sell)
    assert.equal(templates.strategy, undefined)

    const buy = JSON.parse(templates.buy!) as Record<string, unknown>
    const sell = JSON.parse(templates.sell!) as Record<string, unknown>
    assert.equal(buy.side, 'BUY')
    assert.equal(sell.side, 'SELL')
    assert.equal(buy.event, 'entry')
    assert.equal(buy.symbol, 'BTCUSD')
    assert.equal(buy.entry, '{{plot("Entry")}}')
    assert.equal(buy.sl, '{{plot("SL")}}')
    assert.equal(buy.tp1, '{{plot("TP1")}}')
    assert.equal(buy.tp2, '{{plot("TP2")}}')
    assert.equal(buy.tp3, '{{plot("TP3")}}')
    assert.equal('tp4' in buy, false)
  })
})
