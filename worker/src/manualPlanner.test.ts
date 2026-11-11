import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  clampPendingExpiryHours,
  computeCwOverrideTp,
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  planRangeSplit,
  planSinglePartialTps,
  resolvedParsedEntryPrice,
  reverseSignalGateSatisfied,
  signalEntryPriceStrictEnabled,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  type ManualSettings,
  type ParsedSignal,
  type PlannerContext,
} from './manualPlanner'
import type { PlannerCloseWorseEntries } from './manualPlanning/types'
import { triggerPriceFor } from './tradeExecutor/helpers'
import { buildRangeLayerTriggerMap } from './manualPlanning/rangeLayerTriggers'
import { pipCalculator } from './pipCalculator'

const baseSplit = {
  totalLegs: 20,
  baseIsPendingSignal: false,
  rangeOn: true,
  rangePct: 50,
  stepPips: 10,
  distPips: 100,
  pip: 0.01,
  minStepPriceUnits: 0,
  hasSignalAnchor: true,
}

test('planRangeSplit: range off → all immediates', () => {
  const r = planRangeSplit({ ...baseSplit, rangeOn: false })
  assert.equal(r.immediateLegs, 20)
  assert.equal(r.pendingLegs, 0)
})

test('planRangeSplit: pending signal disables range', () => {
  const r = planRangeSplit({ ...baseSplit, baseIsPendingSignal: true })
  assert.equal(r.pendingLegs, 0)
  assert.equal(r.immediateLegs, 20)
  assert.equal(r.fallbackReason, 'range_trading_skip_pending_signal')
})

test('planRangeSplit: invalid distance → fallback', () => {
  const r = planRangeSplit({ ...baseSplit, distPips: 0 })
  assert.equal(r.fallbackReason, 'range_trading_invalid')
  assert.equal(r.pendingLegs, 0)
})

test('planRangeSplit: step 0 = Auto fills distance with reserved legs', () => {
  // 20 legs, 50% → 10 reserved; Auto step = 100/10 = 10; all 10 active
  const r = planRangeSplit({ ...baseSplit, stepPips: 0 })
  assert.equal(r.pendingLegs, 10)
  assert.equal(r.activePendingLegs, 10)
  assert.equal(r.maxStepIdx, 10)
  assert.equal(r.effectiveStepPips, 10)
  assert.equal(r.fallbackReason, 'range_trading_step_auto')
})

test('planRangeSplit: Auto min 1-pip floor reduces active legs', () => {
  // 40 legs, 50% → 20 reserved; dist 10 → max 10 active at 1 pip (not 0.5)
  const r = planRangeSplit({ ...baseSplit, totalLegs: 40, stepPips: 0, distPips: 10 })
  assert.equal(r.pendingLegs, 20)
  assert.equal(r.activePendingLegs, 10)
  assert.equal(r.maxStepIdx, 10)
  assert.equal(r.effectiveStepPips, 1)
  assert.equal(r.fallbackReason, 'range_trading_step_auto_min_capped')
})

test('planRangeSplit: forceAutoStep ignores manual step', () => {
  const r = planRangeSplit({ ...baseSplit, stepPips: 25, forceAutoStep: true })
  assert.equal(r.activePendingLegs, 10)
  assert.equal(r.effectiveStepPips, 10)
  assert.equal(r.fallbackReason, 'range_trading_step_auto')
})

test('planRangeSplit: 50% × 20 legs → 10 pendings @ 10 pip step', () => {
  const r = planRangeSplit(baseSplit)
  assert.equal(r.immediateLegs, 10)
  assert.equal(r.pendingLegs, 10)
  assert.equal(r.activePendingLegs, 10)
  assert.equal(r.maxStepIdx, 10)
  assert.equal(r.effectiveStepPips, 10)
  assert.ok(Math.abs(r.stepPriceOffset - 0.1) < 1e-9) // 10 × 0.01
  assert.equal(r.fallbackReason, undefined)
})

test('planRangeSplit: distance caps active legs but reserved count stays stable', () => {
  const r = planRangeSplit({ ...baseSplit, distPips: 30 })
  assert.equal(r.pendingLegs, 10)
  assert.equal(r.immediateLegs, 10)
  assert.equal(r.maxStepIdx, 3)
  assert.equal(r.activePendingLegs, 3)
  assert.equal(r.effectiveStepPips, 10)
  assert.equal(r.fallbackReason, 'range_trading_distance_capped')
})

test('planRangeSplit: step changes spacing but not reserved count', () => {
  const small = planRangeSplit({ ...baseSplit, stepPips: 5 })
  const big = planRangeSplit({ ...baseSplit, stepPips: 25 })
  assert.equal(small.pendingLegs, 10)
  assert.equal(big.pendingLegs, 10)
  assert.equal(small.immediateLegs, 10)
  assert.equal(big.immediateLegs, 10)
  assert.equal(small.activePendingLegs, 10)
  assert.equal(big.activePendingLegs, 4)
  assert.equal(small.effectiveStepPips, 5)
  assert.equal(big.effectiveStepPips, 25)
  assert.equal(big.fallbackReason, 'range_trading_distance_capped')
})

test('planRangeSplit: auto-expands step when below broker minimum', () => {
  // pip = 0.01, configured step = 2 pips = 0.02 price units, but broker requires 1.02.
  // ceil(1.02 / 0.01) = 102 pips.
  const r = planRangeSplit({ ...baseSplit, stepPips: 2, minStepPriceUnits: 1.02 })
  assert.equal(r.effectiveStepPips, 102)
  assert.equal(r.fallbackReason, 'range_trading_step_auto_expanded')
})

test('planRangeSplit: skipMinStepExpansion keeps user step for pending order ladder', () => {
  const r = planRangeSplit({
    ...baseSplit,
    stepPips: 3,
    distPips: 30,
    minStepPriceUnits: 1.02,
    skipMinStepExpansion: true,
  })
  assert.equal(r.effectiveStepPips, 3)
  assert.equal(r.maxStepIdx, 10)
  assert.equal(r.stepPriceOffset, 0.03)
  assert.equal(r.fallbackReason, undefined)
})

test('planRangeSplit: no signal anchor + no immediates → runtime-only fallback', () => {
  // 100% range = 0 immediates; without a signal anchor the executor must resolve via /Quote.
  // After the May-12 fix, distance no longer caps the pending count, so all 20
  // baseLegs land in the pending bucket.
  const r = planRangeSplit({ ...baseSplit, rangePct: 100, hasSignalAnchor: false })
  assert.equal(r.immediateLegs, 0)
  assert.equal(r.pendingLegs, 20)
  assert.equal(r.fallbackReason, 'range_trading_anchor_runtime_only')
})

test('computeCwOverrideTp: buy → anchor + pips × pip', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 2, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 1850, isBuy: true, pip: 0.01, digits: 2, minStopDistance: 1.02,
  })
  assert.equal(out, 1850.3)
})

test('computeCwOverrideTp: ignores broker stops/freeze floor (worker-managed close)', () => {
  // 30 pips on EURUSD 5-digit = 0.003 price units. Previously this was
  // clamped to 0.005 because the value was being sent as a broker TP.
  // Post May-12 redesign the threshold is only ever compared against a
  // live quote inside cweCloseMonitor — never sent as a TP — so clamping
  // would silently shift the close trigger further than the user asked.
  const policy: PlannerCloseWorseEntries = { immediates: 1, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 1.10000, isBuy: true, pip: 0.0001, digits: 5, minStopDistance: 0.005,
  })
  assert.equal(out, 1.103)
})

test('computeCwOverrideTp: sell direction inverts override', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 1850, isBuy: false, pip: 0.01, digits: 2, minStopDistance: 0,
  })
  assert.equal(out, 1849.7)
})

test('computeCwOverrideTp: zero anchor returns null', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 0, isBuy: true, pip: 0.01, digits: 2, minStopDistance: 0,
  })
  assert.equal(out, null)
})

test('computeCwOverrideTp: zero pipsFromAnchor returns null', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, pipsFromAnchor: 0 }
  const out = computeCwOverrideTp({
    policy, anchor: 1850, isBuy: true, pip: 0.01, digits: 2, minStopDistance: 0,
  })
  assert.equal(out, null)
})

// ── Virtual leg materialization from planManualOrders ──────────────────────

const baseCtx: PlannerContext = {
  point: 0.01,
  digits: 2,
  minLot: 0.01,
  lotStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  defaultLot: 0.01,
  lastBalance: null,
  now: new Date('2026-05-12T12:00:00Z'),
}

const baseParsed: ParsedSignal = {
  action: 'buy',
  symbol: 'XAUUSD',
  entry_price: null, // market signal — no explicit entry; executor will resolve via /Quote
  entry_zone_low: null,
  entry_zone_high: null,
  sl: null,
  tp: [1900],
  lot_size: null,
}

const baseManual: ManualSettings = {
  risk_mode: 'fixed_lot',
  fixed_lot: 1.0,
  trade_style: 'multi',
  multi_trade_leg_percent: 10,       // 10% per leg → 10 legs from 1.0 lot
  // These tests verify range/leg geometry — disable burst consolidation so
  // immediate order counts equal granular leg counts.
  multi_trade_max_orders: 100,
  range_trading: true,
  range_percent: 50,                  // half immediates, half virtual pendings
  range_step_pips: 10,
  range_distance_pips: 100,
  tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  pending_expiry_hours: 4,
}

// ── Burst consolidation (multi_trade_max_orders) ────────────────────────────

test('planMultiManualOrders: default sends one order per granular leg (no consolidation)', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_max_orders: undefined,
    multi_trade_leg_percent: 5, // 5% per leg → 20 legs from 1.0 lot
    range_trading: false,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
    ],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900, 1910] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 20)
  const totalVolume = plan.orders.reduce((s, o) => s + Number(o.volume), 0)
  assert.ok(Math.abs(totalVolume - 1.0) < 1e-9)
})

test('planMultiManualOrders: falls back to single trade when per-leg % is below broker min', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 5,
    range_trading: false,
    tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.1,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.equal(Number(plan.orders[0]?.volume), 0.1)
})

test('planMultiManualOrders: dynamic range trading opens multiple immediates when burst cap matches preview', () => {
  const manual: ManualSettings = {
    ...baseManual,
    risk_mode: 'dynamic_balance_percent',
    dynamic_balance_percent: 11,
    multi_trade_leg_percent: 3,
    multi_trade_max_orders: 34,
    range_trading: true,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
    range_layering_type: 'pending_order',
    tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 3.42,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 17)
  assert.equal(plan.virtualPendings?.length, 10)
  const totalVolume = plan.orders.reduce((s, o) => s + Number(o.volume), 0)
  assert.ok(Math.abs(totalVolume - 1.7) < 1e-6)
})

test('planMultiManualOrders: 100% BUY range can produce zero immediates plus one deferred dip leg', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_price: 2400,
      sl: 2390,
      tp: [2410],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      fixed_lot: 0.01,
      multi_trade_leg_percent: 100,
      multi_trade_max_orders: 1,
      range_percent: 100,
      range_step_pips: 10,
      range_distance_pips: 10,
    },
    channelKeywords: null,
    manualLot: 0.01,
    ctx: baseCtx,
    commentPrefix: 'TScopier:aug11',
  })
  assert.equal(plan.orders.length, 0)
  assert.equal((plan.virtualPendings ?? []).length, 1)
  assert.equal(plan.rangeLayering?.plannedImmediateLegs, 0)
  assert.equal(plan.rangeLayering?.activePendingLegs, 1)
  assert.equal(plan.skip_reason, undefined)
  assert.equal(plan.virtualPendings?.[0]?.isBuy, true)
})

test('planMultiManualOrders: 100% SELL range can produce zero immediates plus one deferred rally leg', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      action: 'sell',
      entry_price: 2400,
      sl: 2410,
      tp: [2390],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual: {
      ...baseManual,
      fixed_lot: 0.01,
      multi_trade_leg_percent: 100,
      multi_trade_max_orders: 1,
      range_percent: 100,
      range_step_pips: 10,
      range_distance_pips: 10,
    },
    channelKeywords: null,
    manualLot: 0.01,
    ctx: baseCtx,
    commentPrefix: 'TScopier:aug11',
  })
  assert.equal(plan.orders.length, 0)
  assert.equal((plan.virtualPendings ?? []).length, 1)
  assert.equal(plan.rangeLayering?.plannedImmediateLegs, 0)
  assert.equal(plan.rangeLayering?.activePendingLegs, 1)
  assert.equal(plan.skip_reason, undefined)
  assert.equal(plan.virtualPendings?.[0]?.isBuy, false)
})

test('planMultiManualOrders: override SL freezes absolute price from first entry for all range legs', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_price: 2650,
      sl: 2600,
      tp: [2700],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      multi_trade_leg_percent: 50,
      range_percent: 100,
      range_step_pips: 10,
      range_distance_pips: 100,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length >= 2, `expected >=2 range legs, got ${virtuals.length}`)
  const pip = plan.pip ?? 0
  assert.ok(pip > 0)
  const expectedSl = Number((2650 - 80 * pip).toFixed(2))
  assert.equal(virtuals[0]!.stoploss, expectedSl)
  assert.equal(virtuals[1]!.stoploss, expectedSl)
  assert.equal(virtuals[0]!.stoploss, virtuals[1]!.stoploss)
})

test('planMultiManualOrders: empty-TP range override SL still freezes from first entry', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_price: 2650,
      sl: 2600,
      tp: [],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      multi_trade_leg_percent: 50,
      range_percent: 100,
      range_step_pips: 10,
      range_distance_pips: 100,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length >= 2)
  const pip = plan.pip ?? 0
  assert.ok(pip > 0)
  const expectedSl = Number((2650 - 80 * pip).toFixed(2))
  assert.equal(virtuals[0]!.stoploss, expectedSl)
  assert.equal(virtuals[1]!.stoploss, expectedSl)
})

test('planMultiManualOrders: override TP ladder freezes from first entry across range legs', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_price: 2650,
      sl: 2600,
      tp: [2700],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      multi_trade_leg_percent: 25,
      range_percent: 100,
      range_step_pips: 10,
      range_distance_pips: 100,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [30, 50, 80],
      tp_lots: [
        { label: 'TP1', lot: 0, percent: 34, enabled: true },
        { label: 'TP2', lot: 0, percent: 33, enabled: true },
        { label: 'TP3', lot: 0, percent: 33, enabled: true },
      ],
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length >= 3, `expected >=3 range legs, got ${virtuals.length}`)
  const pip = plan.pip ?? 0
  assert.ok(pip > 0)
  const ladder = [30, 50, 80].map((pips) => Number((2650 + pips * pip).toFixed(2)))
  for (const v of virtuals) {
    assert.ok(
      ladder.includes(Number(v.takeprofit)),
      `range TP ${v.takeprofit} should be one of frozen ladder ${ladder.join(',')}`,
    )
  }
  const uniqueTps = new Set(virtuals.map((v) => v.takeprofit))
  assert.ok(uniqueTps.size >= 2, 'Targets % should still distribute the frozen ladder across legs')
})
test('planMultiManualOrders: passes rangeLayeringType from manual settings', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_trading: true,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
    range_layering_type: 'pending_order',
    tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.5,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.rangeLayering?.rangeLayeringType, 'pending_order')
})

test('planMultiManualOrders: rangeLayeringType defaults to auto', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_trading: true,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
    tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.5,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.rangeLayering?.rangeLayeringType, 'auto')
})

test('planMultiManualOrders: pending_order uses step/distance rungs despite broker min stop', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_trading: true,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
    range_layering_type: 'pending_order',
    tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900], entry_price: 4500 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual,
    channelKeywords: null,
    manualLot: 0.5,
    ctx: { ...baseCtx, stopsLevel: 100, freezeLevel: 0, point: 0.01 },
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.rangeLayering?.maxStepIdx, 10)
  assert.equal(plan.rangeLayering?.effectiveStepPips, 3)
  const v = plan.virtualPendings ?? []
  assert.ok(v.length > 0)
  const triggers = v.map(leg => triggerPriceFor(leg, 4500, 2))
  const distinct = new Set(triggers)
  assert.ok(distinct.size >= 3, `expected multiple ladder prices, got ${[...distinct].join(', ')}`)
})

test('planMultiManualOrders: pending_order caps legs to activePending (no reserved overshoot)', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_trading: true,
    range_percent: 70,
    range_step_pips: 2,
    range_distance_pips: 6,
    range_layering_type: 'pending_order',
    tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900], entry_price: 4500 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual,
    channelKeywords: null,
    manualLot: 0.5,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  // 0.5 @ 10% → 10 legs; 70% reserved = 7; maxStepIdx = floor(6/2) = 3 → active 3
  const v = plan.virtualPendings ?? []
  assert.equal(plan.rangeLayering?.reservedPendingLegs, 7)
  assert.equal(plan.rangeLayering?.activePendingLegs, 3)
  assert.equal(v.length, 3)
  assert.equal(plan.orders.length + v.length, plan.rangeLayering?.basketLegCap)
  assert.ok((plan.orders.length + v.length) <= 10)
  assert.equal(plan.orders.length, 3)
})

test('planMultiManualOrders: stale burst cap of 1 consolidates dynamic range into one order (regression)', () => {
  const manual: ManualSettings = {
    ...baseManual,
    risk_mode: 'dynamic_balance_percent',
    dynamic_balance_percent: 11,
    multi_trade_leg_percent: 3,
    multi_trade_max_orders: 1,
    range_trading: true,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
    tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 3.42,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.ok(Math.abs(Number(plan.orders[0]?.volume) - 1.7) < 1e-6)
})

test('planMultiManualOrders: explicit cap consolidates legs, volume + TP split preserved', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_max_orders: 8,
    multi_trade_leg_percent: 5,
    range_trading: false,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
    ],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900, 1910] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 8)
  const totalVolume = plan.orders.reduce((s, o) => s + Number(o.volume), 0)
  assert.ok(Math.abs(totalVolume - 1.0) < 1e-9)
  const byTp = new Map<number, number>()
  for (const o of plan.orders) {
    const tp = Number(o.takeprofit)
    byTp.set(tp, (byTp.get(tp) ?? 0) + Number(o.volume))
  }
  assert.equal(byTp.size, 2)
  assert.ok(Math.abs((byTp.get(1900) ?? 0) - 0.5) < 1e-9)
  assert.ok(Math.abs((byTp.get(1910) ?? 0) - 0.5) < 1e-9)
  // Normal multi still tags comments with :tpN (not naked prefix clones).
  assert.ok(plan.orders.every(o => /:tp\d+/.test(String(o.comment ?? ''))))
})

test('planMultiManualOrders: empty finalTps without range uses one full-lot immediate (teaser)', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 10,
    multi_trade_max_orders: 10,
    range_trading: false,
    tp_lots: [{ label: 'TP', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [], sl: null },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.4,
    ctx: baseCtx,
    commentPrefix: 'TScopier:44sClub:979b6ac0',
  })
  assert.equal(plan.orders.length, 1)
  assert.ok(Math.abs(Number(plan.orders[0]?.volume) - 0.4) < 1e-9)
  assert.equal(plan.fallback_reason, 'multi_trade_fallback_empty_tps')
  assert.equal((plan.virtualPendings ?? []).length, 0)
  // Comment stays the single-order prefix (no :tp1/:tp2 clones).
  assert.equal(plan.orders[0]?.comment, 'TScopier:44sClub:979b6ac0')
})

test('planMultiManualOrders: empty finalTps with range emits one order per instant leg', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 10,
    multi_trade_max_orders: 10,
    range_trading: true,
    range_percent: 30,
    range_step_pips: 5,
    range_distance_pips: 15,
    tp_lots: [{ label: 'TP', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [], sl: null },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.4,
    ctx: baseCtx,
    commentPrefix: 'TScopier:44sClub:979b6ac0',
  })
  // 10 legs @ 0.04; 30% reserved → 3 range + 7 immediate → 7×0.04 (not 1×0.28)
  assert.equal(plan.orders.length, 7)
  assert.ok(plan.orders.every(o => Math.abs(Number(o.volume) - 0.04) < 1e-9))
  const immVol = plan.orders.reduce((s, o) => s + Number(o.volume), 0)
  assert.ok(Math.abs(immVol - 0.28) < 1e-9)
  assert.equal((plan.virtualPendings ?? []).length, 3)
  assert.ok((plan.virtualPendings ?? []).every(v => Math.abs(Number(v.volume) - 0.04) < 1e-9))
  assert.equal(plan.fallback_reason, 'multi_trade_fallback_empty_tps')
  assert.ok(plan.orders.every(o => /:tp\d+/.test(String(o.comment ?? ''))))
})

test('planMultiManualOrders: empty finalTps staging-like range fires 6×leg not 1×bundle', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 6,
    multi_trade_max_orders: 16,
    range_trading: true,
    range_percent: 60,
    range_step_pips: 0,
    range_distance_pips: 100,
    range_layering_type: 'auto',
    tp_lots: [{ label: 'TP', lot: 0, percent: 100, enabled: true }],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [], sl: null, entry_price: 64969.04 },
    resolvedSymbol: 'BTCUSD',
    baseOperation: 'Sell',
    manual,
    channelKeywords: null,
    manualLot: 2,
    ctx: { ...baseCtx, digits: 2 },
    commentPrefix: 'TScopier:SIGNALSTESTE:73a33d33',
  })
  // 16 legs @ 0.12; 60% reserved → 10 range + 6 immediate → 6×0.12 (not 1×0.72)
  assert.equal(plan.orders.length, 6)
  assert.ok(plan.orders.every(o => Math.abs(Number(o.volume) - 0.12) < 1e-9))
  const immVol = plan.orders.reduce((s, o) => s + Number(o.volume), 0)
  assert.ok(Math.abs(immVol - 0.72) < 1e-9)
  assert.equal((plan.virtualPendings ?? []).length, 10)
  assert.ok((plan.virtualPendings ?? []).every(v => Math.abs(Number(v.volume) - 0.12) < 1e-9))
  assert.equal(plan.rangeLayering?.plannedImmediateLegs, 6)
  assert.equal(plan.rangeLayering?.activePendingLegs, 10)
})

test('planMultiManualOrders: cap of 2 emits one consolidated order per TP', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_max_orders: 2,
    multi_trade_leg_percent: 10, // 10 legs
    range_trading: false,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
    ],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900, 1910] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 2)
  assert.ok(Math.abs(Number(plan.orders[0]!.volume) - 0.5) < 1e-9)
  assert.ok(Math.abs(Number(plan.orders[1]!.volume) - 0.5) < 1e-9)
  assert.equal(Number(plan.orders[0]!.takeprofit), 1900)
  assert.equal(Number(plan.orders[1]!.takeprofit), 1910)
})

test('planMultiManualOrders: cap never drops below distinct TP count', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_max_orders: 1, // fewer than distinct TPs — must still emit 2
    multi_trade_leg_percent: 10,
    range_trading: false,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
    ],
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900, 1910] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 2)
})

test('planMultiManualOrders: cap larger than leg count leaves granular legs untouched', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_max_orders: 100,
    multi_trade_leg_percent: 10,
    range_trading: false,
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, tp: [1900] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 10)
  for (const o of plan.orders) {
    assert.ok(Math.abs(Number(o.volume) - 0.1) < 1e-9)
  }
})

test('planManualOrders: range emits virtualPendings (not OrderSendArgs)', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  // 10 legs total, 50% pendings → 5 immediates + 5 virtuals.
  assert.equal(plan.orders.length, 5)
  assert.equal(plan.virtualPendings?.length, 5)
  assert.equal(plan.rangeLayering?.reservedPendingLegs, 5)
  assert.equal(plan.rangeLayering?.activePendingLegs, 5)
  // No pending operations leaked into plan.orders.
  for (const o of plan.orders) {
    assert.ok(!String(o.operation).includes('Limit'))
    assert.ok(!String(o.operation).includes('Stop'))
  }
  // Virtual pendings carry the metadata needed for trigger_price computation.
  const virtuals = plan.virtualPendings!
  for (let i = 0; i < virtuals.length; i++) {
    const v = virtuals[i]!
    assert.equal(v.isBuy, true)
    assert.equal(v.stepIdx, i + 1)
    assert.ok(v.stepPriceOffset > 0)
    assert.equal(v.expiryHours, 4)
  }
})

test('planManualOrders: XAUUSD range 30/3/50% spans 30 pips across 10 layering legs', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 5,
    range_step_pips: 3,
    range_distance_pips: 30,
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 2650 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 10)
  assert.equal(plan.virtualPendings?.length, 10)
  const rl = plan.rangeLayering
  assert.ok(rl)
  assert.equal(rl.rangeStepPips, 3)
  assert.equal(rl.rangeDistancePips, 30)
  assert.equal(rl.effectiveStepPips, 3)
  assert.equal(rl.maxStepIdx, 10)
  assert.equal(rl.reservedPendingLegs, 10)
  assert.equal(rl.activePendingLegs, 10)
  assert.ok(Math.abs(rl.stepPriceOffset - 0.3) < 1e-9)

  const virtuals = plan.virtualPendings!
  assert.equal(virtuals[0]!.stepIdx, 1)
  assert.equal(virtuals[9]!.stepIdx, 10)
  assert.ok(Math.abs(virtuals[0]!.stepPriceOffset - 0.3) < 1e-9)

  const first = triggerPriceFor(virtuals[0]!, 2650, 2)
  const last = triggerPriceFor(virtuals[9]!, 2650, 2)
  assert.equal(first, 2649.7)
  assert.equal(last, 2647)
})

test('planManualOrders: XAUUSD trader-pip layering at 2350.50 spans 30 pips in 3-pip steps', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_percent: 100,
    range_step_pips: 3,
    range_distance_pips: 30,
  }
  const anchor = 2350.5
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: anchor },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const virtuals = plan.virtualPendings ?? []
  assert.equal(virtuals.length, 10)
  const first = triggerPriceFor(virtuals[0]!, anchor, 2)
  const last = triggerPriceFor(virtuals[virtuals.length - 1]!, anchor, 2)
  assert.equal(first, 2350.2)
  assert.equal(last, 2347.5)
})

test('planManualOrders: range distance caps layering when reserved exceeds floor(dist/step)', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 2.5,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
    range_layering_type: 'pending_order',
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 2650 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 4.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  // 4.0 lot @ 2.5% → 40 legs; 50% reserved → 20 pending; floor(30/3) → 10 active.
  assert.equal(plan.rangeLayering?.reservedPendingLegs, 20)
  assert.equal(plan.rangeLayering?.activePendingLegs, 10)
  assert.equal(plan.virtualPendings?.length, 10)
  assert.equal(plan.fallback_reason, 'range_trading_distance_capped')
})

test('planManualOrders: Total Open Trades hard ceiling 8 instant + 8 layering = 16 (never doubles)', () => {
  // 1.92 @ 6.25% → 16 legs; 50% reserved → 8+8 when distance covers reserved.
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 6.25,
    multi_trade_max_orders: 32, // stale/oversize basket seed must not raise the ceiling
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30, // floor(30/3)=10 >= reserved 8
    range_layering_type: 'pending_order',
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 2650, tp: [2700] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.92,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const v = plan.virtualPendings ?? []
  assert.equal(plan.orders.length, 8)
  assert.equal(v.length, 8)
  assert.equal(plan.rangeLayering?.plannedImmediateLegs, 8)
  assert.equal(plan.rangeLayering?.activePendingLegs, 8)
  assert.equal(plan.rangeLayering?.basketLegCap, 16)
  assert.equal(plan.orders.length + v.length, 16)
  assert.ok(plan.orders.length + v.length <= 16)
})

test('planManualOrders: Total Open Trades ceiling holds when multi_trade_max_orders is unset', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 6.25,
    multi_trade_max_orders: undefined,
    range_percent: 50,
    range_step_pips: 3,
    range_distance_pips: 30,
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 2650, tp: [2700] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.92,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const v = plan.virtualPendings ?? []
  assert.equal(plan.rangeLayering?.basketLegCap, 16)
  assert.equal(plan.orders.length + v.length, 16)
})

test('planManualOrders: Auto step (0) fills distance with reserved legs', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 3,
    range_percent: 50,
    range_step_pips: 0,
    range_distance_pips: 50,
    range_layering_type: 'auto',
  }
  const plan = planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSDm',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 5.0,
    ctx: {
      ...baseCtx,
      stopsLevel: 100,
    },
    commentPrefix: 'TScopier:abc',
  })
  // 5.0 @ 3% → 33 legs; 50% → 17 reserved; Auto step = 50/17
  assert.ok((plan.virtualPendings?.length ?? 0) > 0)
  assert.equal(plan.rangeLayering?.activePendingLegs, 17)
  assert.ok(Math.abs((plan.rangeLayering?.effectiveStepPips ?? 0) - (50 / 17)) < 1e-9)
  assert.equal(plan.fallback_reason, 'range_trading_step_auto')
})

test('planManualOrders: broker pending Auto spreads N unique rungs across full distance', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 3,
    range_percent: 50,
    range_step_pips: 0,
    range_distance_pips: 100,
    range_layering_type: 'pending_order',
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 4000 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 5.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  // 5.0 @ 3% → 33 legs; 50% → 17 reserved; Auto → all 17 across 100 pips
  const virtuals = plan.virtualPendings ?? []
  assert.equal(plan.rangeLayering?.activePendingLegs, 17)
  assert.equal(virtuals.length, 17)
  assert.ok(Math.abs((plan.rangeLayering?.effectiveStepPips ?? 0) - (100 / 17)) < 1e-9)
  assert.equal(plan.rangeLayering?.effectiveDistancePips, 100)
  const stepIdxs = virtuals.map(v => v.stepIdx)
  assert.deepEqual(stepIdxs, Array.from({ length: 17 }, (_, i) => i + 1))
  assert.equal(new Set(stepIdxs).size, 17)

  const triggerMap = buildRangeLayerTriggerMap({
    virtualPendings: virtuals,
    anchor: 4000,
    digits: 2,
    rangeLayering: plan.rangeLayering ?? null,
    pip: plan.pip,
  })
  assert.equal(triggerMap.size, 17)
  const prices = [...triggerMap.values()]
  assert.equal(new Set(prices.map(p => p.toFixed(2))).size, 17)
  const span = Math.abs(prices[0]! - prices[prices.length - 1]!)
  // Nearly full 100-pip span (first rung is one step from anchor; last near boundary)
  assert.ok(span > 90 * (plan.pip ?? 0.1), `span ${span} should cover most of 100 pips`)
})

test('planManualOrders: virtual Manual step distance-caps active legs', () => {
  const manual: ManualSettings = {
    ...baseManual,
    multi_trade_leg_percent: 3,
    range_percent: 50,
    range_step_pips: 10,
    range_distance_pips: 50,
    range_layering_type: 'auto',
  }
  const plan = planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSDm',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 5.0,
    ctx: {
      ...baseCtx,
      stopsLevel: 100,
    },
    commentPrefix: 'TScopier:abc',
  })
  // 5.0 @ 3% → 33 legs; 50% → 17 reserved; floor(50/10) → 5 active
  assert.equal(plan.rangeLayering?.reservedPendingLegs, 17)
  assert.equal(plan.rangeLayering?.activePendingLegs, 5)
  assert.equal(plan.rangeLayering?.effectiveStepPips, 10)
  assert.equal(plan.fallback_reason, 'range_trading_distance_capped')
})

test('planManualOrders: multi + BuyLimit + range uses market immediates but still emits virtual pendings', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'BuyLimit',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 5)
  assert.equal(plan.virtualPendings?.length, 5)
  for (const o of plan.orders) {
    assert.equal(o.operation, 'Buy')
    assert.equal(o.price, 0)
  }
})

test('planManualOrders: range off → no virtualPendings', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: { ...baseManual, range_trading: false },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.virtualPendings, undefined)
  assert.equal(plan.orders.length, 10) // all 10 legs are immediates
})

test('planManualOrders: multi + 3 signal TPs uses Targets % on each leg', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_price: 4550,
      sl: 4570,
      tp: [4530, 4510, 4490],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual: {
      ...baseManual,
      range_trading: false,
      multi_trade_leg_percent: 10,
      tp_lots: [
        { label: 'TP1', lot: 0, percent: 50, enabled: true },
        { label: 'TP2', lot: 0, percent: 30, enabled: true },
        { label: 'TP3', lot: 0, percent: 20, enabled: true },
      ],
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 10)
  assert.equal(plan.orders.filter(o => o.takeprofit === 4530).length, 5)
  assert.equal(plan.orders.filter(o => o.takeprofit === 4510).length, 3)
  assert.equal(plan.orders.filter(o => o.takeprofit === 4490).length, 2)
})

test('planManualOrders: multi + range applies Targets % separately to instant and range pools', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_price: 4550,
      sl: 4570,
      tp: [4530, 4510, 4490],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual: {
      ...baseManual,
      range_trading: true,
      range_percent: 50,
      multi_trade_leg_percent: 10,
      tp_lots: [
        { label: 'TP1', lot: 0, percent: 50, enabled: true },
        { label: 'TP2', lot: 0, percent: 30, enabled: true },
        { label: 'TP3', lot: 0, percent: 20, enabled: true },
      ],
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 5)
  assert.equal(plan.virtualPendings?.length, 5)
  // Instant pool (5 legs): 50/30/20 → 3 / 2 / 0
  assert.equal(plan.orders.filter(o => o.takeprofit === 4530).length, 3)
  assert.equal(plan.orders.filter(o => o.takeprofit === 4510).length, 2)
  assert.equal(plan.orders.filter(o => o.takeprofit === 4490).length, 0)
  // Range pool (5 legs): same % split on the remaining TP ladder
  const rangeTps = (plan.virtualPendings ?? []).map(v => v.takeprofit)
  assert.equal(rangeTps.filter(tp => tp === 4510).length, 3)
  assert.equal(rangeTps.filter(tp => tp === 4490).length, 2)
  assert.equal(rangeTps.filter(tp => tp === 4530).length, 0)
})

test('planManualOrders: multi + BuyLimit → market immediates (price 0; avoids MT invalid pending price)', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 2650 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'BuyLimit',
    manual: { ...baseManual, range_trading: false },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 10)
  for (const o of plan.orders) {
    assert.equal(o.operation, 'Buy')
    assert.equal(o.price, 0)
  }
})

test('planManualOrders: sell ladder → virtualPendings carry isBuy=false', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, action: 'sell', entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length > 0)
  for (const v of virtuals) {
    assert.equal(v.isBuy, false)
  }
})

test('strictSignalEntryQuoteAllowsImmediate: buy when ask at or below entry', () => {
  assert.equal(strictSignalEntryQuoteAllowsImmediate({ isBuy: true, entryPrice: 4500, bid: 4499, ask: 4500 }), true)
  assert.equal(strictSignalEntryQuoteAllowsImmediate({ isBuy: true, entryPrice: 4500, bid: 4490, ask: 4499 }), true)
})

test('strictSignalEntryQuoteAllowsImmediate: buy false when ask above entry', () => {
  assert.equal(strictSignalEntryQuoteAllowsImmediate({ isBuy: true, entryPrice: 4500, bid: 4499, ask: 4500.01 }), false)
})

test('strictSignalEntryQuoteAllowsImmediate: sell when bid at or above entry', () => {
  assert.equal(strictSignalEntryQuoteAllowsImmediate({ isBuy: false, entryPrice: 4500, bid: 4500, ask: 4501 }), true)
  assert.equal(strictSignalEntryQuoteAllowsImmediate({ isBuy: false, entryPrice: 4500, bid: 4510, ask: 4511 }), true)
})

test('strictSignalEntryQuoteAllowsImmediate: sell false when bid below entry', () => {
  assert.equal(strictSignalEntryQuoteAllowsImmediate({ isBuy: false, entryPrice: 4500, bid: 4499.99, ask: 4501 }), false)
})

test('strictSignalEntryQuoteAllowsImmediate: pip tolerance widens immediate window', () => {
  const pip = 0.1
  assert.equal(
    strictSignalEntryQuoteAllowsImmediate({
      isBuy: true,
      entryPrice: 4500,
      bid: 4499,
      ask: 4500.5,
      tolerancePips: 10,
      pipSize: pip,
    }),
    true,
  )
  assert.equal(
    strictSignalEntryQuoteAllowsImmediate({
      isBuy: false,
      entryPrice: 4500,
      bid: 4499.5,
      ask: 4501,
      tolerancePips: 10,
      pipSize: pip,
    }),
    true,
  )
})

test('planManualOrders: use_signal_entry_price emits strictEntry + always Buy (executor gates quote)', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 4500 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'BuyLimit',
    manual: {
      ...baseManual,
      trade_style: 'single',
      range_trading: false,
      use_signal_entry_price: true,
      signal_entry_pip_tolerance: 999,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: { ...baseCtx, liveBid: 4600, liveAsk: 4601 },
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.equal(plan.orders[0]!.operation, 'Buy')
  assert.equal(plan.orders[0]!.price, 0)
  assert.ok(plan.strictEntry)
  assert.equal(plan.strictEntry!.entryPrice, 4500)
  assert.equal(plan.strictEntry!.isBuy, true)
})

test('planManualOrders: use_signal_entry_price sell emits strictEntry + Sell', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, action: 'sell', entry_price: 4500 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'SellLimit',
    manual: {
      ...baseManual,
      trade_style: 'single',
      range_trading: false,
      use_signal_entry_price: true,
      signal_entry_pip_tolerance: 0,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: { ...baseCtx, liveBid: 4400, liveAsk: 4401 },
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders[0]!.operation, 'Sell')
  assert.ok(plan.strictEntry)
  assert.equal(plan.strictEntry!.isBuy, false)
})

test('planManualOrders: strict entry + entry-shaped signal still skips range (opSplit pending)', () => {
  const pip = pipCalculator('XAUUSD', baseCtx.point, baseCtx.digits, null).pipPrice
  const entry = 4500
  const tol = 10
  const maxBuy = entry + tol * pip
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: entry },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'BuyLimit',
    manual: {
      ...baseManual,
      trade_style: 'single',
      range_trading: false,
      use_signal_entry_price: true,
      signal_entry_pip_tolerance: tol,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: { ...baseCtx, liveBid: maxBuy - 1, liveAsk: maxBuy - 0.5 },
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders[0]!.operation, 'Buy')
  assert.equal(plan.virtualPendings, undefined)
})

test('planManualOrders: single trade + use_signal_entry_price off uses Buy/Sell at market (no pending expiration)', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 2650 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'BuyLimit',
    manual: {
      ...baseManual,
      trade_style: 'single',
      range_trading: false,
      use_signal_entry_price: false,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.equal(plan.orders[0]!.operation, 'Buy')
  assert.equal(plan.orders[0]!.price, 0)
  assert.equal(plan.strictEntry, undefined)
  const o = plan.orders[0] as { expiration?: string; expirationType?: string }
  assert.equal(o.expiration, undefined)
  assert.equal(o.expirationType, undefined)
})

test('planManualOrders: single+strict off+bare Buy stays Buy (no redundant op flip)', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: null, entry_zone_low: null, entry_zone_high: null },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      trade_style: 'single',
      range_trading: false,
      use_signal_entry_price: false,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.equal(plan.orders[0]!.operation, 'Buy')
  assert.equal(plan.orders[0]!.price, 0)
})

test('planManualOrders: single trade + 3 TPs + 50/30/20 → partial_tp schedule on plan', () => {
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      action: 'sell',
      entry_price: 4292,
      sl: 4299,
      tp: [4290, 4288, 4286],
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual: {
      ...baseManual,
      trade_style: 'single',
      range_trading: false,
      tp_lots: [
        { label: 'TP1', lot: 0.01, percent: 50, enabled: true },
        { label: 'TP2', lot: 0.01, percent: 30, enabled: true },
        { label: 'TP3', lot: 0.01, percent: 20, enabled: true },
      ],
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.equal(plan.orders[0]!.takeprofit, 4286)
  assert.equal(plan.partialTps?.length, 2)
  assert.equal(plan.partialTps![0]!.closeLots, 0.5)
  assert.equal(plan.partialTps![1]!.closeLots, 0.3)
})

// ── planSinglePartialTps ───────────────────────────────────────────────────
// The pure helper that turns the user's percent rows (50 / 30 / 20) into a
// concrete partial-close schedule for single-mode trades. Verifies that the
// LAST configured bucket's TP becomes the broker takeprofit and the earlier
// ones become per-TP partial /OrderClose lots.

test('planSinglePartialTps: 50/30/20 on 1.0 lot → broker TP=TP3, partials at TP1 (0.5) + TP2 (0.3)', () => {
  const r = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [{ percent: 50 }, { percent: 30 }, { percent: 20 }],
  })
  assert.equal(r.brokerTp, 1.30)
  assert.equal(r.partials.length, 2)
  assert.deepEqual(r.partials[0], { tpIdx: 1, triggerPrice: 1.10, closeLots: 0.50, percent: 50 })
  assert.deepEqual(r.partials[1], { tpIdx: 2, triggerPrice: 1.20, closeLots: 0.30, percent: 30 })
})

test('planSinglePartialTps: only 1 TP → no partials, broker TP=TP1', () => {
  const r = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10],
    bucketRows: [{ percent: 100 }],
  })
  assert.equal(r.brokerTp, 1.10)
  assert.equal(r.partials.length, 0)
})

test('planSinglePartialTps: empty bucket rows → no partials, broker TP=last TP', () => {
  const r = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [],
  })
  assert.equal(r.brokerTp, 1.30)
  assert.equal(r.partials.length, 0)
})

test('planSinglePartialTps: tp2 target → broker TP=TP2 and only TP1 partial', () => {
  const r = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [{ percent: 50 }, { percent: 30 }, { percent: 20 }],
    singleTpTarget: 'tp2',
  })
  assert.equal(r.brokerTp, 1.20)
  assert.equal(r.partials.length, 1)
  assert.deepEqual(r.partials[0], { tpIdx: 1, triggerPrice: 1.10, closeLots: 0.50, percent: 50 })
})

test('planSinglePartialTps: tp1 target → broker TP=TP1 and no partials', () => {
  const r = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [{ percent: 50 }, { percent: 30 }, { percent: 20 }],
    singleTpTarget: 'tp1',
  })
  assert.equal(r.brokerTp, 1.10)
  assert.equal(r.partials.length, 0)
})

test('planSinglePartialTps: farthest target uses direction-aware price extreme', () => {
  const buy = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.20, 1.30, 1.10],
    bucketRows: [{ percent: 40 }, { percent: 30 }, { percent: 30 }],
    singleTpTarget: 'farthest',
    isBuy: true,
  })
  assert.equal(buy.brokerTp, 1.30)

  const sell = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [4522, 4514, 4518],
    bucketRows: [{ percent: 40 }, { percent: 30 }, { percent: 30 }],
    singleTpTarget: 'farthest',
    isBuy: false,
  })
  assert.equal(sell.brokerTp, 4514)
})

test('planSinglePartialTps: percentage below minLot is dropped with diagnostic', () => {
  // 5% of 0.10 lot = 0.005 → below 0.01 minLot, must be skipped.
  const r = planSinglePartialTps({
    manualLot: 0.10,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [{ percent: 5 }, { percent: 50 }, { percent: 45 }],
  })
  assert.equal(r.brokerTp, 1.30)
  // TP1 skipped (too small), TP2 emitted.
  assert.equal(r.partials.length, 1)
  assert.deepEqual(r.partials[0], { tpIdx: 2, triggerPrice: 1.20, closeLots: 0.05, percent: 50 })
  assert.equal(r.fallbackReason, 'partial_tp_below_min_lot')
})

test('planSinglePartialTps: bucket count clamped to finalTps length', () => {
  // 4 rows but only 2 TPs → 2 buckets → TP2 = broker, TP1 = partial.
  const r = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20],
    bucketRows: [{ percent: 40 }, { percent: 30 }, { percent: 20 }, { percent: 10 }],
  })
  assert.equal(r.brokerTp, 1.20)
  assert.equal(r.partials.length, 1)
  assert.deepEqual(r.partials[0], { tpIdx: 1, triggerPrice: 1.10, closeLots: 0.40, percent: 40 })
})

test('planSinglePartialTps: cumulative partials capped so final slice >= minLot', () => {
  // If partials would consume more than manualLot - minLot, the LAST partial
  // shrinks to fit (so the broker-TP slice never rounds to zero).
  // manualLot = 0.05, minLot = 0.01, partials at 90/9 (TP3 ignored).
  // 0.9 × 0.05 = 0.045 → 0.04 (rounded down to lotStep) → leaves 0.01.
  // After first partial (0.04), remainingUnits = 0. Second partial dropped.
  const r = planSinglePartialTps({
    manualLot: 0.05,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [{ percent: 90 }, { percent: 9 }, { percent: 1 }],
  })
  assert.equal(r.brokerTp, 1.30)
  assert.equal(r.partials.length, 1)
  assert.equal(r.partials[0]!.closeLots, 0.04)
  // 0.05 - 0.04 = 0.01 left for broker TP (= minLot, the reserved floor).
})

test('planSinglePartialTps: 0% bucket is skipped without affecting later TPs', () => {
  const r = planSinglePartialTps({
    manualLot: 1.0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [{ percent: 0 }, { percent: 50 }, { percent: 50 }],
  })
  assert.equal(r.brokerTp, 1.30)
  assert.equal(r.partials.length, 1)
  assert.deepEqual(r.partials[0], { tpIdx: 2, triggerPrice: 1.20, closeLots: 0.50, percent: 50 })
})

test('planSinglePartialTps: bad manualLot returns null brokerTp + reason', () => {
  const r = planSinglePartialTps({
    manualLot: 0,
    minLot: 0.01,
    lotStep: 0.01,
    finalTps: [1.10, 1.20, 1.30],
    bucketRows: [{ percent: 50 }, { percent: 30 }, { percent: 20 }],
  })
  assert.equal(r.brokerTp, null)
  assert.equal(r.partials.length, 0)
  assert.equal(r.fallbackReason, 'partial_tp_invalid_lot')
})

test('parsedHasExplicitEntryAnchor: false for bare action, true for price or zone', () => {
  assert.equal(parsedHasExplicitEntryAnchor({ ...baseParsed, entry_price: null, entry_zone_low: null, entry_zone_high: null }), false)
  assert.equal(parsedHasExplicitEntryAnchor({ ...baseParsed, entry_price: 4500, entry_zone_low: null, entry_zone_high: null }), true)
  assert.equal(parsedHasExplicitEntryAnchor({ ...baseParsed, entry_price: null, entry_zone_low: 1, entry_zone_high: 2 }), true)
})

test('resolvedParsedEntryPrice: string decimals and camelCase entryPrice', () => {
  assert.equal(
    resolvedParsedEntryPrice({ ...baseParsed, entry_price: '2650.5' as unknown as number, entry_zone_low: null, entry_zone_high: null }),
    2650.5,
  )
  const camel = { ...baseParsed, entry_price: null, entry_zone_low: null, entry_zone_high: null } as ParsedSignal
  assert.equal(resolvedParsedEntryPrice({ ...camel, entryPrice: 4000 } as unknown as ParsedSignal), 4000)
})

test('planManualOrders: use_signal_entry_price skips plan without explicit entry', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: null, entry_zone_low: null, entry_zone_high: null },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      trade_style: 'single',
      range_trading: false,
      use_signal_entry_price: true,
      signal_entry_pip_tolerance: 10,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: { ...baseCtx, liveBid: undefined, liveAsk: undefined },
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 0)
  assert.equal(plan.skip_reason, 'signal_entry_price_requires_explicit_entry')
})

test('planManualOrders: use_signal_entry_range skips plan without explicit entry', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: null, entry_zone_low: null, entry_zone_high: null },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      trade_style: 'multi',
      range_trading: true,
      use_signal_entry_range: true,
      signal_entry_pip_tolerance: 10,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 0)
  assert.equal(plan.skip_reason, SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED)
})

test('planManualOrders: use_signal_entry_range emits rangeEntryWait when anchor present', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 4505 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      trade_style: 'multi',
      range_trading: true,
      use_signal_entry_range: true,
      signal_entry_pip_tolerance: 10,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.ok(plan.orders.length > 0)
  assert.ok(plan.rangeEntryWait)
  assert.equal(plan.rangeEntryWait!.entryPrice, 4505)
  assert.equal(plan.rangeEntryWait!.tolerancePips, 10)
})

test('planManualOrders: multi + use_signal_entry_price does not require explicit entry', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: null, entry_zone_low: null, entry_zone_high: null },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      trade_style: 'multi',
      range_trading: false,
      use_signal_entry_price: true,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.notEqual(plan.skip_reason, SKIP_REASON_SIGNAL_ENTRY_REQUIRED)
  assert.equal(plan.strictEntry, undefined)
  assert.ok(plan.orders.length > 0)
})

test('signalEntryPriceStrictEnabled: false when trade_style is multi', () => {
  assert.equal(
    signalEntryPriceStrictEnabled({
      ...baseManual,
      trade_style: 'multi',
      use_signal_entry_price: true,
    }),
    false,
  )
  assert.equal(
    signalEntryPriceStrictEnabled({
      ...baseManual,
      trade_style: 'single',
      use_signal_entry_price: true,
    }),
    true,
  )
  assert.equal(
    signalEntryPriceStrictEnabled({
      ...baseManual,
      trade_style: 'single',
      use_signal_entry_price: 'true' as unknown as boolean,
    }),
    true,
  )
})

test('clampPendingExpiryHours: clamps high values to 24', () => {
  assert.equal(clampPendingExpiryHours(99), 24)
  assert.equal(clampPendingExpiryHours(1.9), 1)
  assert.equal(clampPendingExpiryHours(0), 0)
  assert.equal(clampPendingExpiryHours(-3), 0)
})

test('reverseSignalGateSatisfied: predefined SL and TP only (entry optional)', () => {
  const manual: ManualSettings = {
    use_predefined_sl_pips: true,
    predefined_sl_pips: 30,
    use_predefined_tp_pips: true,
    predefined_tp_pips: [40, 80],
  }
  assert.equal(reverseSignalGateSatisfied(manual, null), true)
  assert.equal(reverseSignalGateSatisfied(manual, 1.1), true)
  assert.equal(reverseSignalGateSatisfied({
    use_predefined_sl_pips: true,
    predefined_sl_pips: 30,
    use_predefined_tp_pips: false,
  }, 1.1), false)
})

test('planManualOrders: reverse_signal flips buy to sell without predefined stops', () => {
  const entry = 1.1
  const plan = planManualOrders({
    parsed: {
      action: 'buy',
      symbol: 'EURUSD',
      entry_price: entry,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 1.09,
      tp: [1.12],
      lot_size: null,
    },
    resolvedSymbol: 'EURUSD',
    baseOperation: 'Buy',
    manual: {
      risk_mode: 'fixed_lot',
      fixed_lot: 0.1,
      trade_style: 'single',
      range_trading: false,
      reverse_signal: true,
      use_predefined_sl_pips: false,
      use_predefined_tp_pips: false,
    },
    channelKeywords: null,
    manualLot: 0.1,
    ctx: { ...baseCtx, point: 0.0001, digits: 5 },
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.isBuy, false)
  assert.ok(String(plan.orders[0]?.operation ?? '').startsWith('Sell'))
  assert.equal(plan.orders[0]?.stoploss, Number((2 * entry - 1.09).toFixed(5)))
  assert.equal(plan.orders[0]?.takeprofit, Number((2 * entry - 1.12).toFixed(5)))
})

test('planManualOrders: reverse + predefined uses live quote not signal buy entry', () => {
  const signalEntry = 2650
  const bid = 2640
  const plan = planManualOrders({
    parsed: {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: signalEntry,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 2640,
      tp: [2680],
      lot_size: null,
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      risk_mode: 'fixed_lot',
      fixed_lot: 0.1,
      trade_style: 'single',
      range_trading: false,
      reverse_signal: true,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [50],
    },
    channelKeywords: null,
    manualLot: 0.1,
    ctx: { ...baseCtx, liveBid: bid, liveAsk: 2640.5 },
    commentPrefix: 'TScopier:abc',
  })
  const pip = plan.pip ?? 0.1
  assert.equal(plan.isBuy, false)
  assert.ok(String(plan.orders[0]?.operation ?? '').startsWith('Sell'))
  assert.equal(plan.orders[0]?.stoploss, Number((bid + 80 * pip).toFixed(2)))
  assert.equal(plan.orders[0]?.takeprofit, Number((bid - 50 * pip).toFixed(2)))
  assert.notEqual(plan.orders[0]?.stoploss, Number((signalEntry + 80 * pip).toFixed(2)))
})

test('planManualOrders: reverse_signal flips BUY NOW using live quote when predefined stops are on', () => {
  const bid = 1999.8
  const plan = planManualOrders({
    parsed: {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [2400],
      lot_size: null,
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      risk_mode: 'fixed_lot',
      fixed_lot: 0.1,
      trade_style: 'single',
      range_trading: false,
      reverse_signal: true,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [50],
    },
    channelKeywords: null,
    manualLot: 0.1,
    ctx: { ...baseCtx, liveBid: bid, liveAsk: 2000 },
    commentPrefix: 'TScopier:abc',
  })
  const pip = plan.pip ?? 0.1
  assert.equal(plan.isBuy, false)
  assert.ok(String(plan.orders[0]?.operation ?? '').startsWith('Sell'))
  assert.equal(plan.orders[0]?.stoploss, Number((bid + 80 * pip).toFixed(2)))
  assert.equal(plan.orders[0]?.takeprofit, Number((bid - 50 * pip).toFixed(2)))
})

test('planManualOrders: reverse_signal flips when predefined gate satisfied', () => {
  const plan = planManualOrders({
    parsed: {
      action: 'buy',
      symbol: 'EURUSD',
      entry_price: 1.1,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [1.11],
      lot_size: null,
    },
    resolvedSymbol: 'EURUSD',
    baseOperation: 'Buy',
    manual: {
      risk_mode: 'fixed_lot',
      fixed_lot: 0.1,
      trade_style: 'single',
      range_trading: false,
      reverse_signal: true,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 100,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [100, 200],
    },
    channelKeywords: null,
    manualLot: 0.1,
    ctx: { ...baseCtx, point: 0.0001, digits: 5 },
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.isBuy, false)
  assert.ok(String(plan.orders[0]?.operation ?? '').startsWith('Sell'))
})

test('planManualOrders: predefined SL wins over rr_for_sl when both apply', () => {
  const entry = 1.1
  const plan = planManualOrders({
    parsed: {
      action: 'buy',
      symbol: 'EURUSD',
      entry_price: entry,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [1.12],
      lot_size: null,
    },
    resolvedSymbol: 'EURUSD',
    baseOperation: 'Buy',
    manual: {
      risk_mode: 'fixed_lot',
      fixed_lot: 0.1,
      trade_style: 'single',
      range_trading: false,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 50,
      use_predefined_tp_pips: false,
      rr_for_sl_enabled: true,
      rr_for_sl: 10,
    },
    channelKeywords: null,
    manualLot: 0.1,
    ctx: { ...baseCtx, point: 0.0001, digits: 5 },
    commentPrefix: 'TScopier:abc',
  })
  const pip = pipCalculator('EURUSD', 0.0001, 5).pipPrice
  const expectedSl = Number((entry - 50 * pip).toFixed(5))
  assert.equal(plan.orders[0]?.stoploss, expectedSl)
})

test('planManualOrders: predefined SL/TP replace wrong-side signal stops using live quote', () => {
  const ask = 2000
  const plan = planManualOrders({
    parsed: {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 2100,
      tp: [1900],
      lot_size: null,
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      risk_mode: 'fixed_lot',
      fixed_lot: 0.1,
      trade_style: 'single',
      range_trading: false,
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [50],
    },
    channelKeywords: null,
    manualLot: 0.1,
    ctx: { ...baseCtx, liveBid: 1999.8, liveAsk: ask },
    commentPrefix: 'TScopier:abc',
  })
  const pip = plan.pip ?? 0.1
  assert.equal(plan.orders[0]?.stoploss, Number((ask - 80 * pip).toFixed(2)))
  assert.equal(plan.orders[0]?.takeprofit, Number((ask + 50 * pip).toFixed(2)))
  assert.ok((plan.orders[0]?.stoploss ?? 0) < ask)
  assert.ok((plan.orders[0]?.takeprofit ?? 0) > ask)
})

test('planManualOrders: use_signal_entry_range uses zone width for range layering', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_step_pips: 3,
    range_distance_pips: 30,
    use_signal_entry_range: true,
  }
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_zone_low: 4325,
      entry_zone_high: 4335,
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const rl = plan.rangeLayering
  assert.ok(rl)
  assert.equal(rl.useSignalEntryRange, true)
  assert.equal(rl.signalRangeBoundary, 4325)
  assert.equal(rl.effectiveDistancePips, 100) // 10 price units / 0.1 pip
  assert.equal(rl.activePendingLegs, 5) // 50% of 10 legs reserved; zone width allows all 5
})

test('planManualOrders: use_signal_entry_range without zone falls back to range_distance_pips', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_step_pips: 3,
    range_distance_pips: 30,
    use_signal_entry_range: true,
  }
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 4330 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const rl = plan.rangeLayering
  assert.ok(rl)
  assert.equal(rl.effectiveDistancePips, 30)
  assert.equal(rl.signalRangeBoundary, null)
  assert.equal(rl.activePendingLegs, 5) // 30/3 = 10 max steps; 5 reserved pendings
})

test('planManualOrders: signal range buy virtual triggers do not go below zone low', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_step_pips: 3,
    range_distance_pips: 30,
    use_signal_entry_range: true,
  }
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_zone_low: 4325,
      entry_zone_high: 4335,
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const anchor = 4330
  const boundary = plan.rangeLayering?.signalRangeBoundary ?? null
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length > 0)
  const triggerMap = buildRangeLayerTriggerMap({
    virtualPendings: virtuals,
    anchor,
    digits: 2,
    rangeLayering: plan.rangeLayering ?? null,
    pip: plan.pip,
  })
  for (const v of virtuals) {
    const trigger = triggerMap.get(v.stepIdx) ?? triggerPriceFor(v, anchor, 2)
    assert.ok(trigger >= (boundary ?? 0), `step ${v.stepIdx} trigger ${trigger} below ${boundary}`)
  }
  const deepest = triggerMap.get(virtuals[virtuals.length - 1]!.stepIdx)
  assert.equal(deepest, boundary)
})

test('planManualOrders: sell signal zone virtual Auto spreads linearly toward zone high', () => {
  // Auto + signal range uses linear spacing (not zone curve).
  const manual: ManualSettings = {
    ...baseManual,
    range_percent: 100,
    range_step_pips: 0,
    range_distance_pips: 30,
    use_signal_entry_range: true,
  }
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_zone_low: 4325,
      entry_zone_high: 4335,
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const anchor = 4327
  const boundary = 4335
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length >= 2)
  const triggerMap = buildRangeLayerTriggerMap({
    virtualPendings: virtuals,
    anchor,
    digits: 2,
    rangeLayering: plan.rangeLayering ?? null,
    pip: plan.pip,
  })
  assert.ok(triggerMap.size >= 1)
  const first = triggerMap.get(1)!
  const stepOffset = virtuals[0]!.stepPriceOffset
  assert.ok(Math.abs(first - (anchor + stepOffset)) < 0.02, 'first rung ~ one Auto step from fill')
  const prices = [...triggerMap.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p)
  assert.equal(new Set(prices.map(p => p.toFixed(2))).size, prices.length)
  for (const p of prices) {
    assert.ok(p <= boundary + 1e-9, `trigger ${p} past boundary ${boundary}`)
    assert.ok(p > anchor, `trigger ${p} should be above sell anchor`)
  }
})

test('planManualOrders: sell signal zone broker pending clusters toward zone high', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_percent: 100,
    range_step_pips: 3,
    range_distance_pips: 30,
    use_signal_entry_range: true,
    range_layering_type: 'pending_order',
  }
  const plan = planManualOrders({
    parsed: {
      ...baseParsed,
      entry_zone_low: 4325,
      entry_zone_high: 4335,
    },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Sell',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  const anchor = 4327
  const boundary = 4335
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length >= 2)
  const triggerMap = buildRangeLayerTriggerMap({
    virtualPendings: virtuals,
    anchor,
    digits: 2,
    rangeLayering: plan.rangeLayering ?? null,
    pip: plan.pip,
  })
  const first = triggerMap.get(1)!
  const maxIdx = plan.rangeLayering?.maxStepIdx ?? virtuals[virtuals.length - 1]!.stepIdx
  const last = triggerMap.get(maxIdx)!
  const stepOffset = virtuals[0]!.stepPriceOffset
  assert.equal(first, anchor + stepOffset, 'first rung must be exactly one configured step from fill')
  assert.ok(first - anchor < last - anchor, 'deepest rung should be further from anchor than first')
  assert.equal(last, boundary)
})
