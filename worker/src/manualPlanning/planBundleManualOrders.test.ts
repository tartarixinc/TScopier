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

test('bundle: floor then top-up — a short share is lifted to the broker minimum', () => {
  // 5% of 1.0 = 0.05, below the 0.10 minimum (floors to 0 units of 0.1).
  // The top-up pass lifts it from the rescue pot so TP1 keeps its own exact TP.
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
  assert.deepEqual(tps, [1900, 1910, 1920])
  assert.deepEqual(vols, [0.1, 0.7, 0.2])
  const total = vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1.0) < 1e-9)
})

test('bundle: below-minLot bucket share is not double-counted (no over-allocation)', () => {
  // minLot 0.1 with lotStep 0.01: TP1 (5% -> 0.05) floors to 5 units, below the
  // 10-unit minimum. The top-up fails (pot below the minimum), so the short
  // share flows to the deepest survivor. Regression: the short share and the
  // flooring remainder must not both be added.
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

test('bundle: floor then top-up — 0.04 lot keeps every level alive (0.02/0.01/0.01)', () => {
  // 50/30/20 of 0.04 = 0.020/0.012/0.008 → floors 0.02/0.01/0.00. TP2's
  // 0.002 floor leftover plus TP3's dead 0.008 top TP3 up to the 0.01
  // minimum. TP prices stay exactly the signal's; total stays 0.04.
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 0.04,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1910, 1920])
  assert.deepEqual(vols, [0.02, 0.01, 0.01])
  const total = vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 0.04) < 1e-9, `total ${total}`)
})

test('bundle: when the pot cannot rescue everyone, the deepest level dies first', () => {
  // 0.02 lot, 50/30/20 → floors 0.01/0.00/0.00 with only 0.01 of pot: TP2 is
  // topped up, TP3 (deepest) is sacrificed. Total stays exactly 0.02.
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 0.02,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1910])
  assert.deepEqual(vols, [0.01, 0.01])
  const total = vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 0.02) < 1e-9, `total ${total}`)
})

test('bundle: 2-TP signal with 3 configured rows — unused percent flows to the deepest level', () => {
  const plan = withBundle(() => planManualOrders({
    parsed: { ...baseParsed, tp: [1900, 1910] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 0.10,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1910])
  assert.deepEqual(vols, [0.05, 0.05])
})

test('bundle: 4 TP levels each get their exact share and exact TP', () => {
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 40, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
      { label: 'TP4', lot: 0, percent: 10, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: { ...baseParsed, tp: [1900, 1910, 1920, 1930] },
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.10,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1910, 1920, 1930])
  assert.deepEqual(vols, [0.04, 0.03, 0.02, 0.01])
})

test('bundle: disabled row — its percent flows to the deepest level', () => {
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 40, enabled: true },
      { label: 'TP2', lot: 0, percent: 40, enabled: false },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.10,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1920])
  assert.deepEqual(vols, [0.04, 0.06])
})

test('bundle: insufficient pot — whole lot at a single level, never split below minimum', () => {
  // min 0.10, step 0.01, lot 0.10: every share (0.05/0.03/0.02) is short and
  // the pot can only lift ONE level to 0.10 → single full-lot order at TP1.
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual: baseManual,
    channelKeywords: null,
    manualLot: 0.10,
    ctx: { ...baseCtx, minLot: 0.1 },
    commentPrefix: 'TScopier:abc',
  }))
  assert.equal(plan.orders.length, 1)
  assert.equal(Number(plan.orders[0]?.volume), 0.10)
  assert.equal(Number(plan.orders[0]?.takeprofit), 1900)
  assert.match(String(plan.fallback_reason), /bundle_single_bucket_TP1/)
})

test('bundle: Targets % over 100 after flooring falls back to ONE full-lot order', () => {
  // 50/11/50 of 0.10 = floors 0.05/0.01/0.05 = 0.11 > 0.10. The over-100
  // guard must fire over ALL floors (surviving and short), not just survivors.
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 11, enabled: true },
      { label: 'TP3', lot: 0, percent: 50, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.10,
    ctx: { ...baseCtx, minLot: 0.05 },
    commentPrefix: 'TScopier:abc',
  }))
  assert.equal(plan.orders.length, 1)
  assert.equal(Number(plan.orders[0]?.volume), 0.10)
  assert.match(String(plan.fallback_reason), /bundle_targets_over_100/)
})

test('bundle: middle level is promoted in place — deepest keeps its TP, leftover flows to deepest survivor', () => {
  // 90/5/5 of 0.20: floors 0.18/0.01/0.01, min 0.02 → TP2 is topped up to
  // 0.02, TP3 (deepest, insufficient pot) is sacrificed. Emission keeps ladder
  // order and TP2 keeps its position between TP1 and TP3.
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 90, enabled: true },
      { label: 'TP2', lot: 0, percent: 5, enabled: true },
      { label: 'TP3', lot: 0, percent: 5, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.20,
    ctx: { ...baseCtx, minLot: 0.02 },
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1910])
  assert.deepEqual(vols, [0.18, 0.02])
})

test('bundle: disabled row combined with top-up pressure — short level rescued, leftover to deepest', () => {
  // Rows 40% / 40% OFF / 20% of 0.04: TP2's disabled percent lands in the
  // pot; TP3 (floored to 0) is topped up; the remainder flows to TP3.
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 40, enabled: true },
      { label: 'TP2', lot: 0, percent: 40, enabled: false },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.04,
    ctx: baseCtx,
    commentPrefix: 'TScopier:abc',
  }))
  const tps = plan.orders.map(o => Number(o.takeprofit))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.deepEqual(tps, [1900, 1920])
  assert.deepEqual(vols, [0.01, 0.03])
  const total = vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 0.04) < 1e-9)
})

test('bundle: TP1 disabled and every share short — whole lot at the first surviving level', () => {
  // TP1 row off; 0.10 split 50/50 floors to 0.05/0.05, both below the 0.10
  // min → the pot lifts TP2 only → single full-lot order at TP2.
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: false },
      { label: 'TP2', lot: 0, percent: 50, enabled: true },
      { label: 'TP3', lot: 0, percent: 50, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.10,
    ctx: { ...baseCtx, minLot: 0.1 },
    commentPrefix: 'TScopier:abc',
  }))
  assert.equal(plan.orders.length, 1)
  assert.equal(Number(plan.orders[0]?.volume), 0.10)
  assert.equal(Number(plan.orders[0]?.takeprofit), 1910)
  assert.match(String(plan.fallback_reason), /bundle_single_bucket_TP2/)
})

test('bundle: non-aligned minLot (0.015) — promoted volumes still meet the true minimum', () => {
  // ceil(minLot/step) = 2 units: every emitted volume must be ≥ 0.015 and a
  // 0.01 multiple, with the lot conserved.
  const manual: ManualSettings = {
    ...baseManual,
    tp_lots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  }
  const plan = withBundle(() => planManualOrders({
    parsed: baseParsed,
    resolvedSymbol: 'XAUUSD',
    baseOperation: 'Buy',
    manual,
    channelKeywords: null,
    manualLot: 0.10,
    ctx: { ...baseCtx, minLot: 0.015, lotStep: 0.01 },
    commentPrefix: 'TScopier:abc',
  }))
  const vols = plan.orders.map(o => Number(o.volume))
  assert.ok(vols.length >= 2, `expected a split, got ${vols.length} order(s)`)
  for (const v of vols) {
    assert.ok(v >= 0.015 - 1e-12, `volume ${v} below the true 0.015 minimum`)
    assert.ok(Math.abs(v / 0.01 - Math.round(v / 0.01)) < 1e-9, `volume ${v} not a 0.01 multiple`)
  }
  const total = vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 0.10) < 1e-9, `total ${total}`)
})

test('bundle: conservation sweep — any lot × any percent set × any TP count', () => {
  const lots = [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.10, 0.13, 0.25, 0.50, 0.99, 1.00, 1.05, 2.00, 3.33]
  const shapes: Array<{ percents: number[]; tps: number[] }> = [
    { percents: [50, 30, 20], tps: [1900, 1910, 1920] },
    { percents: [40, 30, 20, 10], tps: [1900, 1910, 1920, 1930] },
    { percents: [60, 40], tps: [1900, 1910] },
    { percents: [25, 25, 25, 25], tps: [1900, 1910, 1920, 1930] },
    { percents: [70, 30], tps: [1900, 1910] },
    { percents: [100], tps: [1900] },
    { percents: [60, 60, 60], tps: [1900, 1910, 1920] }, // over 100 → single order
    { percents: [5, 5, 90], tps: [1900, 1910, 1920] },   // heavy top-up pressure
  ]
  const step = 0.01
  // Two regimes: normal min (0.01) and heavy top-up pressure (min 0.10 —
  // promotion fires for most shares; lots below minLot must refuse cleanly).
  for (const minLot of [0.01, 0.10]) {
    for (const lot of lots) {
      for (const shape of shapes) {
        const manual: ManualSettings = {
          ...baseManual,
          tp_lots: shape.percents.map((percent, i) => ({
            label: `TP${i + 1}`, lot: 0, percent, enabled: true,
          })),
        }
        const plan = withBundle(() => planManualOrders({
          parsed: { ...baseParsed, tp: shape.tps },
          resolvedSymbol: 'XAUUSD',
          baseOperation: 'Buy',
          manual,
          channelKeywords: null,
          manualLot: lot,
          ctx: { ...baseCtx, minLot },
          commentPrefix: 'TScopier:abc',
        }))
        const ctx = `lot ${lot} min ${minLot} pct ${shape.percents}`
        if (plan.orders.length === 0) {
          // The only legal empty outcome: lot below the broker minimum.
          assert.ok(lot < minLot, `${ctx}: refused despite lot >= minLot`)
          assert.match(String(plan.skip_reason), /lot_below_symbol_min/, ctx)
          continue
        }
        const vols = plan.orders.map(o => Number(o.volume))
        const total = vols.reduce((a, b) => a + b, 0)
        assert.ok(Math.abs(total - lot) < 1e-9, `${ctx}: total ${total} ≠ ${lot}`)
        for (const v of vols) {
          assert.ok(v >= minLot - 1e-12, `volume ${v} below minLot (${ctx})`)
          const stepsIn = v / step
          assert.ok(Math.abs(stepsIn - Math.round(stepsIn)) < 1e-9, `volume ${v} not a step multiple (${ctx})`)
        }
        const tps = plan.orders.map(o => Number(o.takeprofit))
        for (const tp of tps) {
          assert.ok(tp === 0 || shape.tps.includes(tp), `tp ${tp} not in signal ladder ${shape.tps} (${ctx})`)
        }
        // Ladder order: multi-order plans must read nearest → farthest.
        if (tps.length > 1) {
          const expectedOrder = shape.tps.filter(tp => tps.includes(tp))
          assert.deepEqual(tps, expectedOrder, `${ctx}: orders out of ladder order`)
        }
      }
    }
  }
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
