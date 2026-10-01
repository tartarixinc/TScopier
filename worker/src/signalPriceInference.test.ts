import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  classifyPricesByDirection,
  detectReEnterIntent,
  extractBarePriceRangeZone,
  extractUnlabeledPrices,
  normalizeEntryZonePair,
  parsedHasReEnterIntent,
} from './signalPriceInference'

test('detectReEnterIntent matches common spellings', () => {
  assert.equal(detectReEnterIntent('Gold re-enter sell now'), true)
  assert.equal(detectReEnterIntent('Gold buy now re-entry 4213 - 4210'), true)
  assert.equal(detectReEnterIntent('RE ENTER @ 4567'), true)
  assert.equal(detectReEnterIntent('reenter gold sell'), true)
  assert.equal(detectReEnterIntent('Gold sell now'), false)
})

test('parsedHasReEnterIntent reads flag and raw text', () => {
  assert.equal(parsedHasReEnterIntent({ re_enter: true }), true)
  assert.equal(parsedHasReEnterIntent({ raw_instruction: 're-enter sell' }), true)
  assert.equal(parsedHasReEnterIntent({ raw_instruction: 'Gold buy now re-entry 4213' }), true)
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

test('extractUnlabeledPrices skips order identity numbers (ID / Order / Ticket)', () => {
  assert.deepEqual(
    extractUnlabeledPrices([
      'Type : New Order',
      'ID : 719904880',
      'Order : Buy',
      'Entry Price : 4175.41',
      'Stop Loss : 0.00',
      'Take Profit : 0.00',
    ].join('\n')),
    [],
  )
  assert.deepEqual(
    extractUnlabeledPrices('Ticket #481670416 opened at market'),
    [],
  )
  assert.deepEqual(extractUnlabeledPrices('Order : 4176'), [])
  assert.deepEqual(extractUnlabeledPrices('Buy order 4176'), [])
  assert.deepEqual(extractUnlabeledPrices('Ref: 99'), [])
  // Legitimate bare prices must survive the identity filter.
  assert.deepEqual(extractUnlabeledPrices('Bid 4176'), [4176])
  assert.deepEqual(extractUnlabeledPrices('Trade at 4176'), [4176])
  // The sell card from the incident: the order id must not become a stop loss.
  assert.deepEqual(
    extractUnlabeledPrices([
      'Type : New Order',
      'ID : 720325281',
      'Order : Sell',
      'Entry Price : 4165.79',
      'Stop Loss : 0.00',
      'Take Profit : 0.00',
    ].join('\n')),
    [],
  )
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

test('normalizeEntryZonePair expands gold shorthand zones', () => {
  assert.deepEqual(normalizeEntryZonePair('4061', '59'), { low: 4059, high: 4061 })
  assert.deepEqual(normalizeEntryZonePair('4105', '03'), { low: 4103, high: 4105 })
  assert.deepEqual(normalizeEntryZonePair('4136', '38'), { low: 4136, high: 4138 })
})

test('extractBarePriceRangeZone skips pip risk ranges', () => {
  assert.equal(extractBarePriceRangeZone('SL: 4085 | Risk: 80-110 Pips'), null)
  assert.deepEqual(extractBarePriceRangeZone('ENTRY 4061-59'), { low: 4059, high: 4061 })
})
