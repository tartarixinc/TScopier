import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  looksLikeCasualNonTradeMessage,
  looksLikeMarketNewsOrCommentary,
  looksLikeProfitResultCommentary,
  looksLikeTradeRecapCommentary,
} from './signalCommentaryGuard'
import {
  entryMissingSlTpRequiresNow,
  messageHasExplicitSlTpLabels,
  messageHasMarketNowIntent,
} from './signalEntryNowRequirement'

const FX_CULTURE_NEWS_FIXTURE = `📰 Market News Update: Gold Plummets 3% Toward as In-Line CPI Fails to Alter Fed's Hiking Path

📊 Gold Plunge & Key Tech Levels

- Gold (XAU/USD) collapsed over 3.0% on Wednesday, crashing to around $4,125 and carving out fresh 11-week lows.

🇺🇸 Inflation Acceleration vs. Monthly Easing

- The Bureau of Labor Statistics reported that headline CPI accelerated to 4.2% YoY in May (up from 3.8% in April), marking its highest level since April 2023.

- Core CPI edged higher to 2.9% YoY (vs. 2.8% previously), proving that underlying price stickiness is deeply entrenched.

🦅 CME FedWatch: Rate Hike Odds Solidify

- President Donald Trump warned via Truth Social that Iran had "taken too long to negotiate a deal" and would now "have to pay the price."

- This cocktail of permanent war premiums pushed the US Dollar Index (DXY) right back to its cyclical highs, forming an unbreakable ceiling over the bullion market.

🚀 Stay sharp, traders!`

describe('looksLikeMarketNewsOrCommentary', () => {
  it('detects FX Culture-style market news update with gold and CPI', () => {
    assert.equal(looksLikeMarketNewsOrCommentary(FX_CULTURE_NEWS_FIXTURE), true)
    assert.equal(looksLikeCasualNonTradeMessage(FX_CULTURE_NEWS_FIXTURE), true)
  })

  it('does not flag structured trade signals', () => {
    const signal = `#GOLD SHORT FROM RESISTANCE
✔️Trade Direction: short
✔️Entry Level: 4,572.25
✔️Target Level: 4,535.53
✔️Stop Loss: 4,590.01`
    assert.equal(looksLikeMarketNewsOrCommentary(signal), false)
  })

  it('does not flag Gold buy now', () => {
    assert.equal(looksLikeMarketNewsOrCommentary('Gold buy now'), false)
  })
})

describe('messageHasMarketNowIntent', () => {
  it('does not treat market news headline as market order intent', () => {
    assert.equal(messageHasMarketNowIntent('Market News Update: Gold Plummets'), false)
    assert.equal(messageHasMarketNowIntent('Gold buy now'), true)
    assert.equal(messageHasMarketNowIntent('Buy gold at market'), true)
  })
})

describe('looksLikeProfitResultCommentary', () => {
  const msg = `**INSANE RESULT** 🔥

**Darryl** from **the UK **🇬🇧 took my **GOLD BUY** from today and made** £1110** **PROFIT!** 💰

**Truly amazing to see ❤️**🔥`

  it('detects profit testimonial with gold buy mention', () => {
    assert.equal(looksLikeProfitResultCommentary(msg), true)
    assert.equal(looksLikeCasualNonTradeMessage(msg), true)
  })

  it('does not flag real signals with NOW and SL/TP', () => {
    const signal = 'GOLD BUY NOW 4532.7 SL: 4524.3 TP: 4535'
    assert.equal(looksLikeProfitResultCommentary(signal), false)
    assert.equal(looksLikeCasualNonTradeMessage(signal), false)
  })
})

describe('looksLikeTradeRecapCommentary', () => {
  it('detects FOMC post-trade lesson recap', () => {
    const msg = `After the FOMC news, I waited around 30 minutes before taking any position.
Gold started to show bullish structure, so I took the buy and caught around a 250 pips move higher.
The key lesson here: wait for confirmation, execute clean, manage risk.`
    assert.equal(looksLikeTradeRecapCommentary(msg), true)
    assert.equal(looksLikeCasualNonTradeMessage(msg), true)
  })

  it('does not flag FX Culture executable signal', () => {
    const signal = `BUY TRADE XAU/USD
4282.0-4287.0
Stop Loss: 4265
Target: 4365.0`
    assert.equal(looksLikeTradeRecapCommentary(signal), false)
  })
})

describe('entryMissingSlTpRequiresNow', () => {
  it('requires NOW when only inferred TP exists without labels', () => {
    assert.equal(
      entryMissingSlTpRequiresNow(
        { action: 'buy', sl: null, tp: [1110] },
        'GOLD BUY from today made £1110 profit',
      ),
      true,
    )
  })

  it('does not require NOW when explicit SL/TP labels are present', () => {
    assert.equal(
      entryMissingSlTpRequiresNow(
        { action: 'sell', sl: 2665, tp: [2640] },
        'SELL GOLD 2655\nSL 2665\nTP 2640',
      ),
      false,
    )
  })

  it('does not require NOW when market intent is present', () => {
    assert.equal(
      entryMissingSlTpRequiresNow({ action: 'buy', sl: null, tp: [] }, 'Gold buy now'),
      false,
    )
  })

  it('does not require NOW when parser extracted SL/TP from a multi-price signal (e.g. AI entry)', () => {
    assert.equal(
      entryMissingSlTpRequiresNow(
        { action: 'buy', sl: 2640, tp: [2670] },
        'COMPRA XAUUSD @ 2650 SL 2640 TP 2670',
      ),
      false,
    )
  })
})

describe('messageHasExplicitSlTpLabels', () => {
  it('matches labeled SL and TP lines', () => {
    assert.equal(messageHasExplicitSlTpLabels('SL 2665\nTP 2640'), true)
    assert.equal(messageHasExplicitSlTpLabels('TP: 4510'), true)
    assert.equal(messageHasExplicitSlTpLabels('made £1110 profit'), false)
  })
})
