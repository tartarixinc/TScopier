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
  assert.equal(signalPipPrice('XAUUSD'), 0.1)
  assert.equal(getPipMultiplierForSymbol('XAUUSD'), 10)
  assert.equal(signalPipPrice('XAGUSD'), 0.10)
})

test('signalPipPrice: XAUUSD 5 pips is 0.5 price units', () => {
  const pip = signalPipPrice('XAUUSD')
  assert.equal(pip, 0.1)
  assert.equal(5 * pip, 0.5)
  assert.equal(4330 + 5 * pip, 4330.5)
  assert.equal(4300 - 5 * pip, 4299.5)
})

test('signalPipPrice: short index symbols use index multiplier', () => {
  assert.equal(signalPipPrice('US30'), 1)
  assert.equal(getPipMultiplierForSymbol('US30'), 1)
})

test('signalPipPrice: crypto pairs use a 2-decimal pip (0.01), not forex 0.0001', () => {
  assert.equal(getPipMultiplierForSymbol('BTCUSD'), 100)
  assert.equal(signalPipPrice('BTCUSD'), 0.01)
  assert.equal(getPipMultiplierForSymbol('ETHUSD'), 100)
  assert.equal(signalPipPrice('ETHUSD'), 0.01)
  assert.equal(getPipMultiplierForSymbol('BTCUSDm'), 100)
})

test('signalPipPrice: USDC/USDT-prefixed forex pairs keep the forex pip', () => {
  // Regression: classifySymbol used to match USDC/USDT crypto tokens before
  // the FX shape check, giving USDCHF the 0.01 crypto pip (100× off).
  assert.equal(getPipMultiplierForSymbol('USDCHF'), 10_000)
  assert.equal(signalPipPrice('USDCHF'), 0.0001)
  assert.equal(getPipMultiplierForSymbol('USDCAD'), 10_000)
  assert.equal(getPipMultiplierForSymbol('USDTRY'), 10_000)
  assert.equal(signalPipPrice('USDTRY'), 0.0001)
})
