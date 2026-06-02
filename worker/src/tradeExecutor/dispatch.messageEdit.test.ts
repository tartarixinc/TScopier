import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { messageEditSkipReason } from './dispatch'

describe('messageEditSkipReason', () => {
  it('allows edited parameter refresh with corrected SL/TP', () => {
    const parsed = {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: 4530.85,
      entry_zone_low: 4532.7,
      entry_zone_high: 4529,
      sl: 4524.3,
      tp: [4535, 4538],
      raw_instruction: 'GOLD BUY NOW 4532.7 - 4529 SL: 4524.3 TP: 4535',
    }
    assert.equal(messageEditSkipReason(parsed, 'buy'), null)
  })

  it('blocks edited messages with no SL/TP payload', () => {
    const parsed = {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: 4530.85,
      sl: null,
      tp: [],
      raw_instruction: 'GOLD BUY NOW',
    }
    assert.equal(messageEditSkipReason(parsed, 'buy'), 'message_edit_no_sl_tp')
  })

  it('blocks SL/TP edits that are not parameter refresh or management', () => {
    const parsed = {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: 4530.85,
      entry_zone_low: 4532.7,
      entry_zone_high: 4529,
      sl: 4524.3,
      tp: [4535],
      // Explicit re-enter intent makes this non-parameter refresh.
      raw_instruction: 'RE-ENTER BUY NOW 4530 SL 4524.3 TP 4535',
      re_enter: true,
    }
    assert.equal(messageEditSkipReason(parsed, 'buy'), 'message_edit_not_parameter_refresh')
  })
})
