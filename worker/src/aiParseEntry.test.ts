import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { coerceAiEntrySignal } from './aiParseEntry'

describe('coerceAiEntrySignal', () => {
  it('forces re_enter for buy/sell entry fallback', () => {
    const out = coerceAiEntrySignal({
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 2640,
      tp: [2670],
      lot_size: null,
      raw_instruction: 'BUY GOLD NOW SL 2640 TP 2670',
    })
    assert.equal(out.action, 'buy')
    assert.equal(out.re_enter, true)
  })

  it('leaves non-entry actions unchanged', () => {
    const out = coerceAiEntrySignal({
      action: 'ignore',
      symbol: null,
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [],
      lot_size: null,
      raw_instruction: 'just commentary',
    })
    assert.equal(out.action, 'ignore')
    assert.equal(out.re_enter, undefined)
  })
})
