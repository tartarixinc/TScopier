import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  computeLegBreakdown,
  computeRiskLotCalculator,
  type RiskLotCalculatorState,
} from './riskLotCalculator.ts'
import { pipCalculator } from './pipCalculator.ts'
import type { ManualTpLot } from '../types/database.ts'

const EURUSD_QUOTE = pipCalculator('EURUSD', 0.00001, 5)

function baseState(overrides: Partial<RiskLotCalculatorState> = {}): RiskLotCalculatorState {
  return {
    accountBalance: 10000,
    slPips: 30,
    tpPips: [20, 40, 60],
    tradeStyle: 'single',
    legPercent: 5,
    rangeTrading: false,
    rangePercent: 50,
    rangeStepPips: 3,
    rangeDistancePips: 30,
    fixedLot: 0.01,
    tpLots: [
      { label: 'TP1', lot: 0.01, percent: 50, enabled: true },
      { label: 'TP2', lot: 0.01, percent: 30, enabled: true },
      { label: 'TP3', lot: 0.01, percent: 20, enabled: true },
    ],
    ...overrides,
  }
}

test('single trade: risk $ and % for 0.01 lot, 30 SL pips on EURUSD', () => {
  const result = computeRiskLotCalculator(baseState(), EURUSD_QUOTE)
  // 0.01 lot × $10/pip × 30 pips = $3
  assert.equal(result.riskFullBasket, 3)
  assert.equal(result.riskPctFull, 0.03)
  assert.equal(result.legs.totalLegs, 1)
})

test('multi 1.0 lot @ 5%/leg → 20 legs, worst-case risk', () => {
  const result = computeRiskLotCalculator(
    baseState({ tradeStyle: 'multi', fixedLot: 1.0, slPips: 30 }),
    EURUSD_QUOTE,
  )
  assert.equal(result.legs.totalLegs, 20)
  assert.equal(result.legs.perLegLot, 0.05)
  // 20 × 0.05 × $10/pip × 30 = $300
  assert.equal(result.riskFullBasket, 300)
  assert.equal(result.riskPctFull, 3)
})

test('range mode: immediate vs full-basket risk split', () => {
  const result = computeRiskLotCalculator(
    baseState({
      tradeStyle: 'multi',
      fixedLot: 1.0,
      slPips: 30,
      rangeTrading: true,
      rangePercent: 50,
      rangeStepPips: 3,
      rangeDistancePips: 30,
    }),
    EURUSD_QUOTE,
  )
  assert.equal(result.legs.immediateLegs, 10)
  assert.equal(result.legs.pendingLegs, 10)
  assert.equal(result.riskImmediateOnly, 150)
  assert.equal(result.riskFullBasket, 300)
})

test('inverse lot suggestion hits target risk % within tolerance', () => {
  const result = computeRiskLotCalculator(
    baseState({
      tradeStyle: 'single',
      targetRiskPct: 1,
      fixedLot: 0.5,
    }),
    EURUSD_QUOTE,
  )
  assert.ok(result.suggestedLot != null)
  const verify = computeRiskLotCalculator(
    baseState({ tradeStyle: 'single', fixedLot: result.suggestedLot! }),
    EURUSD_QUOTE,
  )
  assert.ok(verify.riskPctFull <= 1.01)
  assert.ok(verify.riskPctFull >= 0.99)
})

test('single partial TP reward matches 50/30/20 on 1.0 lot', () => {
  const tpLots: ManualTpLot[] = [
    { label: 'TP1', lot: 0.01, percent: 50, enabled: true },
    { label: 'TP2', lot: 0.01, percent: 30, enabled: true },
    { label: 'TP3', lot: 0.01, percent: 20, enabled: true },
  ]
  const result = computeRiskLotCalculator(
    baseState({
      fixedLot: 1.0,
      tpPips: [20, 40, 60],
      tpLots,
    }),
    EURUSD_QUOTE,
  )
  assert.equal(result.rewardRows.length, 3)
  assert.equal(result.rewardRows[0]!.lots, 0.5)
  assert.equal(result.rewardRows[1]!.lots, 0.3)
  assert.equal(result.rewardRows[2]!.lots, 0.2)
  // 0.5×20 + 0.3×40 + 0.2×60 = 10+12+12 = 34 pips × $10 = $340
  assert.equal(result.totalReward, 340)
})

test('disabled TP with zero % is excluded from reward; pips and % stay index-aligned', () => {
  const result = computeRiskLotCalculator(
    baseState({
      fixedLot: 1.0,
      tpPips: [20, 40, 60],
      tpLots: [
        { label: 'TP1', lot: 0.01, percent: 50, enabled: true },
        { label: 'TP2', lot: 0.01, percent: 0, enabled: false },
        { label: 'TP3', lot: 0.01, percent: 50, enabled: true },
      ],
    }),
    EURUSD_QUOTE,
  )
  assert.equal(result.rewardRows.length, 2)
  assert.equal(result.rewardRows[0]!.pips, 20)
  assert.equal(result.rewardRows[0]!.percent, 50)
  assert.equal(result.rewardRows[1]!.pips, 60)
  assert.equal(result.rewardRows[1]!.percent, 50)
  // 0.5×20 + 0.5×60 = 40 pips × $10 = $400
  assert.equal(result.totalReward, 400)
})

test('computeLegBreakdown falls back to single when leg too small', () => {
  const legs = computeLegBreakdown({
    fixedLot: 0.01,
    legPercent: 5,
    tradeStyle: 'multi',
    rangeTrading: false,
    rangePercent: 50,
    rangeStepPips: 3,
    rangeDistancePips: 30,
  })
  assert.equal(legs.fallsBackSingle, true)
  assert.equal(legs.totalLegs, 1)
})
