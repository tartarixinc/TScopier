import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHANNEL_KEYWORDS } from './parseSignal'
import {
  collectChannelSignalAliases,
  looksLikeTradingSignal,
  looksLikeTrainingCandidate,
} from './signalTradingHeuristic'

describe('signalTradingHeuristic', () => {
  const spanishKeywords = {
    ...DEFAULT_CHANNEL_KEYWORDS,
    signal: {
      ...DEFAULT_CHANNEL_KEYWORDS.signal,
      buy: 'COMPRA|COMPRAR',
      sell: 'VENTA|VENDER',
      sl: 'SL|STOP',
      tp: 'TP|OBJETIVO',
    },
  }

  it('passes Spanish entry with channel keywords', () => {
    const msg = 'COMPRA XAUUSD @ 2650 SL 2640 TP 2670'
    const ctx = { keywords: spanishKeywords, lexicon: null }
    assert.equal(looksLikeTradingSignal(msg, false, ctx), true)
    assert.ok(collectChannelSignalAliases(ctx).includes('COMPRA'))
  })

  it('passes Russian sell with lexicon action aliases', () => {
    const msg = 'ПРОДАЖА EURUSD SL 1.0950 TP 1.0900'
    const ctx = {
      keywords: DEFAULT_CHANNEL_KEYWORDS,
      lexicon: {
        user_id: 'u',
        channel_id: 'c',
        action_aliases: { buy: [], sell: ['продажа', 'продать'], modify: [] },
      },
    }
    assert.equal(looksLikeTradingSignal(msg, false, ctx), true)
  })

  it('passes Polish via instrument + price without English keywords', () => {
    const msg = 'KUPNO GOLD SL 2650 TP 2700'
    const ctx = {
      keywords: {
        ...DEFAULT_CHANNEL_KEYWORDS,
        signal: { ...DEFAULT_CHANNEL_KEYWORDS.signal, buy: 'KUPNO|KUPIC' },
      },
      lexicon: null,
    }
    assert.equal(looksLikeTradingSignal(msg, false, ctx), true)
  })

  it('training candidate accepts instrument + price without direction words', () => {
    const msg = 'XAUUSD 2650 2640 2670'
    assert.equal(looksLikeTrainingCandidate(msg), true)
  })

  it('rejects casual chat without trade structure', () => {
    const msg = 'Good morning traders, enjoy your weekend!'
    assert.equal(looksLikeTradingSignal(msg, false, null), false)
  })
})
