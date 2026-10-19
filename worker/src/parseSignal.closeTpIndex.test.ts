import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { DEFAULT_CHANNEL_KEYWORDS, parseChannelMessageSync } from './parseSignal'

test('CLOSE TP1 carries close_tp_index 1', () => {
  const result = parseChannelMessageSync('CLOSE TP1', DEFAULT_CHANNEL_KEYWORDS, null)
  assert.equal(result.parsed.action, 'partial_profit')
  assert.equal(result.parsed.close_tp_index, 1)
})

test('CLOSE TP3 carries close_tp_index 3', () => {
  const result = parseChannelMessageSync('CLOSE TP3', DEFAULT_CHANNEL_KEYWORDS, null)
  assert.equal(result.parsed.action, 'partial_profit')
  assert.equal(result.parsed.close_tp_index, 3)
})

test('plain partial close carries no close_tp_index', () => {
  const result = parseChannelMessageSync('CLOSE HALF', DEFAULT_CHANNEL_KEYWORDS, null)
  assert.equal(result.parsed.action, 'partial_profit')
  assert.equal(result.parsed.close_tp_index, undefined)
})
