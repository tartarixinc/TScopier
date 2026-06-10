import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  classifyPricesByDirection,
  detectReEnterIntent,
  extractUnlabeledPrices,
  parsedHasReEnterIntent,
} from './signalPriceInference'

test('detectReEnterIntent matches common spellings', () => {
  assert.equal(detectReEnterIntent('Gold re-enter sell now'), true)
  assert.equal(detectReEnterIntent('RE ENTER @ 4567'), true)
  assert.equal(detectReEnterIntent('reenter gold sell'), true)
  assert.equal(detectReEnterIntent('Gold sell now'), false)
})

test('parsedHasReEnterIntent reads flag and raw text', () => {
  assert.equal(parsedHasReEnterIntent({ re_enter: true }), true)
  assert.equal(parsedHasReEnterIntent({ raw_instruction: 're-enter sell' }), true)
  assert.equal(parsedHasReEnterIntent({ raw_instruction: 'sell now' }), false)
})

test('classifyPricesByDirection: sell with entry reference', () => {
  const { sl, tp } = classifyPricesByDirection('sell', 4567, [4557, 4527, 4577])
  assert.equal(sl, 4577)
  assert.deepEqual(tp, [4557, 4527])
})

test('classifyPricesByDirection: buy with entry reference', () => {
  const { sl, tp } = classifyPricesByDirection('buy', 100, [98, 95, 102])
  assert.equal(sl, 95)
  assert.deepEqual(tp, [102])
})

test('classifyPricesByDirection: sell without entry uses max as SL', () => {
  const { sl, tp } = classifyPricesByDirection('sell', null, [4557, 4527, 4577])
  assert.equal(sl, 4577)
  assert.deepEqual(tp, [4557, 4527])
})

test('classifyPricesByDirection: buy without entry uses min as SL', () => {
  const { sl, tp } = classifyPricesByDirection('buy', null, [98, 95, 102])
  assert.equal(sl, 95)
  assert.deepEqual(tp, [98, 102])
})

test('extractUnlabeledPrices skips labeled SL/TP/entry', () => {
  const msg = `Gold sell now
TP: 4557 / 4527
SL: 4577`
  const bare = extractUnlabeledPrices(msg)
  assert.deepEqual(bare, [])
})

test('extractUnlabeledPrices returns bare lines only', () => {
  const msg = `Gold Sell now:
4557 / 4527
4577`
  const bare = extractUnlabeledPrices(msg)
  assert.deepEqual(bare.sort((a, b) => b - a), [4577, 4557, 4527])
})

test('extractUnlabeledPrices skips parenthetical duplicate', () => {
  const msg = 'SL: 4577 (4577.10)'
  assert.deepEqual(extractUnlabeledPrices(msg), [])
})

test('extractUnlabeledPrices skips percentage values', () => {
  const msg = 'GOLD watches price rise of 5% from Monday'
  assert.deepEqual(extractUnlabeledPrices(msg), [])
})

test('extractUnlabeledPrices skips entry zone prices on sell now range', () => {
  const msg = `Gold sell now 4292 - 4295
SL: 4299
TP: 4290
TP: 4288`
  const bare = extractUnlabeledPrices(msg)
  assert.deepEqual(bare, [])
})

test('extractUnlabeledPrices skips bare calendar years in news prose', () => {
  const msg = 'Headline CPI highest level since April 2023 in May 2026 report'
  assert.deepEqual(extractUnlabeledPrices(msg), [])
})
