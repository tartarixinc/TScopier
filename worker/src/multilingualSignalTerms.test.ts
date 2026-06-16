import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPORTED_MARKET_NOW_BY_LOCALE,
  messageContainsKeyword,
  textHasCommonMarketNowIntent,
} from './multilingualSignalTerms'
import { messageHasMarketNowIntent } from './signalEntryNowRequirement'

describe('textHasCommonMarketNowIntent', () => {
  const samples: Array<{ locale: string; message: string }> = [
    { locale: 'en', message: 'Gold buy now' },
    { locale: 'en', message: 'BUY XAUUSD at market' },
    { locale: 'fr', message: '📈 SIGNAL OR (XAU/USD) – ACHAT IMMÉDIAT' },
    { locale: 'fr', message: 'ACHETER OR MAINTENANT' },
    { locale: 'es', message: 'COMPRA ORO AHORA' },
    { locale: 'es', message: 'VENTA XAUUSD INMEDIATO' },
    { locale: 'pl', message: 'KUP ZŁOTO TERAZ' },
    { locale: 'pl', message: 'SPRZEDAŻ GOLD NATYCHMIAST' },
    { locale: 'ru', message: 'КУПИТЬ ЗОЛОТО СЕЙЧАС' },
    { locale: 'ru', message: 'ПРОДАЖА XAUUSD НЕМЕДЛЕННО' },
    { locale: 'sv', message: 'KÖP GULD NU' },
    { locale: 'sv', message: 'SÄLJ GOLD OMEDELBART' },
    { locale: 'nl', message: 'KOOP GOUD NU' },
    { locale: 'nl', message: 'VERKOOP GOLD ONMIDDELLIJK' },
    { locale: 'ja', message: 'ゴールド買い 今すぐ' },
    { locale: 'ja', message: 'XAUUSD 成行' },
    { locale: 'de', message: 'GOLD KAUFEN JETZT' },
    { locale: 'ar', message: 'شراء الذهب الآن' },
  ]

  for (const { locale, message } of samples) {
    it(`detects market-now intent for ${locale}: ${message.slice(0, 40)}`, () => {
      assert.equal(textHasCommonMarketNowIntent(message), true, message)
      assert.equal(messageHasMarketNowIntent(message), true, message)
    })
  }

  it('does not flag market news headlines', () => {
    assert.equal(textHasCommonMarketNowIntent('Market News Update: Gold Plummets'), false)
    assert.equal(messageHasMarketNowIntent('Market News Update: Gold Plummets'), false)
  })

  it('matches accent variants via foldAccents', () => {
    assert.equal(messageContainsKeyword('ACHAT IMMEDIAT', 'immédiat'), true)
    assert.equal(messageContainsKeyword('ACHAT IMMÉDIAT', 'immediat'), true)
  })

  it('lists every supported UI locale in SUPPORTED_MARKET_NOW_BY_LOCALE', () => {
    for (const locale of ['en', 'es', 'fr', 'pl', 'ru', 'sv', 'nl', 'ja'] as const) {
      assert.ok(SUPPORTED_MARKET_NOW_BY_LOCALE[locale]?.length, locale)
    }
  })
})
