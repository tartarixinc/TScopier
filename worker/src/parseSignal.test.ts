import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CHANNEL_KEYWORDS,
  normalizeChannelKeywords,
  parseChannelMessageSync,
  type ChannelLexiconRow,
} from './parseSignal'

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
})
