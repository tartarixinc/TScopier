import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { classifySymbol, smartPipSize } from './pipMath'

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

test('smartPipSize: XAUUSD 2-digit broker → pip = 0.10 (10 pips = $1.00)', () => {
  const pip = smartPipSize('XAUUSD', 0.01, 2)
  assert.equal(pip, 0.1)
  assert.equal(10 * pip, 1.0)
})

test('smartPipSize: XAUUSD 3-digit broker → pip = 0.10 (floor)', () => {
  // Trader convention: 1 pip on gold is $0.10 regardless of digit count, so
  // 3-digit brokers (point=0.001, point*10=0.01) still report pip=0.10.
  const pip = smartPipSize('XAUUSD', 0.001, 3)
  assert.ok(Math.abs(pip - 0.10) < 1e-9, `expected ~0.10 got ${pip}`)
})

test('smartPipSize: XAUUSD 5-digit broker → pip = 0.10 (floor protects 10-pip step)', () => {
  // Regression: some MT5 brokers list XAUUSD with 5 digits (point=0.00001).
  // Without the floor, pip = 0.0001 → "10 pips" = $0.001, which makes range
  // pendings/SL/TPs collapse into the broker's stops_level → "Invalid stops".
  const pip = smartPipSize('XAUUSD', 0.00001, 5)
  assert.ok(Math.abs(pip - 0.10) < 1e-9, `expected ~0.10 got ${pip}`)
  assert.equal(10 * pip, 1.0)
})

test('smartPipSize: XAGUSD 3-digit broker → pip = 0.01', () => {
  // Silver pip is $0.01 (lower price level), not gold's $0.10.
  const pip = smartPipSize('XAGUSD', 0.001, 3)
  assert.ok(Math.abs(pip - 0.01) < 1e-9, `expected ~0.01 got ${pip}`)
})

test('smartPipSize: EURUSD 5-digit broker → pip = 0.0001 (10 × point)', () => {
  const pip = smartPipSize('EURUSD', 0.00001, 5)
  assert.ok(Math.abs(pip - 0.0001) < 1e-12, `expected ~0.0001 got ${pip}`)
})

test('smartPipSize: EURUSD 4-digit broker → pip = 0.0001 (1 × point)', () => {
  const pip = smartPipSize('EURUSD', 0.0001, 4)
  assert.ok(Math.abs(pip - 0.0001) < 1e-12, `expected ~0.0001 got ${pip}`)
})

test('smartPipSize: USDJPY 3-digit broker → pip = 0.01', () => {
  const pip = smartPipSize('USDJPY', 0.001, 3)
  assert.ok(Math.abs(pip - 0.01) < 1e-9, `expected ~0.01 got ${pip}`)
})

test('smartPipSize: USDJPY 2-digit broker → pip = 0.01', () => {
  const pip = smartPipSize('USDJPY', 0.01, 2)
  assert.equal(pip, 0.01)
})

test('smartPipSize: BTCUSD 2-digit broker → pip = 0.10', () => {
  const pip = smartPipSize('BTCUSD', 0.01, 2)
  assert.equal(pip, 0.1)
})

test('smartPipSize: US30 0-digit broker → pip = 10', () => {
  const pip = smartPipSize('US30', 1, 0)
  assert.equal(pip, 10)
})

test('smartPipSize: bad inputs fall back to 0.0001', () => {
  assert.equal(smartPipSize('EURUSD', 0, 5), 0.0001)
  assert.equal(smartPipSize('EURUSD', NaN, 5), 0.0001)
  assert.equal(smartPipSize('EURUSD', -1, 5), 0.0001)
})

test('smartPipSize: unknown symbol with 2-digit point → pip = 10 × point', () => {
  const pip = smartPipSize('UNKNOWN_X', 0.01, 2)
  assert.equal(pip, 0.1)
})
