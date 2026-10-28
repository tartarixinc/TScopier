import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateTradeIntent } from './validateTradeIntent'
import { FRENCH_BUY_GOLD, PORTUGUESE_TP_UPDATE } from './fixtures/multilingualFixtures'

describe('validateTradeIntent', () => {
  it('accepts prices present in source message', () => {
    const result = validateTradeIntent({
      kind: 'entry',
      side: 'BUY',
      symbol: 'XAUUSD',
      entry: [3365],
      sl: 3355,
      tp: [3370, 3375, 3380],
      sl_unit: 'price',
      tp_unit: 'price',
      flags: {},
      confidence: 0.97,
    }, FRENCH_BUY_GOLD.rawMessage)
    assert.equal(result.ok, true)
  })

  it('rejects invented SL not in message', () => {
    const result = validateTradeIntent({
      kind: 'entry',
      side: 'BUY',
      symbol: 'XAUUSD',
      entry: [3365],
      sl: 9999,
      tp: [3370],
      sl_unit: 'price',
      tp_unit: 'price',
      flags: {},
      confidence: 0.9,
    }, FRENCH_BUY_GOLD.rawMessage)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /invented_sl/)
  })

  it('rejects any price invented for a message without numbers', () => {
    const result = validateTradeIntent({
      kind: 'modify',
      side: 'BUY',
      symbol: 'XAUUSD',
      entry: [],
      sl: 4122,
      tp: [],
      sl_unit: 'price',
      tp_unit: 'price',
      flags: {},
      confidence: 0.9,
    }, 'Set SL TO BE  & take partials NOW.')
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /invented_sl/)
  })

  it('allows a price-free breakeven instruction', () => {
    const result = validateTradeIntent({
      kind: 'breakeven',
      side: 'BUY',
      symbol: 'XAUUSD',
      entry: [],
      sl: null,
      tp: [],
      sl_unit: 'price',
      tp_unit: 'price',
      flags: {},
      confidence: 0.92,
    }, 'Set SL TO BE  & take partials NOW.')
    assert.equal(result.ok, true)
  })

  it('passes commentary intent', () => {
    const result = validateTradeIntent({
      kind: 'commentary',
      side: null,
      symbol: 'XAUUSD',
      entry: [],
      sl: null,
      tp: [],
      sl_unit: 'price',
      tp_unit: 'price',
      flags: {},
      confidence: 0.99,
    }, PORTUGUESE_TP_UPDATE.rawMessage)
    assert.equal(result.ok, true)
  })
})
