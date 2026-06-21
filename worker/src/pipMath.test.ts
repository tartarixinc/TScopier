import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { classifySymbol } from './pipMath'

test('classifySymbol: FX majors', () => {
  assert.equal(classifySymbol('EURUSD'), 'fx_major')
  assert.equal(classifySymbol('GBPUSD'), 'fx_major')
  assert.equal(classifySymbol('AUDCAD'), 'fx_major')
  assert.equal(classifySymbol('EURUSDm'), 'fx_major')
  assert.equal(classifySymbol('EURUSD.r'), 'fx_major')
  assert.equal(classifySymbol('EURUSD#'), 'fx_major')
})

test('classifySymbol: FX JPY pairs', () => {
  assert.equal(classifySymbol('USDJPY'), 'fx_jpy')
  assert.equal(classifySymbol('EURJPY'), 'fx_jpy')
  assert.equal(classifySymbol('GBPJPY'), 'fx_jpy')
  assert.equal(classifySymbol('JPYUSD'), 'fx_jpy')
})

test('classifySymbol: metals', () => {
  assert.equal(classifySymbol('XAUUSD'), 'metal')
  assert.equal(classifySymbol('XAGUSD'), 'metal')
  assert.equal(classifySymbol('XPTUSD'), 'metal')
  assert.equal(classifySymbol('XAUUSDm'), 'metal')
})

test('classifySymbol: crypto', () => {
  assert.equal(classifySymbol('BTCUSD'), 'crypto')
  assert.equal(classifySymbol('ETHUSD'), 'crypto')
  assert.equal(classifySymbol('BTCUSDT'), 'crypto')
  assert.equal(classifySymbol('SOLUSD'), 'crypto')
})

test('classifySymbol: indices', () => {
  assert.equal(classifySymbol('US30'), 'index')
  assert.equal(classifySymbol('NAS100'), 'index')
  assert.equal(classifySymbol('DE40'), 'index')
  assert.equal(classifySymbol('UK100'), 'index')
})

test('classifySymbol: energy', () => {
  assert.equal(classifySymbol('USOIL'), 'energy')
  assert.equal(classifySymbol('UKOIL'), 'energy')
  assert.equal(classifySymbol('BRENT'), 'energy')
})

test('classifySymbol: unknown / other', () => {
  assert.equal(classifySymbol(''), 'other')
  assert.equal(classifySymbol('XYZ123'), 'other')
})
