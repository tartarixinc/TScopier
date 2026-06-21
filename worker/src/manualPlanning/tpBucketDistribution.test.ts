import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildDistributedPerLegTakeProfits,
  buildEntryQualityTakeProfitMap,
  buildRangeBasketPerLegStopTargets,
  distributeCountAcrossTpBuckets,
  resolveRangeBasketTpPhase,
  resolveTpBucketRows,
  takeProfitForLegIndex,
  takeProfitForSplitBasketLeg,
} from './tpBucketDistribution'
import { normalizeManualSettingsForExecution } from './normalizeManualSettings'

const TP_LOTS = [
  { label: 'TP1', lot: 0, percent: 50, enabled: true },
  { label: 'TP2', lot: 0, percent: 30, enabled: true },
  { label: 'TP3', lot: 0, percent: 20, enabled: true },
]
const TPS = [4530, 4510, 4490]

function leg(id: string, entryPrice: number, openedAt: string) {
  return { id, entryPrice, openedAt }
}

test('distributeCountAcrossTpBuckets: 50/30/20 on 10 legs', () => {
  const counts = distributeCountAcrossTpBuckets(10, [
    { label: 'TP1', percent: 50 },
    { label: 'TP2', percent: 30 },
    { label: 'TP3', percent: 20 },
  ])
  assert.deepEqual(counts, [5, 3, 2])
})

test('buildDistributedPerLegTakeProfits: maps legs to TP1/TP2/TP3 prices', () => {
  const prices = buildDistributedPerLegTakeProfits({
    openLegCount: 10,
    finalTps: [4530, 4510, 4490],
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  })
  assert.equal(prices.length, 10)
  assert.equal(prices.filter(p => p === 4530).length, 5)
  assert.equal(prices.filter(p => p === 4510).length, 3)
  assert.equal(prices.filter(p => p === 4490).length, 2)
})

test('takeProfitForSplitBasketLeg: instant and range pools each get 50/30/20', () => {
  const tpLots = [
    { label: 'TP1', lot: 0, percent: 50, enabled: true },
    { label: 'TP2', lot: 0, percent: 30, enabled: true },
    { label: 'TP3', lot: 0, percent: 20, enabled: true },
  ]
  const tps = [4530, 4510, 4490]
  assert.equal(
    takeProfitForSplitBasketLeg({
      legIndex: 0,
      immediateLegCount: 5,
      rangeLegCount: 5,
      finalTps: tps,
      tpLots,
    }),
    4530,
  )
  assert.equal(
    takeProfitForSplitBasketLeg({
      legIndex: 4,
      immediateLegCount: 5,
      rangeLegCount: 5,
      finalTps: tps,
      tpLots,
    }),
    4510,
  )
  assert.equal(
    takeProfitForSplitBasketLeg({
      legIndex: 5,
      immediateLegCount: 5,
      rangeLegCount: 5,
      finalTps: tps,
      tpLots,
    }),
    4530,
  )
  assert.equal(
    takeProfitForSplitBasketLeg({
      legIndex: 9,
      immediateLegCount: 5,
      rangeLegCount: 5,
      finalTps: tps,
      tpLots,
    }),
    4510,
  )
})

test('takeProfitForLegIndex: leg 6 of 10 gets TP2 price', () => {
  const tp = takeProfitForLegIndex({
    legIndex: 5,
    openLegCount: 10,
    finalTps: [4530, 4510, 4490],
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  })
  assert.equal(tp, 4510)
})

test('resolveTpBucketRows: disabled middle TP keeps positional prices (50/0/50)', () => {
  const { bucketRows } = resolveTpBucketRows([4530, 4510, 4490], [
    { label: 'TP1', lot: 0, percent: 50, enabled: true },
    { label: 'TP2', lot: 0, percent: 30, enabled: false },
    { label: 'TP3', lot: 0, percent: 50, enabled: true },
  ])
  assert.deepEqual(bucketRows.map(r => r.percent), [50, 0, 50])
  const counts = distributeCountAcrossTpBuckets(10, bucketRows)
  assert.deepEqual(counts, [5, 0, 5])
  const prices = buildDistributedPerLegTakeProfits({
    openLegCount: 10,
    finalTps: [4530, 4510, 4490],
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: false },
      { label: 'TP3', lot: 0, percent: 50, enabled: true },
    ],
  })
  assert.equal(prices.filter(p => p === 4530).length, 5)
  assert.equal(prices.filter(p => p === 4510).length, 0)
  assert.equal(prices.filter(p => p === 4490).length, 5)
})

test('normalizeManualSettingsForExecution: equal split when enabled rows have 0%', () => {
  const m = normalizeManualSettingsForExecution({
    tp_lots: [
      { label: 'TP1', lot: 0.01, percent: 0, enabled: true },
      { label: 'TP2', lot: 0.01, percent: 0, enabled: true },
      { label: 'TP3', lot: 0.01, percent: 0, enabled: false },
    ],
  })
  assert.deepEqual(
    (m.tp_lots ?? []).filter(r => r.enabled).map(r => r.percent),
    [50, 50],
  )
})

test('resolveRangeBasketTpPhase: instant_only until first range leg fires', () => {
  assert.equal(
    resolveRangeBasketTpPhase({ openLegCount: 10, immediateLegCount: 10, firedRangeLegCount: 0 }),
    'instant_only',
  )
  assert.equal(
    resolveRangeBasketTpPhase({ openLegCount: 11, immediateLegCount: 10, firedRangeLegCount: 1 }),
    'layering_rebalance',
  )
})

test('buildRangeBasketPerLegStopTargets phase A: 10 instants get 5/3/2 by index', () => {
  const openLegs = Array.from({ length: 10 }, (_, i) =>
    leg(`i${i}`, 4335, `2026-01-01T00:00:0${i}Z`),
  )
  const targets = buildRangeBasketPerLegStopTargets({
    phase: 'instant_only',
    openLegs,
    immediateLegCount: 10,
    isBuy: true,
    stoploss: 4300,
    finalTps: TPS,
    tpLots: TP_LOTS,
  })
  assert.equal(targets.length, 10)
  assert.equal(targets.filter(t => t.takeprofit === 4530).length, 5)
  assert.equal(targets.filter(t => t.takeprofit === 4510).length, 3)
  assert.equal(targets.filter(t => t.takeprofit === 4490).length, 2)
})

test('buildRangeBasketPerLegStopTargets phase B: worst instant demoted when better layer joins', () => {
  const instants = Array.from({ length: 10 }, (_, i) =>
    leg(`i${i}`, 4335, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`),
  )
  const layers = [
    leg('l0', 4330, '2026-01-01T01:00:00Z'),
    leg('l1', 4325, '2026-01-01T01:00:01Z'),
  ]
  const openLegs = [...instants, ...layers]
  const targets = buildRangeBasketPerLegStopTargets({
    phase: 'layering_rebalance',
    openLegs,
    immediateLegCount: 10,
    isBuy: true,
    stoploss: 4300,
    finalTps: TPS,
    tpLots: TP_LOTS,
  })
  const byId = new Map(openLegs.map((l, i) => [l.id, targets[i]!.takeprofit]))
  assert.equal(byId.get('l0'), 4490)
  assert.equal(byId.get('l1'), 4490)
  const instantTps = instants.map(l => byId.get(l.id))
  assert.equal(instantTps.filter(tp => tp === 4530).length, 6)
  assert.equal(instantTps.filter(tp => tp === 4510).length, 4)
  assert.equal(instantTps.filter(tp => tp === 4490).length, 0)
})

test('buildEntryQualityTakeProfitMap: opened_at tie-break among instants', () => {
  const openLegs = [
    leg('late', 4335, '2026-01-01T00:00:02Z'),
    leg('early', 4335, '2026-01-01T00:00:01Z'),
  ]
  const tpMap = buildEntryQualityTakeProfitMap({
    legs: openLegs,
    isBuy: true,
    slotLegCount: 2,
    finalTps: TPS,
    tpLots: TP_LOTS,
  })
  assert.equal(tpMap.get('early'), 4530)
  assert.equal(tpMap.get('late'), 4510)
})

test('buildRangeBasketPerLegStopTargets phase B sell: worse lower entry gets nearer TP', () => {
  const openLegs = [
    leg('bad', 1.1050, '2026-01-01T00:00:00Z'),
    leg('good', 1.1060, '2026-01-01T00:00:01Z'),
  ]
  const targets = buildRangeBasketPerLegStopTargets({
    phase: 'layering_rebalance',
    openLegs,
    immediateLegCount: 1,
    isBuy: false,
    stoploss: 1.1100,
    finalTps: [1.1000, 1.0980, 1.0960],
    tpLots: TP_LOTS,
  })
  assert.equal(targets[0]!.takeprofit, 1.1000)
  assert.equal(targets[1]!.takeprofit, 1.0980)
})
