import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTelegramMessageText, normalizeSignalMessageForParse } from './normalizeTelegramMessageText'
import { parseChannelMessageSync, DEFAULT_CHANNEL_KEYWORDS } from './parseSignal'

describe('normalizeTelegramMessageText', () => {
  const plain = `XAUUSD BUY

SL: 4320

TP1 4340

TP2 4345

TP3 4350

TP4 4355

TP5 4360

Risk only 1-2% of your balance.`

  it('strips markdown italic underscores per line', () => {
    const italic = plain.split('\n').map(line => line.trim() ? `_${line}_` : '').join('\n')
    assert.equal(normalizeTelegramMessageText(italic), plain)
  })

  it('strips HTML italic tags', () => {
    const html = plain.split('\n').map(line => line.trim() ? `<i>${line}</i>` : '').join('\n')
    assert.equal(normalizeTelegramMessageText(html), plain)
  })

  it('allows italic-wrapped SIGNALS PRO template to parse as buy', () => {
    const italic = plain.split('\n').map(line => line.trim() ? `_${line}_` : '').join('\n')
    const result = parseChannelMessageSync(italic, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.equal(result.status, 'parsed')
    assert.equal(result.parsed.action, 'buy')
    assert.equal(result.parsed.symbol, 'XAUUSD')
    assert.equal(result.parsed.sl, 4320)
    assert.deepEqual(result.parsed.tp, [4340, 4345, 4350, 4355, 4360])
  })

  it('strips emoji glued to SL/TP/entry prices for parse', () => {
    const raw = `BUY 🟢4110-4120\nTP1 🎯4127\nSL ⛔️4104`
    const normalized = normalizeSignalMessageForParse(raw)
    assert.match(normalized, /BUY 4110-4120/)
    assert.match(normalized, /TP1 4127/)
    assert.match(normalized, /SL 4104/)
  })
})
