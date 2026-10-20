import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMENTARY_NOT_SIGNAL_REASON,
  ENTRY_MISSING_STRUCTURE_REASON,
  ENTRY_REQUIRES_IMPERATIVE_OR_LABELED_STOPS_REASON,
  ENTRY_REQUIRES_NOW_REASON,
  deterministicEntryNeedsAiRepair,
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

  it('allows bare Gold buy now market entry', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, 'Gold buy now')
    assert.equal(eligibility.eligible, true)
  })

  it('allows GOLD BUY NOW with SL only (no TP)', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: 4500,
      tp: [],
    }, 'GOLD BUY NOW\nSL: 4500')
    assert.equal(eligibility.eligible, true)
  })

  it('allows GOLD BUY NOW with TP levels but no SL (account fallback decided at entry)', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [4503, 4506],
    }, 'GOLD BUY NOW\nTP: 4503\nTP: 4506\nSL: NONE')
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
    assert.equal(eligibility.skipReason, ENTRY_REQUIRES_IMPERATIVE_OR_LABELED_STOPS_REASON)
  })

  it('rejects GTMO position commentary even when AI infers sell', () => {
    const msg = `This trade we right now in, selling gold, has a high potential of a very big drop.`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, msg)
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, COMMENTARY_NOT_SIGNAL_REASON)
  })

  it('rejects sell without imperative phrase or labeled SL/TP', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, 'Gold looking bearish, might drop soon')
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, ENTRY_REQUIRES_IMPERATIVE_OR_LABELED_STOPS_REASON)
  })

  it('rejects buy without SL, TP, imperative, or labeled stops', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: 4500,
      sl: null,
      tp: [],
    }, 'BUY XAUUSD 4500')
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, ENTRY_REQUIRES_IMPERATIVE_OR_LABELED_STOPS_REASON)
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

  it('rejects GTMO VIP retrospective buy Q&A commentary', () => {
    const msg =
      'Did you guys manage this buy quick enough? It was actually not a bad entry, a very strong support zone but fundementals to bearish for gold right now.'
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, msg)
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, COMMENTARY_NOT_SIGNAL_REASON)
  })

  it('allows French ACHAT IMMÉDIAT bare gold market entry', () => {
    const msg = '📈 SIGNAL OR (XAU/USD) – ACHAT IMMÉDIAT'
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, msg)
    assert.equal(eligibility.eligible, true)
  })

  it('accepts AUDNZD sell with labeled stops despite VIP footer Gold mention', () => {
    const msg = `📉AUD-NZD Free Signal!
⭕Sell!
#AUDNZD rejection from the horizontal supply area
Stop Loss: 1.2074
Take Profit: 1.2034
Entry: 1.2057
VIP MEMBERS GET
Forex, Gold, Oil signals`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'AUDNZD',
      sl: 1.2074,
      tp: [1.2034],
      entry_price: 1.2057,
    }, msg)
    assert.equal(eligibility.eligible, true)
  })

  it('deterministicEntryNeedsAiRepair when implausible TP tiers would be skipped', () => {
    const msg = `XAUUSD BUY 4082
TP 1 4086
TP 2 4087
SL @ 4055`
    const badParse = {
      action: 'buy',
      symbol: 'XAUUSD',
      sl: null,
      tp: [1, 2, 3],
      entry_price: 4055,
    }
    assert.equal(
      deterministicEntryNeedsAiRepair(badParse, msg),
      true,
    )
    assert.equal(
      deterministicEntryNeedsAiRepair({
        action: 'buy',
        symbol: 'XAUUSD',
        sl: 4055,
        tp: [4086, 4087, 4120],
        entry_price: 4082,
      }, msg),
      false,
    )
  })

  it('accepts NEW TRADE IDEA XAUUSD with numbered TP tiers and SL @ label', () => {
    const msg = `NEW TRADE IDEA

XAUUSD BUY 4082

TP 1 4086
TP 2 4087
TP 3 4120

SL @ 4055`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: 4055,
      tp: [4086, 4087, 4120],
      entry_price: 4082,
    }, msg)
    assert.equal(eligibility.eligible, true)
  })

  it('accepts FOREX KING emoji-glued SL/TP without buy now', () => {
    const msg = `Gold（XAUUSD）📊
BUY 🟢4043-4053

TP1 🎯4058
TP2 🎯4063
TP3 🎯4068

SL ⛔️4038`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: 4038,
      tp: [4058, 4063, 4068],
      entry_zone_low: 4043,
      entry_zone_high: 4053,
    }, msg)
    assert.equal(eligibility.eligible, true)
  })

  it('accepts SIGNAL ALERT verbose Stop Loss (SL) labels', () => {
    const msg = `🚨 SIGNAL ALERT 🚨

🌐 #XAUUSD

📊 Trade Details:📈#BUY

⚪️ Entry Point: 4058
🔴 Stop Loss (SL): 4050

🟢 Take Profit 1 (TP1): 4061
🟢 Take Profit 2 (TP2): 4066
🟢 Take Profit 3 (TP3): 4074`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'buy',
      symbol: 'XAUUSD',
      sl: 4050,
      tp: [4061, 4066, 4074],
      entry_price: 4058,
    }, msg)
    assert.equal(eligibility.eligible, true)
  })

  it('allows Apex-style activated gold sell (not RRR commentary)', () => {
    const msg = `🥇sell (GOLD) XAUUSD
✅Trade Activated From 4350_4360
✅TP1: 4320
✅TP2: 4315
🙋 SL (STOP LOSS): 4325
RRR(Risk To Reward Ratio) 1:3+
Action Plan: Stay Calm, Trust The Setup, And keep Holding Your Trades`
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'XAUUSD',
      sl: 4325,
      tp: [4320, 4315, 4310, 4305],
      entry_zone_low: 4350,
      entry_zone_high: 4360,
    }, msg)
    assert.equal(eligibility.eligible, true)
  })

  it('still rejects vague commentary without structure', () => {
    const eligibility = evaluateParsedSignalExecutionEligibility({
      action: 'sell',
      symbol: 'XAUUSD',
      sl: null,
      tp: [],
    }, 'Gold looking bearish, might drop soon')
    assert.equal(eligibility.eligible, false)
    assert.equal(eligibility.skipReason, ENTRY_REQUIRES_IMPERATIVE_OR_LABELED_STOPS_REASON)
  })
})
describe('deterministicEntryNeedsAiRepair stop-label fallback', () => {
  it('requests another parse attempt when the message states a stop the parse missed', () => {
    assert.equal(
      deterministicEntryNeedsAiRepair(
        { action: 'sell', symbol: 'XAUUSD', sl: null, tp: [4090, 4085] },
        'GOLD SELL NOW 4095\nTP1 4090\nTP2 4085\nSL.TP 4105',
        null,
      ),
      true,
    )
  })
  it('does not request another attempt once the stop is read', () => {
    assert.equal(
      deterministicEntryNeedsAiRepair(
        { action: 'sell', symbol: 'XAUUSD', sl: 4105, tp: [4090, 4085] },
        'GOLD SELL NOW 4095\nTP1 4090\nTP2 4085\nSL 4105',
        null,
      ),
      false,
    )
  })
  it('leaves take-profit-only signals to the account fallback rules', () => {
    assert.equal(
      deterministicEntryNeedsAiRepair(
        { action: 'buy', symbol: 'XAUUSD', sl: null, tp: [4124] },
        'GOLD BUY NOW 4120\nTP1 4124',
        null,
      ),
      false,
    )
  })
  it('never requests another attempt for non-entry actions', () => {
    assert.equal(
      deterministicEntryNeedsAiRepair(
        { action: 'ignore', sl: null, tp: [] },
        'SL.TP 4105',
        null,
      ),
      false,
    )
  })
})
