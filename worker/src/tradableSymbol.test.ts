import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractTradableSymbolFromMessage,
  hasTradableInstrumentInText,
  isTradableInstrumentSymbol,
  sanitizeParsedSymbol,
} from './tradableSymbol'

test('rejects common English 6-letter words', () => {
  for (const word of ['JOINED', 'WEEKLY', 'FORGET', 'CLOSED', 'SIGNAL', 'PUBLIC', 'TRADER', 'TARGET']) {
    assert.equal(isTradableInstrumentSymbol(word), false)
    assert.equal(extractTradableSymbolFromMessage(`Please ${word} the channel`), null)
  }
})

test('accepts forex, crypto, metal, and index symbols', () => {
  assert.equal(extractTradableSymbolFromMessage('BUY EURUSD now'), 'EURUSD')
  assert.equal(extractTradableSymbolFromMessage('GOLD buy 2650'), 'XAUUSD')
  assert.equal(extractTradableSymbolFromMessage('BTCUSDT long'), 'BTCUSDT')
  assert.equal(extractTradableSymbolFromMessage('sell US30 sl 42000'), 'US30')
  assert.equal(extractTradableSymbolFromMessage('EUR/USD buy'), 'EURUSD')
})

test('hasTradableInstrumentInText does not match random 6-letter words', () => {
  assert.equal(hasTradableInstrumentInText('we joined weekly forget'), false)
  assert.equal(hasTradableInstrumentInText('buy eurusd sl 1.08'), true)
})

test('sanitizeParsedSymbol strips invalid model output', () => {
  assert.equal(sanitizeParsedSymbol('JOINED'), null)
  assert.equal(sanitizeParsedSymbol('eurusd'), 'EURUSD')
})
