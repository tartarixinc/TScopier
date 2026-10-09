import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHANNEL_KEYWORDS, parseChannelMessageSync } from './parseSignal'
describe('combined SL.TP label', () => {
  it('reads SL.TP as a stop and keeps the take-profit ladder', () => {
    const msg = [
      'GOLD SELL NOW 4095',
      '',
      ' TP\u00b9 4090',
      ' TP\u00b2 4085',
      ' TP\u00b3 4080',
      ' TP\u2074 4075',
      ' TP\u2075 4070',
      ' TP\u2076 4065',
      ' ',
      ' SL.TP 4105',
      '',
      '100% Sure confirm signal ',
    ].join('\n')
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.equal(result.status, 'parsed', `skip=${result.skip_reason}`)
    assert.equal(result.parsed.action, 'sell')
    assert.equal(result.parsed.sl, 4105)
    assert.deepEqual(result.parsed.tp, [4090, 4085, 4080, 4075, 4070, 4065])
  })
  it('does not read "100% sure" as a take profit', () => {
    const msg = 'GOLD BUY NOW 4120\n\n TP1 4124\n SL 4098\n\n100% Sure confirm signal'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.deepEqual(result.parsed.tp, [4124])
    assert.equal(result.parsed.sl, 4098)
  })
})
describe('parenthesised stop and target labels', () => {
  it('reads "SL (4080)" and "TP\u00b9 (4095)"', () => {
    const msg = [
      '#XAUUSD-BUY NOW ( 4490 )',
      '',
      ' TP\u00b9 (4095)',
      ' TP\u00b2 (4100)',
      ' TP\u00b3 (4105)',
      ' TP\u2074 (4110)',
      ' TP\u2075 (4115)',
      ' TP\u2076 (4120)',
      '',
      ' SL (4080)',
    ].join('\n')
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.equal(result.status, 'parsed', `skip=${result.skip_reason}`)
    assert.equal(result.parsed.sl, 4080)
    assert.deepEqual(result.parsed.tp, [4095, 4100, 4105, 4110, 4115, 4120])
  })
  it('reads an arrow between the tier label and the parenthesised price', () => {
    const msg = 'GOLD BUY NOW 4120\n\nTP\u00b9 4124\nTP\u00b9 \u2197 (4126)\nSL 4098'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.ok((result.parsed.tp ?? []).includes(4126), `tp=${JSON.stringify(result.parsed.tp)}`)
  })
})
describe('control messages still parse the same way', () => {
  it('keeps a plain SL label and numbered ladder intact', () => {
    const msg = 'GOLD BUY NOW 4120 / TP\u00b9 4124 / TP\u00b2 4130 / TP\u00b3 4140 / SL 4098'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.equal(result.parsed.sl, 4098)
    assert.deepEqual(result.parsed.tp, [4124, 4130, 4140])
  })
  it('still reports no stop when the message states none', () => {
    const msg = 'GOLD SELL NOW 4095\n\n TP\u00b9 4090\n TP\u00b2 4085\n'
    const result = parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
    assert.equal(result.parsed.sl, null)
    assert.deepEqual(result.parsed.tp, [4090, 4085])
  })
})
