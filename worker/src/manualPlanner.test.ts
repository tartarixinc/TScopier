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
  strictSignalEntryQuoteAllowsImmediate,
  type ManualSettings,
  type ParsedSignal,
  type PlannerCloseWorseEntries,
  type PlannerContext,
} from './manualPlanner'
import { pipCalculator } from './pipCalculator'
import { signalPipPrice } from './signalPip'

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

test('planRangeSplit: distance does NOT cap pending count (May-12 UX fix)', () => {
  // Even when step × pending (10 × 10 = 100) overshoots the configured
  // distance (30), the count stays at 10. The user explicitly asked that
  // Total Open Trades remain stable when Step is adjusted; distance is
  // now an advisory target, not a cap.
  const r = planRangeSplit({ ...baseSplit, distPips: 30 })
  assert.equal(r.pendingLegs, 10)
  assert.equal(r.immediateLegs, 10)
  // And step itself is preserved (user controls placement spacing).
  assert.equal(r.effectiveStepPips, 10)
})

test('planRangeSplit: step changes spacing but not count', () => {
  // Same baseLegs=20, range_percent=50 → 10 pendings regardless of step.
  const small = planRangeSplit({ ...baseSplit, stepPips: 5 })
  const big = planRangeSplit({ ...baseSplit, stepPips: 25 })
  assert.equal(small.pendingLegs, 10)
  assert.equal(big.pendingLegs, 10)
  assert.equal(small.immediateLegs, 10)
  assert.equal(big.immediateLegs, 10)
  // Spacing differs:
  assert.equal(small.effectiveStepPips, 5)
  assert.equal(big.effectiveStepPips, 25)
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
    policy, anchor: 1850, isBuy: true, pip: 0.1, digits: 2, minStopDistance: 1.02,
  })
  // 1850 + 30 × 0.1 = 1853 (already outside the 1.02 floor).
  assert.equal(out, 1853)
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
    policy, anchor: 1850, isBuy: false, pip: 0.1, digits: 2, minStopDistance: 0,
  })
  assert.equal(out, 1847) // 1850 - 30 × 0.1
})

test('computeCwOverrideTp: zero anchor returns null', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, pipsFromAnchor: 30 }
  const out = computeCwOverrideTp({
    policy, anchor: 0, isBuy: true, pip: 0.1, digits: 2, minStopDistance: 0,
  })
  assert.equal(out, null)
})

test('computeCwOverrideTp: zero pipsFromAnchor returns null', () => {
  const policy: PlannerCloseWorseEntries = { immediates: 1, pipsFromAnchor: 0 }
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

test('planManualOrders: multi + BuyLimit + range uses market immediates but still emits virtual pendings', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'BuyLimit',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TSCopier:abc',
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
    commentPrefix: 'TSCopier:abc',
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
    commentPrefix: 'TSCopier:abc',
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
    commentPrefix: 'TSCopier:abc',
  })
  assert.equal(plan.orders.length, 5)
  assert.equal(plan.virtualPendings?.length, 5)
  // Instant pool (5 legs): 50/30/20 → 3 / 2 / 0
  assert.equal(plan.orders.filter(o => o.takeprofit === 4530).length, 3)
  assert.equal(plan.orders.filter(o => o.takeprofit === 4510).length, 2)
  assert.equal(plan.orders.filter(o => o.takeprofit === 4490).length, 0)
  // Range pool (5 legs): same split independently
  const rangeTps = (plan.virtualPendings ?? []).map(v => v.takeprofit)
  assert.equal(rangeTps.filter(tp => tp === 4530).length, 3)
  assert.equal(rangeTps.filter(tp => tp === 4510).length, 2)
  assert.equal(rangeTps.filter(tp => tp === 4490).length, 0)
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
    commentPrefix: 'TSCopier:abc',
  })
  assert.equal(plan.orders.length, 10)
  for (const o of plan.orders) {
    assert.equal(o.operation, 'Buy')
    assert.equal(o.price, 0)
  }
})

test('planManualOrders: CWE policy emitted for immediate legs', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      close_worse_entries: true,
      close_worse_entries_pips: 30,
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
})

test('planManualOrders: CWE policy emitted without range trading (immediates only)', () => {
  const plan = planManualOrders({
    parsed: { ...baseParsed, entry_price: 1850 },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: {
      ...baseManual,
      range_trading: false,
      range_percent: 0,
      close_worse_entries: true,
      close_worse_entries_pips: 30,
    },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TSCopier:abc',
  })
  const cw = plan.closeWorseEntries
  assert.ok(cw, 'CWE should apply to multi immediates even when range trading is off')
  assert.ok(cw!.immediates > 0)
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
    commentPrefix: 'TSCopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.equal(plan.orders[0]!.operation, 'Buy')
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
    commentPrefix: 'TSCopier:abc',
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
    commentPrefix: 'TSCopier:abc',
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
    commentPrefix: 'TSCopier:abc',
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
    commentPrefix: 'TSCopier:abc',
  })
  assert.equal(plan.orders.length, 1)
  assert.equal(plan.orders[0]!.operation, 'Buy')
  assert.equal(plan.orders[0]!.price, 0)
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
    commentPrefix: 'TSCopier:abc',
  })
  assert.equal(plan.orders.length, 0)
  assert.equal(plan.skip_reason, 'signal_entry_price_requires_explicit_entry')
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
    commentPrefix: 'TSCopier:abc',
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

test('reverseSignalGateSatisfied: requires both predefined sides + anchor', () => {
  const manual: ManualSettings = {
    use_predefined_sl_pips: true,
    predefined_sl_pips: 30,
    use_predefined_tp_pips: true,
    predefined_tp_pips: [40, 80],
  }
  assert.equal(reverseSignalGateSatisfied(manual, null), false)
  assert.equal(reverseSignalGateSatisfied(manual, 1.1), true)
})

test('planManualOrders: reverse_signal ignored when gate not satisfied', () => {
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
      use_predefined_sl_pips: false,
      use_predefined_tp_pips: false,
    },
    channelKeywords: null,
    manualLot: 0.1,
    ctx: { ...baseCtx, point: 0.0001, digits: 5 },
    commentPrefix: 'TSCopier:abc',
  })
  assert.equal(plan.isBuy, true)
  assert.ok(String(plan.orders[0]?.operation ?? '').startsWith('Buy'))
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
    commentPrefix: 'TSCopier:abc',
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
    commentPrefix: 'TSCopier:abc',
  })
  const pip = signalPipPrice('EURUSD')
  const expectedSl = Number((entry - 50 * pip).toFixed(5))
  assert.equal(plan.orders[0]?.stoploss, expectedSl)
})
