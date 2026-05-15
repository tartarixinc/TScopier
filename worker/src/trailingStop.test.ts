import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeTrailingStopUpdate, isSingleTradeTrailingEnabled } from './trailingStop'

test('isSingleTradeTrailingEnabled: off for multi trade style', () => {
  assert.equal(isSingleTradeTrailingEnabled({ trailing_enabled: true, trade_style: 'multi' }), false)
})

test('isSingleTradeTrailingEnabled: on for single when enabled', () => {
  assert.equal(isSingleTradeTrailingEnabled({ trailing_enabled: true, trade_style: 'single' }), true)
})

test('computeTrailingStopUpdate: does not trail before start pips', () => {
  const r = computeTrailingStopUpdate({
    isBuy: true,
    entryPrice: 2000,
    currentSl: 1990,
    trailPeak: 2000,
    bid: 2001,
    ask: 2001.1,
    pipPrice: 0.1,
    digits: 2,
    config: { startPips: 20, stepPips: 5, distancePips: 10 },
  })
  assert.equal(r, null)
})

test('computeTrailingStopUpdate: raises SL on buy when profit exceeds start and step', () => {
  const r = computeTrailingStopUpdate({
    isBuy: true,
    entryPrice: 2000,
    currentSl: 1990,
    trailPeak: 2000,
    bid: 2025,
    ask: 2025.1,
    pipPrice: 0.1,
    digits: 2,
    config: { startPips: 20, stepPips: 5, distancePips: 10 },
  })
  assert.notEqual(r, null)
  assert.ok(r!.newSl > 1990)
  assert.equal(r!.newPeak, 2025)
})

test('computeTrailingStopUpdate: lowers SL on sell when profit exceeds start', () => {
  const r = computeTrailingStopUpdate({
    isBuy: false,
    entryPrice: 2000,
    currentSl: 2010,
    trailPeak: 2000,
    bid: 1999.9,
    ask: 1975,
    pipPrice: 0.1,
    digits: 2,
    config: { startPips: 20, stepPips: 5, distancePips: 10 },
  })
  assert.notEqual(r, null)
  assert.ok(r!.newSl < 2010)
  assert.equal(r!.newPeak, 1975)
})
