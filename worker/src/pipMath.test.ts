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
  assert.equal(classifySymbol('GOLD'), 'metal')
  assert.equal(classifySymbol('SILVER'), 'metal')
})

test('classifySymbol: crypto', () => {
  assert.equal(classifySymbol('BTCUSD'), 'crypto')
  assert.equal(classifySymbol('ETHUSD'), 'crypto')
  assert.equal(classifySymbol('BTCUSDT'), 'crypto')
  assert.equal(classifySymbol('SOLUSD'), 'crypto')
})

test('classifySymbol: FX pairs that start/end with USDC/USDT stay forex', () => {
  // CRYPTO_TOKENS contains USDC/USDT; the FX shape check must win, otherwise
  // these pairs take the 100× crypto pip on live management math.
  assert.equal(classifySymbol('USDCAD'), 'fx_major')
  assert.equal(classifySymbol('USDCHF'), 'fx_major')
  assert.equal(classifySymbol('USDTRY'), 'fx_major')
  assert.equal(classifySymbol('USDCNH'), 'fx_major')
  assert.equal(classifySymbol('USDCZK'), 'fx_major')
  assert.equal(classifySymbol('USDCADm'), 'fx_major')
})

test('classifySymbol: indices', () => {
  assert.equal(classifySymbol('US30'), 'index')
  assert.equal(classifySymbol('NAS100'), 'index')
  assert.equal(classifySymbol('DE40'), 'index')
  assert.equal(classifySymbol('UK100'), 'index')
})

test('classifySymbol: US stocks and ETFs', () => {
  assert.equal(classifySymbol('QQQ'), 'stock')
  assert.equal(classifySymbol('SPY'), 'stock')
  assert.equal(classifySymbol('IWM'), 'stock')
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
