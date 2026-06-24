import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  backfillNakedLegTakeProfits,
  buildRangeBasketTpTargets,
  coercePositiveTpLevels,
  deepestFinalTp,
  estimatePlanImmediateLegCount,
  fillZeroTargetsWithDeepest,
  preserveOpenLegTakeProfits,
  applyOpenLegStopLossToTargets,
  resolveFiringLegStops,
  resolveRangeBasketFinalTps,
  resolveRangeBasketLegCounts,
  resolveRangeTpRebalanceGate,
} from './rangeBasketTpSync'
import type { BasketOpenLeg } from './basketSlTpReconcile'

const TP_LOTS = [
  { label: 'TP1', lot: 0, percent: 50, enabled: true },
  { label: 'TP2', lot: 0, percent: 30, enabled: true },
  { label: 'TP3', lot: 0, percent: 20, enabled: true },
]

function openLeg(id: string, entry: number, openedAt: string): BasketOpenLeg {
  return {
    id,
    signal_id: 'sig',
    metaapi_order_id: '1',
    opened_at: openedAt,
    lot_size: 0.01,
    sl: 4300,
    tp: 4530,
    entry_price: entry,
    direction: 'buy',
    symbol: 'XAUUSD',
  }
}

test('resolveRangeBasketLegCounts: phase B after first range leg', () => {
  const counts = resolveRangeBasketLegCounts({
    openLegCount: 11,
    planImmediateLegCount: 10,
    activePendingCount: 9,
    maxPendingStepIdx: 10,
  })
  assert.equal(counts.firedRangeLegCount, 1)
  assert.equal(counts.phase, 'layering_rebalance')
})

test('buildRangeBasketTpTargets: phase A uses instant pool only', () => {
  const legs = Array.from({ length: 4 }, (_, i) =>
    openLeg(`i${i}`, 4335, `2026-01-01T00:00:0${i}Z`),
  )
  const targets = buildRangeBasketTpTargets({
    familyTrades: legs,
    plan: null,
    parsed: { sl: 4300, tp: [4530, 4510, 4490] },
    tpLots: TP_LOTS,
    direction: 'buy',
    activePendingCount: 10,
    maxPendingStepIdx: 10,
  })
  assert.equal(targets.filter(t => t.takeprofit === 4530).length, 2)
})

test('estimatePlanImmediateLegCount: infers instants after all range legs fired', () => {
  assert.equal(
    estimatePlanImmediateLegCount({
      openLegCount: 27,
      activePendingCount: 0,
      maxPendingStepIdx: 10,
    }),
    17,
  )
})

test('resolveRangeBasketLegCounts: layering phase when all pending fired', () => {
  const counts = resolveRangeBasketLegCounts({
    openLegCount: 27,
    planImmediateLegCount: 17,
    activePendingCount: 0,
    maxPendingStepIdx: 10,
  })
  assert.equal(counts.firedRangeLegCount, 10)
  assert.equal(counts.phase, 'layering_rebalance')
})

test('coercePositiveTpLevels: accepts numeric strings', () => {
  assert.deepEqual(coercePositiveTpLevels(['4345', 4355, '4360']), [4345, 4355, 4360])
})

test('resolveRangeBasketFinalTps: falls back to open-leg ladder when multiple TP levels', () => {
  const legs = [
    openLeg('a', 4335, '2026-01-01T00:00:00Z'),
    openLeg('b', 4336, '2026-01-01T00:00:01Z'),
  ]
  legs[0]!.tp = 4345
  legs[1]!.tp = 4360
  const tps = resolveRangeBasketFinalTps({
    parsed: {},
    plan: null,
    familyTrades: legs,
    direction: 'buy',
  })
  assert.deepEqual(tps, [4345, 4360])
})

test('resolveRangeBasketFinalTps: ignores single TP on many legs (failed balance)', () => {
  const legs = Array.from({ length: 5 }, (_, i) =>
    openLeg(`i${i}`, 4335, `2026-01-01T00:00:0${i}Z`),
  )
  for (const leg of legs) leg.tp = 4332
  const tps = resolveRangeBasketFinalTps({
    parsed: {},
    plan: null,
    familyTrades: legs,
    direction: 'buy',
  })
  assert.deepEqual(tps, [])
})

test('resolveRangeBasketFinalTps: prefers channel ladder over single open-leg TP', () => {
  const legs = Array.from({ length: 5 }, (_, i) =>
    openLeg(`i${i}`, 4335, `2026-01-01T00:00:0${i}Z`),
  )
  for (const leg of legs) leg.tp = 4332
  const tps = resolveRangeBasketFinalTps({
    parsed: {},
    plan: null,
    familyTrades: legs,
    channelTpLevels: [4332, 4334, 4336],
    direction: 'buy',
  })
  assert.deepEqual(tps, [4332, 4334, 4336])
})

test('buildRangeBasketTpTargets: stoplossOverride wins over anchor parsed.sl', () => {
  const legs = [
    { ...openLeg('a', 4255, '2026-01-01T00:00:00Z'), sl: null },
    { ...openLeg('b', 4252, '2026-01-01T00:00:01Z'), sl: null },
  ]
  const targets = buildRangeBasketTpTargets({
    familyTrades: legs,
    plan: null,
    parsed: { sl: 4245, tp: [4265, 4275] },
    tpLots: TP_LOTS,
    direction: 'buy',
    activePendingCount: 0,
    maxPendingStepIdx: 0,
    stoplossOverride: 4242,
  })
  assert.equal(targets.length, 2)
  assert.ok(targets.every(t => t.stoploss === 4242))
})

test('buildRangeBasketTpTargets: coerced string TPs produce non-zero phase B targets', () => {
  const legs = Array.from({ length: 4 }, (_, i) =>
    openLeg(`i${i}`, 4335 - i * 0.1, `2026-01-01T00:00:0${i}Z`),
  )
  const targets = buildRangeBasketTpTargets({
    familyTrades: legs,
    plan: null,
    parsed: { sl: 4300, tp: ['4345', '4355', '4360'] },
    tpLots: TP_LOTS,
    direction: 'buy',
    activePendingCount: 9,
    maxPendingStepIdx: 10,
    forceLayeringRebalance: true,
  })
  assert.equal(targets.length, 4)
  assert.ok(targets.every(t => t.takeprofit > 0))
  assert.ok(targets.some(t => t.takeprofit === 4345))
  assert.ok(targets.some(t => t.takeprofit === 4360))
})

test('resolveRangeTpRebalanceGate: allows instant_only and force layering', () => {
  assert.equal(
    resolveRangeTpRebalanceGate({
      activePendingCount: 5,
      maxPendingStepIdx: 10,
      phase: 'instant_only',
      hasClosedBasketLegs: false,
    }).allowOpenLegTpModify,
    true,
  )
  assert.equal(
    resolveRangeTpRebalanceGate({
      activePendingCount: 0,
      maxPendingStepIdx: 10,
      phase: 'layering_rebalance',
      forceLayeringRebalance: true,
      hasClosedBasketLegs: false,
    }).allowOpenLegTpModify,
    true,
  )
})

test('resolveRangeTpRebalanceGate: denies when layering complete or leg closed', () => {
  assert.equal(
    resolveRangeTpRebalanceGate({
      activePendingCount: 0,
      maxPendingStepIdx: 10,
      phase: 'layering_rebalance',
      hasClosedBasketLegs: false,
    }).allowOpenLegTpModify,
    false,
  )
  assert.equal(
    resolveRangeTpRebalanceGate({
      activePendingCount: 3,
      maxPendingStepIdx: 10,
      phase: 'layering_rebalance',
      hasClosedBasketLegs: true,
    }).reason,
    'basket_leg_closed',
  )
})

test('resolveRangeTpRebalanceGate: sticky TP touch freezes even under forceLayeringRebalance', () => {
  const gate = resolveRangeTpRebalanceGate({
    activePendingCount: 5,
    maxPendingStepIdx: 10,
    phase: 'layering_rebalance',
    forceLayeringRebalance: true,
    hasClosedBasketLegs: false,
    tpTouched: true,
  })
  assert.equal(gate.mode, 'backfill_only')
  assert.equal(gate.allowOpenLegTpModify, false)
  assert.equal(gate.reason, 'tp_touched')
})

test('resolveRangeTpRebalanceGate: redistributes while layering before any TP hit', () => {
  const gate = resolveRangeTpRebalanceGate({
    activePendingCount: 5,
    maxPendingStepIdx: 10,
    phase: 'layering_rebalance',
    forceLayeringRebalance: true,
    hasClosedBasketLegs: false,
    tpTouched: false,
  })
  assert.equal(gate.mode, 'redistribute')
  assert.equal(gate.allowOpenLegTpModify, true)
})

test('deepestFinalTp: buy uses max, sell uses min', () => {
  assert.equal(deepestFinalTp([4530, 4510, 4490], true), 4530)
  assert.equal(deepestFinalTp([4530, 4510, 4490], false), 4490)
  assert.equal(deepestFinalTp([], true), 0)
})

test('backfillNakedLegTakeProfits: assigns deepest TP to naked legs, never repaints others', () => {
  const legs = [
    { ...openLeg('a', 4335, '2026-01-01T00:00:00Z'), tp: 4490 },
    { ...openLeg('b', 4330, '2026-01-01T00:00:01Z'), tp: 0 },
    { ...openLeg('c', 4325, '2026-01-01T00:00:02Z'), tp: null as unknown as number },
  ]
  const out = backfillNakedLegTakeProfits(
    legs,
    [
      { stoploss: 4300, takeprofit: 9999 },
      { stoploss: 4300, takeprofit: 9999 },
      { stoploss: 4300, takeprofit: 9999 },
    ],
    [4530, 4510, 4490],
    true,
  )
  assert.equal(out[0]!.takeprofit, 4490, 'existing TP preserved, not repainted')
  assert.equal(out[1]!.takeprofit, 4530, 'naked leg gets deepest TP (buy=max)')
  assert.equal(out[2]!.takeprofit, 4530, 'null TP leg gets deepest TP')
})

test('fillZeroTargetsWithDeepest: only fills zero targets', () => {
  const out = fillZeroTargetsWithDeepest(
    [
      { stoploss: 4300, takeprofit: 4490 },
      { stoploss: 4300, takeprofit: 0 },
    ],
    [4530, 4510, 4490],
    true,
  )
  assert.equal(out[0]!.takeprofit, 4490)
  assert.equal(out[1]!.takeprofit, 4530)
})

test('every layering leg ends with SL and TP (Fix 1: no SL-only legs)', () => {
  const legs = Array.from({ length: 9 }, (_, i) =>
    openLeg(`i${i}`, 4335 - i * 0.1, `2026-01-01T00:00:0${i}Z`),
  )
  const targets = buildRangeBasketTpTargets({
    familyTrades: legs,
    plan: null,
    parsed: { sl: 4300, tp: [4530, 4510, 4490] },
    tpLots: TP_LOTS,
    direction: 'buy',
    activePendingCount: 3,
    maxPendingStepIdx: 10,
    forceLayeringRebalance: true,
  })
  const filled = fillZeroTargetsWithDeepest(targets, [4530, 4510, 4490], true)
  assert.equal(filled.length, 9)
  assert.ok(filled.every(t => t.stoploss > 0), 'all legs have SL')
  assert.ok(filled.every(t => t.takeprofit > 0), 'all legs have TP')
})

test('resolveFiringLegStops: latest effective SL overrides a stale leg SL', () => {
  const out = resolveFiringLegStops({
    legStoploss: 4100,
    legTakeprofit: 4490,
    cweClosePrice: null,
    effective: { stoploss: 4155, tpLevels: [4530, 4510, 4490] },
    isBuy: true,
  })
  assert.equal(out.stoploss, 4155)
  assert.equal(out.takeprofit, 4490, 'existing TP preserved, not repainted')
})

test('resolveFiringLegStops: naked leg gets deepest TP (buy=max), keeps effective SL', () => {
  const out = resolveFiringLegStops({
    legStoploss: 0,
    legTakeprofit: 0,
    cweClosePrice: null,
    effective: { stoploss: 4155, tpLevels: [4530, 4510, 4490] },
    isBuy: true,
  })
  assert.equal(out.stoploss, 4155)
  assert.equal(out.takeprofit, 4530)
})

test('resolveFiringLegStops: sell naked leg gets deepest TP (min)', () => {
  const out = resolveFiringLegStops({
    legStoploss: null,
    legTakeprofit: null,
    cweClosePrice: null,
    effective: { stoploss: 4180, tpLevels: [4150, 4140, 4130] },
    isBuy: false,
  })
  assert.equal(out.stoploss, 4180)
  assert.equal(out.takeprofit, 4130)
})

test('resolveFiringLegStops: CWE leg rides with no TP', () => {
  const out = resolveFiringLegStops({
    legStoploss: 4100,
    legTakeprofit: 4490,
    cweClosePrice: 4200,
    effective: { stoploss: 4155, tpLevels: [4530] },
    isBuy: true,
  })
  assert.equal(out.stoploss, 4155)
  assert.equal(out.takeprofit, 0)
})

test('resolveFiringLegStops: falls back to leg SL when effective SL is missing', () => {
  const out = resolveFiringLegStops({
    legStoploss: 4100,
    legTakeprofit: 0,
    cweClosePrice: null,
    effective: { stoploss: 0, tpLevels: [] },
    isBuy: true,
  })
  assert.equal(out.stoploss, 4100)
  assert.equal(out.takeprofit, 0)
})

test('preserveOpenLegTakeProfits keeps current leg TPs', () => {
  const legs = [openLeg('a', 4335, '2026-01-01T00:00:00Z'), openLeg('b', 4330, '2026-01-01T00:00:01Z')]
  legs[0]!.tp = 4340
  legs[1]!.tp = 4350
  const preserved = preserveOpenLegTakeProfits(legs, [
    { stoploss: 4300, takeprofit: 4530 },
    { stoploss: 4300, takeprofit: 4510 },
  ])
  assert.equal(preserved[0]!.takeprofit, 4340)
  assert.equal(preserved[1]!.takeprofit, 4350)
})

test('applyOpenLegStopLossToTargets: skipProtectiveMerge keeps the explicit resolved SL', () => {
  const legs = [
    { ...openLeg('a', 4165.25, '2026-01-01T00:00:00Z'), sl: 4164.25, direction: 'sell' as const },
    { ...openLeg('b', 4166, '2026-01-01T00:00:01Z'), sl: 4172.5, direction: 'sell' as const },
  ]
  const out = applyOpenLegStopLossToTargets(
    legs,
    [
      { stoploss: 4180, takeprofit: 4155 },
      { stoploss: 4180, takeprofit: 4150 },
    ],
    false,
    { skipProtectiveMerge: true },
  )
  // Explicit adjust (4180) is kept even though it loosens vs the 4164.25 leg.
  assert.ok(out.every(t => t.stoploss === 4180))
})

test('applyOpenLegStopLossToTargets: propagates sell breakeven SL to legs still on anchor', () => {
  const legs = [
    { ...openLeg('a', 4165.25, '2026-01-01T00:00:00Z'), sl: 4164.25, direction: 'sell' as const },
    { ...openLeg('b', 4165.25, '2026-01-01T00:00:01Z'), sl: 4172.5, direction: 'sell' as const },
  ]
  const applied = applyOpenLegStopLossToTargets(
    legs,
    [
      { stoploss: 4172.5, takeprofit: 4155 },
      { stoploss: 4172.5, takeprofit: 4150 },
    ],
    false,
  )
  assert.equal(applied[0]!.stoploss, 4164.25)
  assert.equal(applied[1]!.stoploss, 4164.25)
})

test('buildRangeBasketTpTargets: sell rebalance copies breakeven SL from open legs', () => {
  const legs = [
    { ...openLeg('a', 4165.25, '2026-01-01T00:00:00Z'), sl: 4164.25, direction: 'sell' as const },
    { ...openLeg('b', 4166, '2026-01-01T00:00:01Z'), sl: 4172.5, direction: 'sell' as const },
  ]
  const targets = buildRangeBasketTpTargets({
    familyTrades: legs,
    plan: null,
    parsed: { sl: 4172.5, tp: [4155, 4150] },
    tpLots: TP_LOTS,
    direction: 'sell',
    activePendingCount: 0,
    maxPendingStepIdx: 10,
    forceLayeringRebalance: true,
  })
  assert.ok(targets.every(t => t.stoploss === 4164.25))
})
