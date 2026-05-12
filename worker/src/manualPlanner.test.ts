import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  computeCwOverrideTp,
  planManualOrders,
  planRangeSplit,
  type ManualSettings,
  type ParsedSignal,
  type PlannerCloseWorseEntries,
  type PlannerContext,
} from './manualPlanner'

const baseSplit = {
  totalLegs: 20,
  baseIsPendingSignal: false,
  rangeOn: true,
  rangePct: 50,
  stepPips: 10,
  distPips: 100,
  pip: 0.1,
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

test('planRangeSplit: invalid step/distance → fallback', () => {
  const r = planRangeSplit({ ...baseSplit, stepPips: 0 })
  assert.equal(r.fallbackReason, 'range_trading_invalid')
  assert.equal(r.pendingLegs, 0)
})

test('planRangeSplit: 50% × 20 legs → 10 pendings @ 10 pip step', () => {
  const r = planRangeSplit(baseSplit)
  assert.equal(r.immediateLegs, 10)
  assert.equal(r.pendingLegs, 10)
  assert.equal(r.effectiveStepPips, 10)
  assert.ok(Math.abs(r.stepPriceOffset - 1.0) < 1e-9) // 10 × 0.1
  assert.equal(r.fallbackReason, undefined)
})

test('planRangeSplit: distance caps pending count', () => {
  const r = planRangeSplit({ ...baseSplit, distPips: 30 }) // 30 / 10 = 3
  assert.equal(r.pendingLegs, 3)
  assert.equal(r.immediateLegs, 10)
})

test('planRangeSplit: auto-expands step when below broker minimum', () => {
  // pip = 0.1, configured step = 2 pips = 0.2 price units, but broker requires 1.02.
  // ceil(1.02 / 0.1) = 11 pips.
  const r = planRangeSplit({ ...baseSplit, stepPips: 2, minStepPriceUnits: 1.02 })
  assert.equal(r.effectiveStepPips, 11)
  assert.equal(r.fallbackReason, 'range_trading_step_auto_expanded')
})

test('planRangeSplit: no signal anchor + no immediates → runtime-only fallback', () => {
  // 100% range = 0 immediates; without a signal anchor the executor must resolve via /Quote.
  const r = planRangeSplit({ ...baseSplit, rangePct: 100, hasSignalAnchor: false })
  assert.equal(r.immediateLegs, 0)
  assert.equal(r.pendingLegs, 10)
  assert.equal(r.fallbackReason, 'range_trading_anchor_runtime_only')
})

test('computeCwOverrideTp: buy → anchor + pips × pip', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 2, extraPendings: 1, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 1850, isBuy: true, pip: 0.1, digits: 2, minStopDistance: 1.02,
  })
  // 1850 + 30 × 0.1 = 1853 (already outside the 1.02 floor).
  assert.equal(out, 1853)
})

test('computeCwOverrideTp: respects stops/freeze floor', () => {
  // 30 pips on EURUSD 5-digit = 0.003 price units, but broker requires 0.005.
  const policy: PlannerCloseWorseEntries = { immediates: 1, extraPendings: 0, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 1.10000, isBuy: true, pip: 0.0001, digits: 5, minStopDistance: 0.005,
  })
  assert.equal(out, 1.105)
})

test('computeCwOverrideTp: sell direction inverts override', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, extraPendings: 0, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 1850, isBuy: false, pip: 0.1, digits: 2, minStopDistance: 0,
  })
  assert.equal(out, 1847) // 1850 - 30 × 0.1
})

test('computeCwOverrideTp: zero anchor returns null', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, extraPendings: 0, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 0, isBuy: true, pip: 0.1, digits: 2, minStopDistance: 0,
  })
  assert.equal(out, null)
})

test('computeCwOverrideTp: zero pipsFromAnchor returns null', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, extraPendings: 0, pipsFromAnchor: 0 }
  const out = computeCwOverrideTp({
    policy, anchor: 1850, isBuy: true, pip: 0.1, digits: 2, minStopDistance: 0,
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
  range_trading: true,
  range_percent: 50,                  // half immediates, half virtual pendings
  range_step_pips: 10,
  range_distance_pips: 100,
  tp_lots: [{ label: 'TP1', lot: 0, percent: 100, enabled: true }],
  pending_expiry_hours: 4,
}

test('planManualOrders: range emits virtualPendings (not OrderSendArgs)', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TSCopier:abc',
  })
  // 10 legs total, 50% pendings → 5 immediates + 5 virtuals.
  assert.equal(plan.orders.length, 5)
  assert.equal(plan.virtualPendings?.length, 5)
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

test('planManualOrders: range off → no virtualPendings', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: { ...baseManual, range_trading: false },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TSCopier:abc',
  })
  assert.equal(plan.virtualPendings, undefined)
  assert.equal(plan.orders.length, 10) // all 10 legs are immediates
})

test('planManualOrders: CWE policy emitted with extraPendings clamped', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      close_worse_entries: true,
      close_worse_entries_pips: 30,
      close_worse_extra_pendings: 99, // way more than available → should clamp
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TSCopier:abc',
  })
  const cw = plan.closeWorseEntries
  assert.ok(cw, 'CWE policy should be emitted when range + close_worse_entries are on')
  assert.equal(cw!.pipsFromAnchor, 30)
  assert.equal(cw!.immediates, 5)
  // extraPendings should be clamped to the number of virtual pendings available (5).
  assert.equal(cw!.extraPendings, 5)
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
    commentPrefix: 'TSCopier:abc',
  })
  const virtuals = plan.virtualPendings ?? []
  assert.ok(virtuals.length > 0)
  for (const v of virtuals) {
    assert.equal(v.isBuy, false)
  }
})
