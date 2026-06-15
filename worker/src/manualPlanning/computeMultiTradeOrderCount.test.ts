import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { computeMultiTradeOrderCount } from './computeMultiTradeOrderCount'
import { normalizeManualSettingsForExecution } from './normalizeManualSettings'

test('computeMultiTradeOrderCount: 5 lot @ 7% → 15 orders', () => {
  assert.equal(
    computeMultiTradeOrderCount({ manualLot: 5, legPercent: 7 }),
    15,
  )
})

test('computeMultiTradeOrderCount: 5 lot @ 2% → 50 orders', () => {
  assert.equal(
    computeMultiTradeOrderCount({ manualLot: 5, legPercent: 2 }),
    50,
  )
})

test('normalizeManualSettingsForExecution seeds multi_trade_max_orders from leg%', () => {
  const ms = normalizeManualSettingsForExecution({
    trade_style: 'multi',
    fixed_lot: 5,
    multi_trade_leg_percent: 7,
  })
  assert.equal(ms.multi_trade_max_orders, 15)
})

test('normalizeManualSettingsForExecution honors legacy multi_trade_max_legs', () => {
  const ms = normalizeManualSettingsForExecution({
    trade_style: 'multi',
    fixed_lot: 5,
    multi_trade_leg_percent: 2,
    multi_trade_max_legs: 15,
  })
  assert.equal(ms.multi_trade_max_orders, 15)
})

test('normalizeManualSettingsForExecution recomputes burst cap for dynamic balance', () => {
  const ms = normalizeManualSettingsForExecution({
    trade_style: 'multi',
    risk_mode: 'dynamic_balance_percent',
    dynamic_balance_percent: 11,
    fixed_lot: 0.01,
    multi_trade_leg_percent: 3,
    multi_trade_max_orders: 1,
    range_trading: true,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
  }, { accountBalance: 31_054.79 })
  assert.equal(ms.multi_trade_max_orders, 34)
})
