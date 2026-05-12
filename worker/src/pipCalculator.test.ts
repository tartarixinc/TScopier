import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pipCalculator, pipValueForLots } from './pipCalculator'

// Helper: floating-point compare with a small tolerance.
function approxEq(a: number, b: number, eps = 1e-9) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${b} ± ${eps}, got ${a}`)
}

// ── FX majors ─────────────────────────────────────────────────────────────

test('pipCalculator: EURUSD 5-digit → pip=0.0001, $10/std lot', () => {
  const q = pipCalculator('EURUSD', 0.00001, 5)
  approxEq(q.pipPrice, 0.0001)
  assert.equal(q.pipValuePerStdLot, 10)
  assert.equal(q.pipValuePerMiniLot, 1)
  approxEq(q.pipValuePerMicroLot, 0.1)
  assert.equal(q.contractSize, 100_000)
  assert.equal(q.quoteCurrency, 'USD')
  assert.equal(q.class, 'fx_major')
})

test('pipCalculator: EURUSD 4-digit → pip=0.0001, $10/std lot', () => {
  const q = pipCalculator('EURUSD', 0.0001, 4)
  approxEq(q.pipPrice, 0.0001)
  assert.equal(q.pipValuePerStdLot, 10)
})

test('pipCalculator: GBPUSD broker tag (.r) classifies correctly', () => {
  const q = pipCalculator('GBPUSD.r', 0.00001, 5)
  approxEq(q.pipPrice, 0.0001)
  assert.equal(q.quoteCurrency, 'USD')
  assert.equal(q.class, 'fx_major')
})

// ── FX JPY pairs ──────────────────────────────────────────────────────────

test('pipCalculator: USDJPY 3-digit → pip=0.01, 1000 JPY/std lot', () => {
  const q = pipCalculator('USDJPY', 0.001, 3)
  approxEq(q.pipPrice, 0.01)
  assert.equal(q.pipValuePerStdLot, 1000)
  assert.equal(q.pipValuePerMiniLot, 100)
  assert.equal(q.pipValuePerMicroLot, 10)
  assert.equal(q.quoteCurrency, 'JPY')
  assert.equal(q.class, 'fx_jpy')
})

test('pipCalculator: USDJPY 2-digit → pip=0.01, 1000 JPY/std lot', () => {
  const q = pipCalculator('USDJPY', 0.01, 2)
  assert.equal(q.pipPrice, 0.01)
  assert.equal(q.pipValuePerStdLot, 1000)
})

// ── Metals ────────────────────────────────────────────────────────────────

test('pipCalculator: XAUUSD 2-digit → pip=0.10, $10/std lot', () => {
  const q = pipCalculator('XAUUSD', 0.01, 2)
  assert.equal(q.pipPrice, 0.10)
  assert.equal(q.pipValuePerStdLot, 10)
  assert.equal(q.pipValuePerMiniLot, 1)
  approxEq(q.pipValuePerMicroLot, 0.10)
  assert.equal(q.contractSize, 100)
  assert.equal(q.quoteCurrency, 'USD')
  assert.equal(q.class, 'metal')
})

test('pipCalculator: XAUUSD 3-digit → pip=0.10 (floor), $10/std lot', () => {
  const q = pipCalculator('XAUUSD', 0.001, 3)
  approxEq(q.pipPrice, 0.10)
  approxEq(q.pipValuePerStdLot, 10)
})

test('pipCalculator: XAUUSD 5-digit → pip=0.10 (floor), $10/std lot', () => {
  // Regression for the 5-digit XAUUSD broker that was producing
  // pip=0.0001 and breaking SL/TP placement before the floor was added.
  const q = pipCalculator('XAUUSD', 0.00001, 5)
  approxEq(q.pipPrice, 0.10)
  approxEq(q.pipValuePerStdLot, 10)
})

test('pipCalculator: XAGUSD 3-digit → pip=0.01, $50/std lot at 5000oz', () => {
  const q = pipCalculator('XAGUSD', 0.001, 3)
  approxEq(q.pipPrice, 0.01)
  approxEq(q.pipValuePerStdLot, 50)
  approxEq(q.pipValuePerMiniLot, 5)
  approxEq(q.pipValuePerMicroLot, 0.5)
  assert.equal(q.contractSize, 5_000)
})

test('pipCalculator: exotic 10-oz XAUUSD contract → pip=0.10, $1/std lot', () => {
  // Some brokers expose XAU as a 10-oz instead of 100-oz contract. The
  // broker-reported contractSize must win over the class default so the
  // pip value reflects the actual exposure.
  const q = pipCalculator('XAUUSD', 0.01, 2, 10)
  assert.equal(q.pipPrice, 0.10)
  approxEq(q.pipValuePerStdLot, 1)
  approxEq(q.pipValuePerMiniLot, 0.1)
  assert.equal(q.contractSize, 10)
})

test('pipCalculator: broker-reported contractSize wins for FX too', () => {
  // CFD-style FX with a 10,000-unit "standard lot" (rare but seen).
  const q = pipCalculator('EURUSD', 0.00001, 5, 10_000)
  approxEq(q.pipPrice, 0.0001)
  approxEq(q.pipValuePerStdLot, 1)
  assert.equal(q.contractSize, 10_000)
})

// ── Indices / crypto / energy ─────────────────────────────────────────────

test('pipCalculator: US30 0-digit → pip=10 ($10 move/std lot)', () => {
  const q = pipCalculator('US30', 1, 0)
  assert.equal(q.pipPrice, 10)
  assert.equal(q.contractSize, 1)
  assert.equal(q.pipValuePerStdLot, 10)
  assert.equal(q.class, 'index')
})

test('pipCalculator: US30 2-digit → pip floored at 1.0', () => {
  // Defensive: an over-precise index broker quoting 2 digits would have
  // pip = 10×point = 0.1, which is too small for the index trader's mental
  // model. We floor at 1.0.
  const q = pipCalculator('US30', 0.01, 2)
  assert.equal(q.pipPrice, 1)
})

test('pipCalculator: BTCUSD 2-digit → pip=0.10, $0.10/std lot at 1 BTC contract', () => {
  const q = pipCalculator('BTCUSD', 0.01, 2)
  approxEq(q.pipPrice, 0.10)
  assert.equal(q.contractSize, 1)
  approxEq(q.pipValuePerStdLot, 0.10)
  assert.equal(q.class, 'crypto')
})

test('pipCalculator: USOIL 2-digit → pip=0.10, $100/std lot at 1000 bbl', () => {
  const q = pipCalculator('USOIL', 0.01, 2)
  approxEq(q.pipPrice, 0.10)
  assert.equal(q.contractSize, 1_000)
  approxEq(q.pipValuePerStdLot, 100)
  assert.equal(q.class, 'energy')
})

// ── Bad inputs & helpers ──────────────────────────────────────────────────

test('pipCalculator: bad point falls back to pipPrice=0.0001, pipValue=0', () => {
  const q1 = pipCalculator('EURUSD', 0, 5)
  assert.equal(q1.pipPrice, 0.0001)
  assert.equal(q1.pipValuePerStdLot, 0)
  const q2 = pipCalculator('XAUUSD', NaN, 5)
  assert.equal(q2.pipPrice, 0.0001)
  assert.equal(q2.pipValuePerStdLot, 0)
  const q3 = pipCalculator('EURUSD', -1, 5)
  assert.equal(q3.pipPrice, 0.0001)
  assert.equal(q3.pipValuePerStdLot, 0)
})

test('pipValueForLots: scales linearly with lot size', () => {
  const q = pipCalculator('XAUUSD', 0.01, 2)
  approxEq(pipValueForLots(q, 1.0), 10)
  approxEq(pipValueForLots(q, 0.1), 1)
  approxEq(pipValueForLots(q, 0.01), 0.1)
  approxEq(pipValueForLots(q, 2.5), 25)
})

test('pipValueForLots: zero/negative/NaN lots → 0', () => {
  const q = pipCalculator('XAUUSD', 0.01, 2)
  assert.equal(pipValueForLots(q, 0), 0)
  assert.equal(pipValueForLots(q, -1), 0)
  assert.equal(pipValueForLots(q, NaN), 0)
})

test('pipCalculator: mini == std × 0.1, micro == std × 0.01 (arithmetic invariant)', () => {
  const cases = [
    pipCalculator('EURUSD', 0.00001, 5),
    pipCalculator('USDJPY', 0.001, 3),
    pipCalculator('XAUUSD', 0.001, 3),
    pipCalculator('XAGUSD', 0.001, 3),
    pipCalculator('BTCUSD', 0.01, 2),
  ]
  for (const q of cases) {
    approxEq(q.pipValuePerMiniLot, q.pipValuePerStdLot * 0.1)
    approxEq(q.pipValuePerMicroLot, q.pipValuePerStdLot * 0.01)
  }
})
