import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CHANNEL_KEYWORDS,
  normalizeChannelKeywords,
  parseChannelMessageSync,
  type ChannelLexiconRow,
} from './parseSignal'
import { collapseForexBroBilingualMessage } from './forexBroSignalPatterns'

describe('parseChannelMessageSync', () => {
  const lexicon: ChannelLexiconRow | null = null

  it('parses minimal Gold buy now (SIGNALS 2 channel format)', () => {
    const msg = 'Gold buy now'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
  })

  it('parses Gold buy now with entry, SL and TP after channel edit pattern', () => {
    const msg = 'Gold buy now @ 4500\nSL 4490\nTP: 4510'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.sl, 4490)
    assert.deepEqual(result.parsed.tp, [4510])
  })

  it('parses Close all now management (SIGNALS 2 channel format)', () => {
    const msg = 'Close all now'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'close')
  })

  it('parses Delete sell limit as delete_pendings', () => {
    const result = parseChannelMessageSync('Delete sell limit', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'delete_pendings')
  })

  it('parses Trade invalid as delete_pendings', () => {
    const result = parseChannelMessageSync('Trade invalid', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'delete_pendings')
  })

  it('parses cancel limit as delete_pendings', () => {
    const result = parseChannelMessageSync('cancel limit', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'delete_pendings')
  })

  it('parses bare DELETE keyword as delete_pendings (not modify)', () => {
    const result = parseChannelMessageSync('DELETE', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'delete_pendings')
  })

  it('skips conditional close suggestion (if happy close now)', () => {
    const msg = 'If you are happy, close now'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('skips conditional close suggestion (close if satisfied)', () => {
    const msg = 'Close if you are satisfied'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('parses sell with TP. dot labels (SIGNALS 2 message 393 style)', () => {
    const msg = 'Gold sell now \nTP. 4066\nTP. 4060\nSL: 4080'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.sl, 4080)
    assert.deepEqual(result.parsed.tp, [4066, 4060])
  })

  it('parses sell with decimal TP price (must not treat 4053 as tier index)', () => {
    const msg = 'Sell Gold 4068.26-4075.88 ( high risk )\n\nSL 4082.22\n\nTP 4053.22'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.sl, 4082.22)
    assert.deepEqual(result.parsed.tp, [4053.22])
  })

  it('parses standard market entry (SIGNALS PRO / SIGNALS 2 style)', () => {
    const msg = 'BUY XAUUSD NOW SL 2650 TP 2700 TP 2750'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.sl, 2650)
  })

  it('parses sell with explicit entry anchor (Signal Tester style)', () => {
    const msg = 'SELL GOLD 2655\nSL 2665\nTP 2640'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
  })

  it('skips non-trade chat with no keyword match', () => {
    const msg = 'Good morning traders, market outlook for the week ahead.'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
    assert.match(result.skip_reason ?? '', /No matching channel keywords/i)
  })

  it('respects ignore_keyword on channel', () => {
    const keywords = {
      ...DEFAULT_CHANNEL_KEYWORDS,
      additional: {
        ...DEFAULT_CHANNEL_KEYWORDS.additional,
        ignore_keyword: 'OUTLOOK',
      },
    }
    const msg = 'WEEKLY OUTLOOK — stay flat today'
    const result = parseChannelMessageSync(msg, keywords, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.skip_reason, 'Non-trade message')
  })

  it('parses management breakeven reply', () => {
    const msg = 'Move SL to breakeven on XAUUSD'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'breakeven')
    assert.equal(result.parsed.symbol, 'XAUUSD')
  })

  it('parses stretched breakeven hype text', () => {
    const result = parseChannelMessageSync(
      'Set breakevennnnnnnn',
      DEFAULT_CHANNEL_KEYWORDS,
      lexicon,
    )
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'breakeven')
  })

  it('parses "SL to Entry" / "SL to BE" as breakeven with no symbol (not an entry)', () => {
    for (const msg of ['SL to Entry', 'SL to BE']) {
      const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
      assert.equal(result.status, 'parsed', msg)
      assert.equal(result.parsed.action, 'breakeven', msg)
      assert.equal(result.parsed.symbol, null, msg)
    }
  })

  it('parses Move SL to entry and close half as partial_breakeven with 50% fraction', () => {
    for (const msg of [
      'Move SL to entry and close half',
      'Move stop to entry and close half',
      'Close half and move SL to entry',
      'SL to entry and close half',
      'Move SL to breakeven and close half',
    ]) {
      const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
      assert.equal(result.status, 'parsed', msg)
      assert.equal(result.parsed.action, 'partial_breakeven', msg)
      assert.equal(result.parsed.partial_close_fraction, 0.5, msg)
    }
  })

  it('parses "Make SL 4155" / "Make SL to 4155" as modify with the new SL', () => {
    for (const msg of ['Make SL 4155', 'Make SL to 4155']) {
      const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
      assert.equal(result.status, 'parsed', msg)
      assert.equal(result.parsed.action, 'modify', msg)
      assert.equal(result.parsed.sl, 4155, msg)
    }
  })

  it('parses breakevennn noowwwww as breakeven', () => {
    const result = parseChannelMessageSync(
      'breakevennn noowwwww',
      DEFAULT_CHANNEL_KEYWORDS,
      lexicon,
    )
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'breakeven')
  })

  it('skips buy/sell without SL, TP, or NOW', () => {
    const msg = 'BUY XAUUSD @ 4500'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
    assert.match(result.skip_reason ?? '', /NOW/i)
  })

  it('parses entry without NOW when SL/TP present (parseEntryFromKeywords path)', () => {
    const msg = 'BUY EURUSD\nEntry 1.0850\nSL 1.0820\nTP 1.0900'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'EURUSD')
  })

  it('parses hash-numbered TP tiers (TP #1: / TP #2: format)', () => {
    const msg = `🔴 Sell XAUUSD @ 4567 

TP #1: 4564

TP #2: 4527

__

SL: 4577 (4577.10)`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_price, 4567)
    assert.equal(result.parsed.sl, 4577)
    assert.deepEqual(result.parsed.tp, [4564, 4527])
  })

  it('parses slash-separated TP label (TP: 4557 / 4527)', () => {
    const msg = `Gold Sell now:
TP: 4557 / 4527
SL: 4577`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.sl, 4577)
    assert.deepEqual(result.parsed.tp, [4557, 4527])
  })

  it('infers TP/SL from bare prices on sell now signal', () => {
    const msg = `Gold Sell now:
4557 / 4527
4577`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.sl, 4577)
    assert.deepEqual(result.parsed.tp, [4557, 4527])
  })

  it('parses follow-up sell with @ entry and numbered TPs', () => {
    const msg = `Gold sell now @ 4567
TP1: 4564
TP2: 4527
SL: 4577 (4577.10)`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.entry_price, 4567)
    assert.equal(result.parsed.sl, 4577)
    assert.deepEqual(result.parsed.tp, [4564, 4527])
  })

  it('parses "Take Profit 1/2/3" values as prices, not ordinal tiers', () => {
    const msg = `🔔🔔🔔 **NEW SIGNAL** 🔔🔔🔔

**XAUUSD SELL**

Entry Zone: 4518.00-4516.00
Stop loss: 4523.00
Take Profit 1: 4514.00
Take Profit 2: 4512.00
Take Profit 3: 4510.00`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.sl, 4523)
    assert.deepEqual(result.parsed.tp, [4514, 4512, 4510])
  })

  it('parses symbol-less parameter follow-up as modify', () => {
    const msg = `Entry price: 4567
TP1: 4564
TP2: 4527
SL: 4577 (4577.10)`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'modify')
    assert.equal(result.parsed.symbol, null)
    assert.equal(result.parsed.entry_price, 4567)
    assert.equal(result.parsed.sl, 4577)
    assert.deepEqual(result.parsed.tp, [4564, 4527])
  })

  it('parses re-enter sell with stops', () => {
    const msg = `Gold re-enter sell @ 4567
TP1: 4564
TP2: 4527
SL: 4577`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.re_enter, true)
    assert.equal(result.parsed.entry_price, 4567)
    assert.equal(result.parsed.sl, 4577)
    assert.deepEqual(result.parsed.tp, [4564, 4527])
  })

  it('parses gold sell now entry zone with SL, TPs, and TP open runner', () => {
    const msg = `Gold sell now 4292 - 4295

SL: 4299

TP: 4290
TP: 4288
TP: 4286
TP: open`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_zone_low, 4292)
    assert.equal(result.parsed.entry_zone_high, 4295)
    assert.equal(result.parsed.entry_price, null)
    assert.equal(result.parsed.sl, 4299)
    assert.deepEqual(result.parsed.tp, [4290, 4288, 4286])
    assert.equal(result.parsed.open_tp, true)
  })

  it('parses Stefan overlapping GOLD BUY setup posts as complete entries', () => {
    const signal3 = `GOLD BUY SETUP

Gold Buy Zone 4438 - 4433

SL : 4528

TP1 : 4443
TP2 : 4448
TP3 : 4453
TP4 : Hold`
    const signal4 = `GOLD BUY SETUP

Gold Buy Zone 4441 - 4436

SL : 4531

TP1 : 4446
TP2 : 4451
TP3 : 4456
TP4 : Hold`

    const parsed3 = parseChannelMessageSync(signal3, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    const parsed4 = parseChannelMessageSync(signal4, DEFAULT_CHANNEL_KEYWORDS, lexicon)

    for (const result of [parsed3, parsed4]) {
      assert.equal(result.status, 'parsed')
      assert.equal(result.parsed.action, 'buy')
      assert.equal(result.parsed.symbol, 'XAUUSD')
      assert.equal(result.parsed.entry_price, null)
    }
    assert.equal(parsed3.parsed.entry_zone_low, 4433)
    assert.equal(parsed3.parsed.entry_zone_high, 4438)
    assert.equal(parsed3.parsed.sl, 4528)
    assert.deepEqual(parsed3.parsed.tp, [4443, 4448, 4453])
    assert.equal(parsed4.parsed.entry_zone_low, 4436)
    assert.equal(parsed4.parsed.entry_zone_high, 4441)
    assert.equal(parsed4.parsed.sl, 4531)
    assert.deepEqual(parsed4.parsed.tp, [4446, 4451, 4456])
  })

  it('keeps genuine management messages as management, not entries', () => {
    const breakeven = parseChannelMessageSync('Move SL to breakeven', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(breakeven.status, 'parsed')
    assert.equal(breakeven.parsed.action, 'breakeven')

    const partial = parseChannelMessageSync('Close half and move SL to entry', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(partial.status, 'parsed')
    assert.equal(partial.parsed.action, 'partial_breakeven')
    assert.equal(partial.parsed.partial_close_fraction, 0.5)
  })

  it('parses GTMO VIP re-entry with custom channel keywords (tp: open must not flip sell)', () => {
    const gtmoKeywords = normalizeChannelKeywords({
      signal: {
        sl: 'sl: 4180',
        tp: 'tp: open|tp: 4467',
        buy: 'gold buy now',
        sell: 'gold sell now|tp: open|all tp‘s doneeeee',
        entry_point: 'gold buy now|gold sell now',
      },
      additional: { delimiters: '|', ai_signal_requires_price: true },
    })
    const msg = `Gold buy now re-entry 4213 - 4210

SL: 4207

TP: 4215
TP: 4217
TP: 4219
TP: open`
    const result = parseChannelMessageSync(msg, gtmoKeywords, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.re_enter, true)
    assert.equal(result.parsed.entry_zone_low, 4210)
    assert.equal(result.parsed.entry_zone_high, 4213)
    assert.equal(result.parsed.sl, 4207)
    assert.deepEqual(result.parsed.tp, [4215, 4217, 4219])
    assert.equal(result.parsed.open_tp, true)
  })

  it('parses gold buy now entry zone with decimal prices (GTMO VIP format)', () => {
    const msg = `Gold buy now 4465.2 - 4462

SL: 4458

TP: 4467
TP: 4469
TP: 4471
TP: open`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.entry_zone_low, 4462)
    assert.equal(result.parsed.entry_zone_high, 4465.2)
    assert.equal(result.parsed.sl, 4458)
    assert.deepEqual(result.parsed.tp, [4467, 4469, 4471])
    assert.equal(result.parsed.open_tp, true)
  })

  it('parses Trading Central partial close (secure 30% profits)', () => {
    const msg = `First take profit target is hit , which gives us +30 pips
Make sure to secure 30% profits by closing partial lotsize`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'partial_profit')
    assert.equal(result.parsed.partial_close_fraction, 0.3)
  })

  it('parses Trading Central breakeven suggestion', () => {
    const msg = '+50 pips running, you can move stop to breakeven.'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'breakeven')
  })

  it('parses adjust SL with pip note and explicit target', () => {
    const msg = 'Adjust SL + 20 pips for now to 4505.'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'modify')
    assert.equal(result.parsed.sl, 4505)
  })

  it('parses stop-loss adjust phrasing variants (risk, stop loss, stoploss)', () => {
    const cases = [
      'Adjust Risk to 4505',
      'Adjust Stop Loss to 4505',
      'Adjust Stoploss to 4505',
      'Adjust SL + 15pips to 4505',
      'Move risk to 4505',
      'Change stop loss to 4505',
      'Update stoploss to 4505',
      'Set risk to 4505',
    ]
    for (const msg of cases) {
      const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
      assert.equal(result.status, 'parsed', msg)
      assert.equal(result.parsed.action, 'modify', msg)
      assert.equal(result.parsed.sl, 4505, msg)
    }
  })

  it('skips commentary "short of TP2" chatter with gold mention', () => {
    const msg = 'Hmmmm 6 pips short of TP2.... Funny you gold. Funny you.'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('does not parse bare TP tier references as executable targets', () => {
    const msg = 'Gold is close to TP2 now'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('does not close on prose "close to our entry"', () => {
    const msg = `Beforehand? Yes... beforehand.
You receive signals in here once a day, for free, randomly timed.
My private community, receives more trades, for free as well, but receive it before price is even close to our entry`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.notEqual(result.parsed.action, 'close')
  })

  it('parses GOLD short signal with comma thousands in prices', () => {
    const msg = `#GOLD SHORT FROM RESISTANCE🔴

📉GOLD SIGNAL

✔️Trade Direction: short 
✔️Entry Level: 4,572.25
✔️Target Level: 4,535.53
✔️Stop Loss: 4,590.01

⭐️Risk level: medium 
⭐️Suggested risk: 1% 
⭐️Timeframe: 1h`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_price, 4572.25)
    assert.equal(result.parsed.sl, 4590.01)
    assert.deepEqual(result.parsed.tp, [4535.53])
  })

  it('skips profit testimonial that mentions past gold buy', () => {
    const msg = `**INSANE RESULT** 🔥

**Darryl** from **the UK **🇬🇧 took my **GOLD BUY** from today and made** £1110** **PROFIT!** 💰

**Truly amazing to see ❤️**🔥`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('skips weekend watch commentary with gold and colloquial buy', () => {
    const msg = `Before I leave you for the weekend... a bit of insider scoop

Major watch brands (Patek/Rolex etc) have just announced a surprise price rise on only GOLD watches of 5% from Monday.

They buy. We buy.

Have a great weekend.`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('skips FX Culture-style market news update with gold and CPI prose', () => {
    const msg = `📰 Market News Update: Gold Plummets 3% Toward as In-Line CPI Fails to Alter Fed's Hiking Path

📊 Gold Plunge & Key Tech Levels

- Gold (XAU/USD) collapsed over 3.0% on Wednesday, crashing to around $4,125 and carving out fresh 11-week lows.

- The Bureau of Labor Statistics reported that headline CPI accelerated to 4.2% YoY in May, marking its highest level since April 2023.

- President Donald Trump warned that Iran had "taken too long to negotiate a deal" and would now "have to pay the price."

- This pushed the US Dollar Index (DXY) right back to its cyclical highs over the bullion market.

🚀 Stay sharp, traders!`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('does not parse too long to negotiate as buy side without trade structure', () => {
    const msg = 'Gold discussion: Iran had taken too long to negotiate a deal over the bullion market.'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('parses trained non-English cues via channel keywords and lexicon aliases', () => {
    const trainedKeywords = {
      ...DEFAULT_CHANNEL_KEYWORDS,
      signal: {
        ...DEFAULT_CHANNEL_KEYWORDS.signal,
        buy: 'ACHETER',
        sell: 'VENDRE',
        sl: 'STOP',
        tp: 'OBJECTIF',
        entry_point: 'ENTRÉE|ENTRY',
      },
    }
    const trainedLexicon: ChannelLexiconRow = {
      user_id: 'u1',
      channel_id: 'c1',
      action_aliases: null,
      tp_aliases: ['objectif', 'cible'],
      target_aliases: ['cible'],
      unknown_tokens: null,
    }
    const msg = 'ACHETER GOLD ENTRÉE 4500 STOP 4488 OBJECTIF 4520'
    const result = parseChannelMessageSync(msg, trainedKeywords, trainedLexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_price, 4500)
    assert.equal(result.parsed.sl, 4488)
    assert.deepEqual(result.parsed.tp, [4520])
  })

  it('parses BTC/ETH channel template: SYMBOL BUY, ENTRY zone slash, SL, TPn without colon', () => {
    const msg = `XAUUSD BUY

ENTRY: 4335 / 4325

SL: 4320

TP1 4340

TP2 4345

TP3 4350

TP4 4355

TP5 4360

Risk only 1-2% of your balance.`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_price, null)
    assert.equal(result.parsed.entry_zone_low, 4325)
    assert.equal(result.parsed.entry_zone_high, 4335)
    assert.equal(result.parsed.sl, 4320)
    assert.deepEqual(result.parsed.tp, [4340, 4345, 4350, 4355, 4360])
  })

  it('parses Apex-style activated gold sell with underscore zone and RRR line', () => {
    const msg = `➖➖➖➖➖➖➖➖➖➖
   🥇sell (GOLD) XAUUSD
➖➖➖➖➖➖➖➖➖➖
✅Trade Activated From 4350_4360

✅TP1: 4320
✅TP2: 4315
✅TP3: 4310
✅TP4: 4305

🙋 SL (STOP LOSS): 4325
RRR(Risk To Reward Ratio) 1:3+

Action Plan:
Stay Calm, Trust The Setup, And keep Holding Your Trades—Momentum is in Our Favor!`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_zone_low, 4350)
    assert.equal(result.parsed.entry_zone_high, 4360)
    assert.equal(result.parsed.sl, 4325)
    assert.deepEqual(result.parsed.tp, [4320, 4315, 4310, 4305])
  })

  it('parses NEW TRADE IDEA template: SYMBOL BUY price, TP n tiers, SL @ price', () => {
    const msg = `NEW TRADE IDEA

XAUUSD BUY 4082

TP 1 4086
TP 2 4087
TP 3 4120

SL @ 4055

Trade accordingly and only trade with money you can afford to LOSE.

USE DOUBLE LOTSIZE`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_price, 4082)
    assert.equal(result.parsed.sl, 4055)
    assert.deepEqual(result.parsed.tp, [4086, 4087, 4120])
    assert.equal(result.parsed.tp_unit, 'price')
  })

  it('parses ENTRY zone slash template without SL line when TP tiers are space-separated', () => {
    const msg = `XAUUSD BUY

ENTRY: 4335 / 4325

TP1 4340

TP2 4345`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.entry_zone_low, 4325)
    assert.equal(result.parsed.entry_zone_high, 4335)
    assert.deepEqual(result.parsed.tp, [4340, 4345])
  })

  it('parses Spanish COMPRA with configured channel keywords', () => {
    const keywords = {
      ...DEFAULT_CHANNEL_KEYWORDS,
      signal: {
        ...DEFAULT_CHANNEL_KEYWORDS.signal,
        buy: 'COMPRA|COMPRAR',
        sell: 'VENTA|VENDER',
      },
    }
    const msg = 'COMPRA XAUUSD @ 2650 SL 2640 TP 2670'
    const result = parseChannelMessageSync(msg, keywords, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.sl, 2640)
    assert.deepEqual(result.parsed.tp, [2670])
  })

  it('parses Russian sell via lexicon action_aliases', () => {
    const msg = 'ПРОДАЖА EURUSD SL 1.0950 TP 1.0900'
    const ruLexicon: ChannelLexiconRow = {
      user_id: 'u',
      channel_id: 'c',
      action_aliases: { buy: [], sell: ['продажа', 'продать'], modify: [] },
    }
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, ruLexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'EURUSD')
  })

  it('parses Polish KUPNO with channel buy keyword', () => {
    const keywords = {
      ...DEFAULT_CHANNEL_KEYWORDS,
      signal: { ...DEFAULT_CHANNEL_KEYWORDS.signal, buy: 'KUPNO|KUPIC' },
    }
    const msg = 'KUPNO GOLD SL 2650 TP 2700'
    const result = parseChannelMessageSync(msg, keywords, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
  })

  it('parses French ACHAT IMMÉDIAT gold teaser without channel training', () => {
    const msg = '📈 SIGNAL OR (XAU/USD) – ACHAT IMMÉDIAT'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.sl, null)
    assert.deepEqual(result.parsed.tp, [])
  })

  it('parses French FERMEZ TOUT MAINTENANT as close all', () => {
    const msg = 'FERMEZ TOUT MAINTENANT'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'close')
  })

  it('parses FERMEZ TOUT when trained on channel close_all keywords', () => {
    const keywords = {
      ...DEFAULT_CHANNEL_KEYWORDS,
      additional: {
        ...DEFAULT_CHANNEL_KEYWORDS.additional,
        close_all: 'FERMEZ TOUT|FERMER TOUT',
        ai_management_keyword_groups: {
          close_all: ['FERMEZ TOUT', 'FERMER TOUT'],
          close_partial: [],
          close_half: [],
          break_even: [],
          modify_sl: [],
          modify_tp: [],
          close_worse_entries: [],
        },
      },
      update: {
        ...DEFAULT_CHANNEL_KEYWORDS.update,
        close_full: 'FERMEZ TOUT|FERMER TOUT',
      },
    }
    const result = parseChannelMessageSync('FERMEZ TOUT MAINTENANT', keywords, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'close')
  })

  it('parses FX Culture BUY TRADE with bare entry zone line and SL/TP', () => {
    const msg = `BUY TRADE XAU/USD 

4282.0-4287.0


📍Stop Loss: 4265

Target: 4365.0`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_zone_low, 4282)
    assert.equal(result.parsed.entry_zone_high, 4287)
    assert.equal(result.parsed.sl, 4265)
    assert.deepEqual(result.parsed.tp, [4365])
  })

  it('skips FX Culture FOMC trade recap commentary', () => {
    const msg = `After the FOMC news, I waited around 30 minutes before taking any position.

Gold started to show bullish structure after the initial move, so I took the buy and caught around a $25 /250 pips move higher.

The key lesson here: wait for confirmation, execute clean, manage risk.`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('skips GTMO VIP retrospective buy Q&A commentary', () => {
    const msg =
      'Did you guys manage this buy quick enough? It was actually not a bad entry, a very strong support zone but fundementals to bearish for gold right now.'
    const gtmoKeywords = normalizeChannelKeywords({
      signal: {
        sl: 'sl: 4180',
        tp: 'tp: open|tp: 4467',
        buy: 'gold buy now',
        sell: 'gold sell now|tp: open|all tp‘s doneeeee',
        entry_point: 'gold buy now|gold sell now',
      },
      additional: { delimiters: '|', ai_signal_requires_price: true },
    })
    for (const keywords of [DEFAULT_CHANNEL_KEYWORDS, gtmoKeywords]) {
      const result = parseChannelMessageSync(msg, keywords, lexicon)
      assert.equal(result.status, 'skipped', `keywords delimiters=${keywords.additional.delimiters}`)
      assert.equal(result.parsed.action, 'ignore')
    }
  })

  it('skips soft entry discussion without treating prose entry as price evidence', () => {
    const msg = 'It was actually not a bad entry on gold, strong support but fundamentals look bearish right now.'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('still parses Gold buy now after commentary guard', () => {
    const result = parseChannelMessageSync('Gold buy now', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
  })

  it('parses AUD-NZD sell with VIP footer Gold promo without misreading XAUUSD', () => {
    const msg = `📉AUD-NZD Free Signal!

⭕Sell!
—
#AUDNZD rejection from the horizontal supply area signals bearish continuation.
------------------
🟢Stop Loss: 1.2074
🟢Take Profit: 1.2034
🟢Entry: 1.2057
🟢Time Frame: 5H
----------------—
Sell!🔽
➖➖➖➖➖➖➖➖➖➖
VIP MEMBERS GET
Forex, Gold, Oil signals`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'AUDNZD')
    assert.equal(result.parsed.sl, 1.2074)
    assert.deepEqual(result.parsed.tp, [1.2034])
    assert.equal(result.parsed.entry_price, 1.2057)
  })

  it('parses FOREX KING Gold buy with emoji-glued entry zone, SL, and TP tiers', () => {
    const msg = `Gold（XAUUSD）📊
BUY 🟢4110-4120

TP1 🎯4127
TP2 🎯4130
TP3 🎯4135

SL ⛔️4104`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_zone_low, 4110)
    assert.equal(result.parsed.entry_zone_high, 4120)
    assert.equal(result.parsed.sl, 4104)
    assert.deepEqual(result.parsed.tp, [4127, 4130, 4135])
  })

  it('parses ForexBro New Signal entry even when disclaimer is misconfigured as set_sl keyword', () => {
    const disclaimer = 'اضبط مخاطرتك وراقب الصفقة. حين يحصل ربح وتكتفي به لست ملزماً بالبقاء حتى نهايتها.'
    const keywords = normalizeChannelKeywords({
      signal: {
        sl: 'وقف الخسارة|sl',
        tp: 'الهدف الأول|tp1|الهدف الثاني|tp2|الهدف الثالث|tp3',
        buy: 'شراء|buy|🟢',
        sell: 'بيع|sell|🔴',
        entry_point: 'منطقة الدخول|entry zone',
        market_order: 'now',
      },
      update: {
        set_sl: disclaimer,
        adjust_sl: disclaimer,
      },
      additional: {
        close_all: '',
        ai_management_keyword_groups: {
          modify_sl: [disclaimer],
          modify_tp: [],
          break_even: [],
          close_half: [],
          close_partial: [],
          close_worse_entries: [],
          close_all: [],
        },
      },
    })
    const msg = `New Signal #898 🟢 📊
Market: AUDUSD · BUY
📍 Entry Zone: 0.68873 – 0.68887
🎯 TP1: 0.68940
🎯 TP2: 0.69047
🎯 TP3: 0.69186
🛑 SL: 0.68741

ℹ ملاحظة: ${disclaimer}`
    const result = parseChannelMessageSync(msg, keywords, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'AUDUSD')
    assert.equal(result.parsed.entry_zone_low, 0.68873)
    assert.equal(result.parsed.entry_zone_high, 0.68887)
    assert.equal(result.parsed.sl, 0.68741)
    assert.deepEqual(result.parsed.tp, [0.6894, 0.69047, 0.69186])
  })

  const forexBroPollutedKeywords = () => normalizeChannelKeywords({
    signal: {
      sl: 'وقف الخسارة|sl',
      tp: 'tp1|tp2|tp3',
      buy: 'buy|شراء',
      sell: 'sell|بيع',
      entry_point: 'entry zone|منطقة الدخول',
      market_order: 'now',
    },
    update: {
      set_sl: 'manage your risk and watch closely|اضبط مخاطرتك وراقب الصفقة',
      adjust_sl: 'manage your risk and watch closely|اضبط مخاطرتك وراقب الصفقة',
    },
    additional: { close_all: '' },
  })

  it('parses ForexBro TP1 done + SL trail as modify with provider_signal_number', () => {
    const msg = `🟢 Signal #899 📊
✅ TP1 : Done ✅
📈 +8.8 pips
✋ Important: modify your stop-loss to 0.69211 now to secure the trade.`
    const result = parseChannelMessageSync(msg, forexBroPollutedKeywords(), lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'modify')
    assert.equal(result.parsed.sl, 0.69211)
    assert.equal(result.parsed.provider_signal_number, 899)
  })

  it('skips ForexBro TP3 complete notice as non-actionable', () => {
    const msg = `🟢 Signal #898 📊
🏆 TP3 : Done 🏆
📈 +30.6 pips
Note: all targets of this trade were achieved successfully.`
    const result = parseChannelMessageSync(msg, forexBroPollutedKeywords(), lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
    assert.match(result.skip_reason ?? '', /TP complete notice/i)
  })

  it('parses ForexBro Lock-Profit alert as breakeven at entry price (not signal #)', () => {
    const msg = `🟢 Signal #898 📊
🛡️ Lock-Profit Alert 🛡️
move your Stop-Loss to your Entry price (0.6888) (break-even) now`
    const result = parseChannelMessageSync(msg, forexBroPollutedKeywords(), lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'breakeven')
    assert.equal(result.parsed.sl, 0.6888)
    assert.notEqual(result.parsed.sl, 898)
  })

  it('skips ForexBro post-facto breakeven narrative', () => {
    const msg = `🟢 Signal #896 📊
🛡️ Break-Even — No Loss 🛡️
After the Lock-Profit alert, your stop-loss was moved to your entry price. Price came back to entry, so the trade closed at break-even with ZERO loss.`
    const result = parseChannelMessageSync(msg, forexBroPollutedKeywords(), lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
    assert.match(result.skip_reason ?? '', /Post-facto breakeven/i)
  })

  it('parses bilingual ForexBro New Signal #900 as a single buy entry', () => {
    const msg = `New Signal #900 🟢 📊
Market: XPTUSD · BUY
📍 Entry Zone: 1616.79 – 1618.51
🎯 TP1: 1629.15
🎯 TP2: 1640.65
🎯 TP3: 1658.65
🛑 SL: 1594.65
Type: Short term

ℹ️ Note: Manage your risk and watch closely — once you're satisfied with the profit, you're not bound to hold to the end.

━━━━━━━━━━━━━━━

صفقة حديثة #900 🟢 📊
السوق: XPTUSD · شراء
📍 منطقة الدخول: ‏1616.79 – 1618.51
🎯 الهدف الأول TP1: ‏1629.15
🎯 الهدف الثاني TP2: ‏1640.65
🎯 الهدف الثالث TP3: ‏1658.65
🛑 وقف الخسارة SL: ‏1594.65
النوع: قصيرة المدى`
    const result = parseChannelMessageSync(msg, forexBroPollutedKeywords(), lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XPTUSD')
    assert.equal(result.parsed.provider_signal_number, 900)
    assert.equal(result.parsed.entry_zone_low, 1616.79)
    assert.equal(result.parsed.entry_zone_high, 1618.51)
    assert.equal(result.parsed.sl, 1594.65)
    assert.deepEqual(result.parsed.tp, [1629.15, 1640.65, 1658.65])
  })

  it('parses ForexBro New Signal #901 QQQ stock entry', () => {
    const msg = `New Signal #901 🟢 📊
Market: QQQ · BUY
📍 Entry Zone: 729.67 – 729.89
🎯 TP1: 731.97
🎯 TP2: 733.27
🎯 TP3: 735.57
🛑 SL: 725.41`
    const result = parseChannelMessageSync(msg, forexBroPollutedKeywords(), lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'QQQ')
    assert.equal(result.parsed.entry_zone_low, 729.67)
    assert.equal(result.parsed.entry_zone_high, 729.89)
    assert.equal(result.parsed.sl, 725.41)
    assert.deepEqual(result.parsed.tp, [731.97, 733.27, 735.57])
  })
})

describe('collapseForexBroBilingualMessage', () => {
  it('keeps only the English block when EN and AR share the same signal number', () => {
    const msg = `New Signal #900
Market: XPTUSD · BUY
━━━━━━━━━━━━━━━
صفقة حديثة #900
السوق: XPTUSD · شراء`
    const collapsed = collapseForexBroBilingualMessage(msg)
    assert.match(collapsed, /New Signal #900/i)
    assert.doesNotMatch(collapsed, /صفقة حديثة/)
  })

  it('returns original text when only one language is present', () => {
    const enOnly = 'New Signal #901\nMarket: EURUSD · BUY'
    assert.equal(collapseForexBroBilingualMessage(enOnly), enOnly)
    const arOnly = 'صفقة حديثة #902\nالسوق: GBPUSD · شراء'
    assert.equal(collapseForexBroBilingualMessage(arOnly), arOnly)
  })

  it('does not collapse when English and Arabic signal numbers differ', () => {
    const msg = `New Signal #900
━━━━━━━━━━━━━━━
صفقة حديثة #901`
    assert.equal(collapseForexBroBilingualMessage(msg), msg)
  })
})

describe('prose selling/buying commentary', () => {
  const lexicon: ChannelLexiconRow | null = null

  const gtmoCommentary = `This push upwards, (retracement) is exactly the one I was gonna go for today morning, and then after this we would've sold.

But gold has played and moved it own way, not making it easy for retail traders, 

This trade we right now in, selling gold, has a high potential of a very big drop. Let's see if the bears can pressure enough to make gold stop going further up.`

  it('skips GTMO position commentary selling gold', () => {
    const result = parseChannelMessageSync(gtmoCommentary, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'skipped')
    assert.equal(result.parsed.action, 'ignore')
  })

  it('does not parse bare selling gold prose as sell entry', () => {
    const result = parseChannelMessageSync(
      'We are selling gold here, expecting a drop',
      DEFAULT_CHANNEL_KEYWORDS,
      lexicon,
    )
    assert.equal(result.parsed.action, 'ignore')
  })

  it('parses Arabic-only gold buy with entry zone, SL, and TP tiers via common terms', () => {
    const msg = `📊 XAUUSD
شراء 🟢
منطقة الدخول: 2650 - 2655
وقف الخسارة: 2640
الهدف الأول: 2670
الهدف الثاني: 2680
الهدف الثالث: 2690`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_zone_low, 2650)
    assert.equal(result.parsed.entry_zone_high, 2655)
    assert.equal(result.parsed.sl, 2640)
    assert.deepEqual(result.parsed.tp, [2670, 2680, 2690])
  })

  it('parses Arabic sell now market entry', () => {
    const msg = 'بيع XAUUSD الآن'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
  })

  it('parses ENTRY shorthand zone 4061-59 as 4059-4061', () => {
    const msg = `XAUUSD BUY

ENTRY 4061-59
SL 4044
TP 4066`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.entry_zone_low, 4059)
    assert.equal(result.parsed.entry_zone_high, 4061)
    assert.equal(result.parsed.sl, 4044)
  })

  it('parses Sl_/@4046 and superscript TP tiers', () => {
    const msg = `XAUUSD BUY 4057/4054

Sl_/@4046

TP¹4060
TP²4064`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.sl, 4046)
    assert.deepEqual(result.parsed.tp, [4060, 4064])
    assert.equal(result.parsed.entry_zone_low, 4054)
    assert.equal(result.parsed.entry_zone_high, 4057)
  })

  it('parses bullet Signal: Buy with XAUUSD/GOLD header', () => {
    const msg = `XAUUSD/GOLD

• Signal: Buy
• Entry: 4077
• Take Profit: 4087
• Stop Loss: 4067`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.entry_price, 4077)
    assert.equal(result.parsed.sl, 4067)
    assert.deepEqual(result.parsed.tp, [4087])
  })

  it('parses XAUUSD SELL entry range with Sl_/@ and six superscript TPs', () => {
    const msg = `XAUUSD SELL 4030/4033

Sl_/@4043

TP¹4027
TP²4024
TP³4020
TP⁴4017
TP⁵4014
TP⁶4005`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.entry_zone_low, 4030)
    assert.equal(result.parsed.entry_zone_high, 4033)
    assert.equal(result.parsed.sl, 4043)
    assert.deepEqual(result.parsed.tp, [4027, 4024, 4020, 4017, 4014, 4005])
  })

  it('parses XAUUSD SELL: 4074/4077 without matching Risk pip range', () => {
    const msg = `XAUUSD SELL: 4074/4077
SL: 4085 | Risk: 80-110 Pips
TP1: 4070`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.entry_zone_low, 4074)
    assert.equal(result.parsed.entry_zone_high, 4077)
    assert.equal(result.parsed.sl, 4085)
  })

  it('parses XAUUSD_BUY entry zone with underscore-glued side', () => {
    const msg = 'XAUUSD_BUY 4143/4144'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_zone_low, 4143)
    assert.equal(result.parsed.entry_zone_high, 4144)
  })

  it('parses SELL_XAUUSD entry zone with underscore-glued side prefix', () => {
    const msg = 'SELL_XAUUSD 4143/4144'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_zone_low, 4143)
    assert.equal(result.parsed.entry_zone_high, 4144)
  })

  it('parses dot-leader Sell/Sl/Tp lines (GOLD VIP channel format)', () => {
    const msg = `#XAUUSD

Sell.........4080
Sl.............4090
Tp............4071
Tp2...........4040`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.sl, 4090)
    assert.ok(result.parsed.tp?.includes(4071))
    assert.ok(result.parsed.tp?.includes(4040))
    assert.equal(result.parsed.entry_price, 4080)
  })

  it('treats PRICE: as explicit entry for BUY LIMIT pending signals', () => {
    const msg = `PAIR: XAUUSD
BIAS: BUY 
ORDER TYPE: BUY LIMIT

PRICE: 4256.00

SL:     4238.74

TP1 : 4276.29
TP2 : 4296.57
TP3 : 4316.86
TP4 : 4337.15

APPLY PROPER RISK MANAGEMENT ALWAYS!`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_price, 4256)
    assert.equal(result.parsed.sl, 4238.74)
    assert.ok(result.parsed.tp?.includes(4276.29))
    assert.ok(result.parsed.tp?.includes(4337.15))
  })

  it('parses single-price ENTRY ZONE (incident 4e530999 format)', () => {
    const msg = `🟢 BUY: XAU/USD

📍 ENTRY ZONE: 4358

🎯 TP1: 4368 (+100 pips)
🎯 TP2: 4378 (+200 pips)
🎯 TP3: 4388 (+300 pips)
🎯 FINAL TP: Open

🛑 SL: 4348 (-100 pips )`
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.entry_price, 4358)
    assert.equal(result.parsed.sl, 4348)
    assert.deepEqual(result.parsed.tp, [4368, 4378, 4388])
  })

  it('parses ENTRY ZONE slash range as a zone, not a single price', () => {
    const msg = 'BUY XAUUSD\nENTRY ZONE: 4358 / 4360\nSL: 4348\nTP: 4370'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.entry_price, null)
    assert.equal(result.parsed.entry_zone_low, 4358)
    assert.equal(result.parsed.entry_zone_high, 4360)
  })

  it('does not read a numbered TP/SL @ separator as the entry price', () => {
    for (const msg of [
      'GOLD SELL NOW\nTP1 @ 4256\nSL @ 4276',
      'GOLD SELL NOW\nTP 1 @ 4256\nSL @ 4276',
      'GOLD SELL NOW\nTP(1) @ 4256\nSL @ 4276',
      'GOLD SELL NOW\nTP1: @ 4256\nSL @ 4276',
      'GOLD SELL NOW\nTP#1 @ 4256\nSL @ 4276',
      'GOLD SELL NOW\nTake Profit 1 @ 4256\nSL @ 4276',
    ]) {
      const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, lexicon)
      assert.equal(result.status, 'parsed')
      assert.equal(result.parsed.entry_price, null, `entry should be null for: ${msg}`)
    }
    const ok = parseChannelMessageSync('BUY XAUUSD @ 4358\nSL 4348\nTP 4370', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(ok.parsed.entry_price, 4358)
  })

  it('reads an entry written as "Entry Target @price"', () => {
    const result = parseChannelMessageSync('BUY XAUUSD\nEntry Target @4235\nSL 4210', DEFAULT_CHANNEL_KEYWORDS, lexicon)
    assert.equal(result.parsed.entry_price, 4235)
    assert.equal(result.parsed.sl, 4210)
  })
})
