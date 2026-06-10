import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMENTARY_NOT_SIGNAL_REASON,
  ENTRY_MISSING_STRUCTURE_REASON,
  ENTRY_REQUIRES_NOW_REASON,
  evaluateParsedSignalExecutionEligibility,
} from './signalExecutionEligibility'

describe('evaluateParsedSignalExecutionEligibility', () => {
  it('rejects commentary-style pip/TP chatter', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'XAUUSD',
      sl: null,
      tp: [2],
    }, 'Hmmmm 6 pips short of TP2.... Funny you gold.')
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, COMMENTARY_NOT_SIGNAL_REASON)
  })

  it('accepts minimal market entry with symbol and side intent', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, 'Gold buy now')
    assert.equal(eligibility.eligible, true)
  })

  it('accepts structured entry signal', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'XAUUSD',
      sl: 4577,
      tp: [4564, 4527],
      entry_price: 4567,
    }, 'Gold sell now @ 4567 TP1: 4564 TP2: 4527 SL: 4577')
    assert.equal(eligibility.eligible, true)
  })

  it('rejects entry lacking structure and market intent', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, 'Gold maybe going down')
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, ENTRY_REQUIRES_NOW_REASON)
  })

  it('rejects buy without SL, TP, or NOW', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: 4500,
      sl: null,
      tp: [],
    }, 'BUY XAUUSD 4500')
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, ENTRY_REQUIRES_NOW_REASON)
  })

  it('rejects implausible metal tp from commentary percentages', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [5],
    }, 'GOLD watches up 5%')
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, COMMENTARY_NOT_SIGNAL_REASON)
  })

  it('rejects profit testimonial with inferred tp from currency amount', () => {
    const msg = `**INSANE RESULT** 🔥

**Darryl** from **the UK **🇬🇧 took my **GOLD BUY** from today and made** £1110** **PROFIT!** 💰

**Truly amazing to see ❤️**🔥`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [1110],
      raw_instruction: msg,
    }, msg)
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, COMMENTARY_NOT_SIGNAL_REASON)
  })

  it('rejects FX Culture-style market news commentary', () => {
    const msg = `📰 Market News Update: Gold Plummets 3% as CPI Fails to Alter Fed Path

- Gold (XAU/USD) collapsed to around $4,125.
- Headline CPI accelerated to 4.2% YoY in May, highest since April 2023.
- Iran had taken too long to negotiate a deal over the bullion market.`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: 2023,
      tp: [],
    }, msg)
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, COMMENTARY_NOT_SIGNAL_REASON)
  })
})
