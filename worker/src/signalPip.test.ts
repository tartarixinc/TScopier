import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  getPipMultiplierForSymbol,
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
