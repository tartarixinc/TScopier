import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  planManualOrders,
  type ManualSettings,
  type ParsedSignal,
  type PlannerContext,
} from '../manualPlanner'

const baseCtx: PlannerContext = {
  point: 0.01,
  digits: 2,
  minLot: 0.01,
  lotStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  defaultLot: 0.01,
  lastBalance: null,
  now: new Date('2026-06-01T12:00:00Z'),
}

const baseParsed: ParsedSignal = {
  action: 'buy',
  symbol: 'XAUUSD',
  entry_price: null,
  entry_zone_low: null,
  entry_zone_high: null,
  sl: 1880,
  tp: [1900, 1910, 1920],
  lot_size: null,
}

const baseManual: ManualSettings = {
  risk_mode: 'fixed_lot',
  fixed_lot: 1.0,
  trade_style: 'multi',
  multi_trade_leg_percent: 10,
  multi_trade_max_orders: 100,
  range_trading: false,
  tp_lots: [
    { label: 'TP1', lot: 0, percent: 50, enabled: true },
    { label: 'TP2', lot: 0, percent: 30, enabled: true },
    { label: 'TP3', lot: 0, percent: 20, enabled: true },
  ],
  pending_expiry_hours: 4,
}

function withBundle<T>(fn: () => T): T {
  process.env.TP_BUNDLE_ENABLED = 'true'
  try {
    return fn()
  } finally {
    delete process.env.TP_BUNDLE_ENABLED
  }
}

test('bundle: one leg per level, exact [TP1, TP2, TP3] (not count-weighted)', () => {
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  assert.equal(plan.orders.length, 3)
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1910, 1920])
  assert.deepEqual(vols, [0.5, 0.3, 0.2])
})

test('bundle: rounding remainder goes to the farthest level', () => {
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.05,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(vols, [0.52, 0.31, 0.22])
  const total = vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1.05) < 1e-9)
})

test('bundle: below-minLot bucket share moves to the farthest kept level', () => {
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 5, enabled: true },
      { label: 'TP2', lot: 0, percent: 75, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: { ...baseCtx, minLot: 0.1, lotStep: 0.1 },
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1910, 1920])
  assert.deepEqual(vols, [0.7, 0.3])
})

test('bundle: below-minLot bucket share is not double-counted (no over-allocation)', () => {
  // minLot 0.1 with lotStep 0.01: TP1 (5% -> 0.05) floors to 5 units, below the
  // 10-unit minimum, so it is dropped and its share moves to the farthest level.
  // Regression: the dropped share and the flooring remainder must not both be added.
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 5, enabled: true },
      { label: 'TP2', lot: 0, percent: 75, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: { ...baseCtx, minLot: 0.1, lotStep: 0.01 },
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1910, 1920])
  assert.deepEqual(vols, [0.75, 0.25])
  const total = vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1.0) < 1e-9)
})

test('bundle: Targets % summing over 100 never over-allocates', () => {
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 60, enabled: true },
      { label: 'TP2', lot: 0, percent: 60, enabled: true },
      { label: 'TP3', lot: 0, percent: 60, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const total = plan.orders.reduce((s, o) => s + Number(o.volume), 0)
  assert.ok(total <= 1.0 + 1e-9, `total ${total} exceeded manualLot`)
})

test('bundle: open_tp signal emits one full-lot order with no broker TP', () => {
  const plan = withBundle(() => planManualOrders({
    parsed: { ...baseParsed, tp: [], open_tp: true },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  assert.equal(plan.orders.length, 1)
  assert.equal(Number(plan.orders[0]?.volume), 1.0)
  assert.equal(Number(plan.orders[0]?.takeprofit), 0)
})

test('bundle: range_trading ignores the flag (classic path)', () => {
  const manual: ManualSettings = {
    ...baseManual,
    range_trading: true,
    range_percent: 50,
    range_step_pips: 10,
    range_distance_pips: 100,
    multi_trade_leg_percent: 100,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  // Classic range split: the single leg is deferred to a pending dip, not
  // emitted as a 2-order bundle (which would ignore the range request).
  assert.equal(plan.orders.length, 0)
  assert.equal(plan.virtualPendings?.length, 1)
})

test('flag off regression: classic count-weighted multi is unchanged', () => {
  delete process.env.TP_BUNDLE_ENABLED
  const plan = planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: { ...baseManual, multi_trade_leg_percent: 10 },
    channelKeywords: null,
    manualLot: 1.0,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  })
  assert.equal(plan.orders.length, 10)
  const tps = plan.orders.map(o => Number(o.takeprofit))
  assert.deepEqual(tps, [1900, 1900, 1900, 1900, 1900, 1910, 1910, 1910, 1920, 1920])
})
