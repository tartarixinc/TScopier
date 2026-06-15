import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeFollowUpStops } from './basketModFollowUp'

test('computeFollowUpStops: breakeven applies offset beyond entry', () => {
  const stops = computeFollowUpStops(
    {
      legIndex: 0,
      openCount: 1,
      immediateLegCount: 1,
      rangeLegCount: 0,
      tpLots: null,
      anchorParsed: null,
      existingSl: 4320,
      existingTp: 4350,
      entryPrice: 4330,
      symbol: 'XAUUSD',
      isBuy: true,
      manual: { breakeven_offset_pips: 5 },
    },
    { action: 'breakeven' },
  )
  assert.ok(stops)
  assert.equal(stops!.stoploss, 4330.5)
  assert.equal(stops!.dbPatch.sl, 4330.5)
})

test('computeFollowUpStops: sell breakeven offsets below entry', () => {
  const stops = computeFollowUpStops(
    {
      legIndex: 0,
      openCount: 1,
      immediateLegCount: 1,
      rangeLegCount: 0,
      tpLots: null,
      anchorParsed: null,
      existingSl: 4320,
      existingTp: 4280,
      entryPrice: 4300,
      symbol: 'XAUUSD',
      isBuy: false,
      manual: { breakeven_offset_pips: 5 },
    },
    { action: 'breakeven' },
  )
  assert.ok(stops)
  assert.equal(stops!.stoploss, 4299.5)
})
