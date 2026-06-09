import test from 'node:test'
import assert from 'node:assert/strict'
import { computeDynamicBalanceLot, resolvePreviewManualLot } from './manualLotSizing'
import { estimateMultiTradeOrderCount } from './estimateMultiTradeOrders'

test('computeDynamicBalanceLot matches worker formula', () => {
  assert.equal(
    computeDynamicBalanceLot({ balance: 10_000, dynamicBalancePercent: 2 }),
    0.2,
  )
  assert.equal(
    computeDynamicBalanceLot({ balance: 50_000, dynamicBalancePercent: 2 }),
    1,
  )
})

test('resolvePreviewManualLot uses dynamic lot for multi-trade preview', () => {
  const manualLot = resolvePreviewManualLot({
    manualSettings: {
      risk_mode: 'dynamic_balance_percent',
      dynamic_balance_percent: 2,
      fixed_lot: 0.01,
    },
    accountBalance: 50_000,
  })
  assert.equal(manualLot, 1)

  const preview = estimateMultiTradeOrderCount({
    manualLot,
    legPercent: 5,
    range: {
      enabled: true,
      percent: 50,
      stepPips: 10,
      distancePips: 100,
    },
  })
  assert.equal(preview.fallsBackSingle, false)
  assert.equal(preview.totalOrders, 20)
  assert.equal(preview.immediate, 10)
  assert.equal(preview.pending, 10)
})

test('resolvePreviewManualLot falls back to fixed lot when balance unknown', () => {
  assert.equal(
    resolvePreviewManualLot({
      manualSettings: {
        risk_mode: 'dynamic_balance_percent',
        dynamic_balance_percent: 2,
        fixed_lot: 0.05,
      },
      accountBalance: null,
    }),
    0.05,
  )
})
