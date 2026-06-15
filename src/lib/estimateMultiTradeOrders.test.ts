import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { estimateMultiTradeOrderCount, formatMultiTradeTotalOpenTradesPreview } from './estimateMultiTradeOrders'
import { computeMinMultiTradeLegPercent, resolveMultiTradePerLegLot } from './multiTradeLegUnits'

test('computeMinMultiTradeLegPercent: 0.2 lot needs 5% per leg at 0.01 min', () => {
  assert.equal(computeMinMultiTradeLegPercent(0.2), 5)
})

test('estimateMultiTradeOrderCount: 1.0 lot @ 5% → 20 orders', () => {
  const r = estimateMultiTradeOrderCount({ manualLot: 1.0, legPercent: 5 })
  assert.equal(r.totalOrders, 20)
  assert.equal(r.fallsBackSingle, false)
})

test('estimateMultiTradeOrderCount: 1.0 lot @ 2% → 50 orders', () => {
  const r = estimateMultiTradeOrderCount({ manualLot: 1.0, legPercent: 2 })
  assert.equal(r.totalOrders, 50)
})

test('estimateMultiTradeOrderCount: 0.2 lot @ 2% falls back to single trade', () => {
  const r = estimateMultiTradeOrderCount({ manualLot: 0.2, legPercent: 2 })
  assert.equal(r.totalOrders, 1)
  assert.equal(r.fallsBackSingle, true)
})

test('estimateMultiTradeOrderCount: 0.2 lot @ 5% → 20 orders', () => {
  const r = estimateMultiTradeOrderCount({ manualLot: 0.2, legPercent: 5 })
  assert.equal(r.totalOrders, 20)
  assert.equal(r.fallsBackSingle, false)
})

test('estimateMultiTradeOrderCount: 0.2 lot @ 10% → 10 orders', () => {
  const r = estimateMultiTradeOrderCount({ manualLot: 0.2, legPercent: 10 })
  assert.equal(r.totalOrders, 10)
})

test('resolveMultiTradePerLegLot: 1.0 lot @ 5% → 0.05 per leg', () => {
  assert.equal(resolveMultiTradePerLegLot({ manualLot: 1.0, legPercent: 5 }), 0.05)
})

test('resolveMultiTradePerLegLot: below min leg % → full lot', () => {
  assert.equal(resolveMultiTradePerLegLot({ manualLot: 0.2, legPercent: 2 }), 0.2)
})

test('formatMultiTradeTotalOpenTradesPreview: layered range split', () => {
  const text = formatMultiTradeTotalOpenTradesPreview(
    0.01,
    {
      baseLegs: 20,
      extraRemainderLeg: false,
      totalOrders: 20,
      fallsBackSingle: false,
      immediate: 6,
      pending: 14,
    },
    {
      fallbackSingle: '{lot} lots x 1 trade (fallback)',
      lotsXTrades: '{lot} lots x {total} trades',
      lotsXTradesLayered: '{lot} lots x {total} trades ({immediate} instant + {pending} for layering)',
    },
  )
  assert.equal(text, '0.01 lots x 20 trades (6 instant + 14 for layering)')
})

test('formatMultiTradeTotalOpenTradesPreview: plain multi split', () => {
  const text = formatMultiTradeTotalOpenTradesPreview(
    0.05,
    {
      baseLegs: 20,
      extraRemainderLeg: false,
      totalOrders: 20,
      fallsBackSingle: false,
    },
    {
      fallbackSingle: '{lot} lots x 1 trade (fallback)',
      lotsXTrades: '{lot} lots x {total} trades',
      lotsXTradesLayered: '{lot} lots x {total} trades ({immediate} instant + {pending} for layering)',
    },
  )
  assert.equal(text, '0.05 lots x 20 trades')
})
