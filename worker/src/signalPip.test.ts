import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  computePipsFromSignalOutcome,
  getPipMultiplierForSymbol,
  priceDeltaToPips,
  pipsToPriceOffset,
  signalPipPrice,
} from './signalPip'

test('signalPipPrice: FX and metals match backtest multipliers', () => {
  assert.equal(signalPipPrice('EURUSD'), 0.0001)
  assert.equal(getPipMultiplierForSymbol('EURUSD'), 10_000)
  assert.equal(signalPipPrice('USDJPY'), 0.01)
  assert.equal(signalPipPrice('XAUUSD'), 0.10)
  assert.equal(signalPipPrice('XAGUSD'), 0.10)
})

test('signalPipPrice: short index symbols use index multiplier', () => {
  assert.equal(signalPipPrice('US30'), 1)
  assert.equal(getPipMultiplierForSymbol('US30'), 1)
})

test('pipsToPriceOffset and priceDeltaToPips are inverse', () => {
  const symbol = 'XAUUSD'
  const pips = 30
  const offset = pipsToPriceOffset(pips, symbol)
  assert.equal(offset, 3)
  assert.equal(priceDeltaToPips(3, symbol), 30)
})

test('computePipsFromSignalOutcome: 30 pip gold TP', () => {
  const pips = computePipsFromSignalOutcome({
    symbol: 'XAUUSD',
    direction: 'buy',
    entry: 2000,
    sl: 1997,
    tpLevels: [2003],
    outcome: 'all_tp_hit',
    tpsHit: 1,
  })
  assert.equal(pips, 30)
})
