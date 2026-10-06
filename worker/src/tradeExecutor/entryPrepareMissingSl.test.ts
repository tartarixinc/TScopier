import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isExplicitProviderNewOrder,
  missingRequiredSlFailure,
  shouldEnforceSingleOpenSymbolSlot,
} from './entryPrepareMissingSl'
import type { ManualSettings, ParsedSignal } from '../manualPlanner'

function parsed(overrides: Partial<ParsedSignal>): ParsedSignal {
  return {
    action: 'buy',
    symbol: 'XAUUSD',
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: null,
    tp: [2400],
    lot_size: null,
    raw_instruction: 'GOLD BUY TP 2400',
    ...overrides,
  }
}

describe('missingRequiredSlFailure', () => {
  it('detects provider-withheld SL when required stops have no configured fallback', () => {
    const result = missingRequiredSlFailure(parsed({
      tp: null,
      raw_instruction: 'GOLD BUY SL premium',
    }), { add_new_trades_to_existing: false })
    assert.deepEqual(result, { withheldByProvider: true, reason: 'SIGNAL_MISSING_REQUIRED_SL' })
  })

  it('detects SL for premium members when required stops have no fallback', () => {
    const result = missingRequiredSlFailure(parsed({
      tp: null,
      raw_instruction: 'GOLD BUY SL for premium members',
    }), { add_new_trades_to_existing: false })
    assert.deepEqual(result, { withheldByProvider: true, reason: 'SIGNAL_MISSING_REQUIRED_SL' })
  })

  it('detects subscribe-for-SL wording when required stops have no fallback', () => {
    const result = missingRequiredSlFailure(parsed({
      tp: null,
      raw_instruction: 'GOLD BUY subscribe for SL',
    }), { add_new_trades_to_existing: false })
    assert.deepEqual(result, { withheldByProvider: true, reason: 'SIGNAL_MISSING_REQUIRED_SL' })
  })

  it('detects VIP SL wording when required stops have no fallback', () => {
    const result = missingRequiredSlFailure(parsed({
      tp: null,
      raw_instruction: 'GOLD BUY SL available to VIP',
    }), { add_new_trades_to_existing: false })
    assert.deepEqual(result, { withheldByProvider: true, reason: 'SIGNAL_MISSING_REQUIRED_SL' })
  })

  it('rejects TP-only entries that have no stop loss', () => {
    const result = missingRequiredSlFailure(parsed({
      raw_instruction: 'GOLD BUY NOW\nTP: 4503\nTP: 4506\nSL: NONE',
    }), { add_new_trades_to_existing: false })
    assert.deepEqual(result, {
      withheldByProvider: false,
      reason: 'entry_tp_without_sl',
    })
  })

  it('rejects TP-only entries even when add_new_trades_to_existing is on', () => {
    const result = missingRequiredSlFailure(parsed({
      raw_instruction: 'GOLD BUY TP 2400',
    }), {})
    assert.deepEqual(result, {
      withheldByProvider: false,
      reason: 'entry_tp_without_sl',
    })
  })

  it('preserves numeric SL as executable', () => {
    const result = missingRequiredSlFailure(parsed({
      sl: 2290,
      raw_instruction: 'GOLD BUY SL 2290 TP 2400',
    }), {})
    assert.equal(result, null)
  })

  it('allows SL-only entries (no TP)', () => {
    const result = missingRequiredSlFailure(parsed({
      sl: 4500,
      tp: null,
      raw_instruction: 'GOLD BUY NOW\nSL: 4500',
    }), {})
    assert.equal(result, null)
  })

  it('does not treat generic premium wording away from SL as withheld SL', () => {
    const result = missingRequiredSlFailure(parsed({
      raw_instruction: 'Premium signal GOLD BUY TP 2400',
    }), {})
    assert.deepEqual(result, {
      withheldByProvider: false,
      reason: 'entry_tp_without_sl',
    })
  })

  it('does not treat VIP entry wording as withheld SL', () => {
    const result = missingRequiredSlFailure(parsed({
      raw_instruction: 'VIP entry GOLD BUY TP 2400',
    }), {})
    assert.deepEqual(result, {
      withheldByProvider: false,
      reason: 'entry_tp_without_sl',
    })
  })

  it('does not treat premium channel marketing as withheld SL', () => {
    const result = missingRequiredSlFailure(parsed({
      raw_instruction: 'GOLD BUY TP 2400 - Join premium for more signals',
    }), {})
    assert.deepEqual(result, {
      withheldByProvider: false,
      reason: 'entry_tp_without_sl',
    })
  })

  it('distinguishes a required missing stop from provider-withheld wording', () => {
    const result = missingRequiredSlFailure(parsed({
      tp: null,
      raw_instruction: 'GOLD BUY NOW',
    }), { add_new_trades_to_existing: false })
    assert.deepEqual(result, { withheldByProvider: false, reason: 'SIGNAL_MISSING_REQUIRED_SL' })
  })

  it('preserves SL-optional behavior when config does not require a stop', () => {
    const result = missingRequiredSlFailure(parsed({
      tp: null,
      raw_instruction: 'GOLD BUY NOW',
    }), {})
    assert.equal(result, null)
  })

  it('rejects provider-withheld SL when TP is present and no fallback SL exists', () => {
    const result = missingRequiredSlFailure(parsed({
      raw_instruction: 'GOLD BUY TP 2400 SL premium',
    }), {})
    assert.deepEqual(result, {
      withheldByProvider: true,
      reason: 'entry_tp_without_sl',
    })
  })

  it('does not fail premium-SL signals when a configured fallback stop can be derived', () => {
    const manual: ManualSettings = {
      use_predefined_sl_pips: true,
      predefined_sl_pips: 30,
    }
    const result = missingRequiredSlFailure(parsed({
      entry_price: 2320,
      raw_instruction: 'GOLD BUY 2320 TP 2400 SL premium',
    }), manual)
    assert.equal(result, null)
  })

  it('allows TP-only when predefined SL pips can supply the stop', () => {
    const manual: ManualSettings = {
      use_predefined_sl_pips: true,
      predefined_sl_pips: 30,
    }
    const result = missingRequiredSlFailure(parsed({
      entry_price: 4500,
      tp: [4503, 4506],
      raw_instruction: 'GOLD BUY NOW\nTP: 4503\nTP: 4506\nSL: NONE',
    }), manual)
    assert.equal(result, null)
  })

  it('allows TP-only predefined SL even when the signal has no entry price', () => {
    const result = missingRequiredSlFailure(parsed({
      entry_price: null,
      tp: [2400],
      raw_instruction: 'GOLD BUY NOW TP 2400',
    }), { use_predefined_sl_pips: true, predefined_sl_pips: 80 })
    assert.equal(result, null)
  })

  it('allows Premium/withheld SL when predefined SL is set, without a signal entry', () => {
    const result = missingRequiredSlFailure(parsed({
      entry_price: null,
      tp: [2400],
      raw_instruction: 'GOLD BUY TP 2400 SL premium',
    }), { use_predefined_sl_pips: true, predefined_sl_pips: 80 })
    assert.equal(result, null)
  })

  it('allows bare market buy when predefined SL is set even if stops are required', () => {
    const result = missingRequiredSlFailure(parsed({
      tp: null,
      raw_instruction: 'GOLD BUY NOW',
    }), {
      add_new_trades_to_existing: false,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
    })
    assert.equal(result, null)
  })

  it('allows RR-based SL fallback when TP and an entry anchor are usable', () => {
    const result = missingRequiredSlFailure(parsed({
      entry_price: 2300,
      tp: [2320],
      raw_instruction: 'GOLD BUY 2300 TP 2320',
    }), {
      add_new_trades_to_existing: false,
      rr_for_sl_enabled: true,
      rr_for_sl: 2,
    })
    assert.equal(result, null)
  })

  it('bypasses the single-symbol slot only for explicit provider New Order intent', () => {
    const manual = { add_new_trades_to_existing: false }
    const explicit = parsed({ provider_order_type: 'new', re_enter: true })
    assert.equal(isExplicitProviderNewOrder(explicit), true)
    assert.equal(shouldEnforceSingleOpenSymbolSlot(explicit, manual), false)
    assert.equal(shouldEnforceSingleOpenSymbolSlot(parsed({ re_enter: true }), manual), true)
    assert.equal(shouldEnforceSingleOpenSymbolSlot(parsed({}), manual), true)
  })

  it('does not treat predefined TP alone as a stop-loss fallback', () => {
    const result = missingRequiredSlFailure(parsed({
      raw_instruction: 'GOLD BUY NOW TP 2400',
    }), { use_predefined_tp_pips: true, predefined_tp_pips: [30] })
    assert.deepEqual(result, {
      withheldByProvider: false,
      reason: 'entry_tp_without_sl',
    })
  })
})
