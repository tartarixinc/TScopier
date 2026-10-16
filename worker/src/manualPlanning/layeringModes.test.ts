import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  assertLayeringModeExecutionSupported,
  changeLayeringPlanMode,
  isDynamicLayeringMode,
  isLegacyLayeringMode,
  isStaticLayeringMode,
  parseLayeringPlanSnapshot,
  serializeLayeringPlanSnapshot,
} from './layeringModes'
import { planManualOrders } from '../manualPlanner'

const CREATED_AT = '2026-07-30T00:00:00.000Z'
const LOCKED_AT = '2026-07-30T00:01:00.000Z'

function validStaticSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    calculatorVersion: 'layering-v1',
    mode: 'static',
    planId: 'plan_static_001',
    signalId: 'sig',
    brokerAccountId: 'broker',
    basketKey: 'sig:broker',
    symbol: 'XAUUSD',
    side: 'buy',
    originalRangeLow: 3340,
    originalRangeHigh: 3360,
    anchorPrice: 3340,
    executableAnchorPrice: 3340,
    anchorSource: 'signal',
    configuredStaticLayerCount: 5,
    requestedLayerCount: 5,
    plannedLayerCount: 5,
    plannedTotalLot: 0.1,
    allocatedTotalLot: 0.1,
    unallocatedLot: 0,
    fundedPrices: [3360, 3355, 3350, 3345, 3340],
    lots: [0.02, 0.02, 0.02, 0.02, 0.02],
    reasons: [],
    createdAt: CREATED_AT,
    lockedAt: null,
    ...overrides,
  }
}

function validDynamicSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    calculatorVersion: 'layering-v1',
    mode: 'dynamic',
    planId: 'plan_dynamic_001',
    signalId: 'sig',
    brokerAccountId: 'broker',
    basketKey: 'sig:broker',
    symbol: 'XAUUSD',
    side: 'sell',
    originalRangeLow: 3340,
    originalRangeHigh: 3360,
    anchorPrice: 3350,
    executableAnchorPrice: 3350,
    anchorSource: 'fill',
    configuredDynamicStepPips: 5,
    configuredDynamicMaxLayers: 8,
    requestedLayerCount: 8,
    plannedLayerCount: 6,
    plannedTotalLot: 0.13,
    allocatedTotalLot: 0.12,
    unallocatedLot: 0.01,
    fundedPrices: [3350, 3352, 3354, 3356, 3358, 3360],
    lots: [0.02, 0.02, 0.02, 0.02, 0.02, 0.02],
    reasons: ['allocation_reduced_by_lot_step'],
    createdAt: CREATED_AT,
    lockedAt: null,
    ...overrides,
  }
}

test('layering mode helpers resolve expected modes', () => {
  assert.equal(isLegacyLayeringMode({}), true)
  assert.equal(isLegacyLayeringMode({ layering_mode: 'legacy' }), true)
  assert.equal(isStaticLayeringMode({ layering_mode: 'static' }), true)
  assert.equal(isDynamicLayeringMode({ layering_mode: 'dynamic' }), true)
  assert.equal(isLegacyLayeringMode({ layering_mode: 'bad' } as never), true)
})

test('feature gate allows legacy and rejects static/dynamic by default', () => {
  const priorEnabled = process.env.LAYERING_MODES_EXECUTION_ENABLED
  const priorKill = process.env.LAYERING_MODES_KILL_SWITCH
  delete process.env.LAYERING_MODES_EXECUTION_ENABLED
  delete process.env.LAYERING_MODES_KILL_SWITCH
  try {
    assert.deepEqual(assertLayeringModeExecutionSupported({ layering_mode: 'legacy' }), { ok: true })
    assert.deepEqual(assertLayeringModeExecutionSupported({ layering_mode: 'static' }), {
      ok: false,
      reason: 'layering_mode_static_global_disabled',
    })
    assert.deepEqual(assertLayeringModeExecutionSupported({ layering_mode: 'dynamic' }), {
      ok: false,
      reason: 'layering_mode_dynamic_global_disabled',
    })
  } finally {
    if (priorEnabled == null) delete process.env.LAYERING_MODES_EXECUTION_ENABLED
    else process.env.LAYERING_MODES_EXECUTION_ENABLED = priorEnabled
    if (priorKill == null) delete process.env.LAYERING_MODES_KILL_SWITCH
    else process.env.LAYERING_MODES_KILL_SWITCH = priorKill
  }
})

test('feature gate requires kill switch, mode flag, allowlist, and prepare-only controls', () => {
  const priorEnabled = process.env.LAYERING_MODES_EXECUTION_ENABLED
  const priorStatic = process.env.LAYERING_STATIC_EXECUTION_ENABLED
  const priorAllowlist = process.env.LAYERING_MODES_ACCOUNT_ALLOWLIST
  const priorKill = process.env.LAYERING_MODES_KILL_SWITCH
  const priorPrepare = process.env.LAYERING_MODES_PREPARE_ONLY
  process.env.LAYERING_MODES_EXECUTION_ENABLED = 'true'
  delete process.env.LAYERING_STATIC_EXECUTION_ENABLED
  delete process.env.LAYERING_MODES_ACCOUNT_ALLOWLIST
  delete process.env.LAYERING_MODES_KILL_SWITCH
  delete process.env.LAYERING_MODES_PREPARE_ONLY
  try {
    assert.deepEqual(assertLayeringModeExecutionSupported({ layering_mode: 'legacy' }), { ok: true })
    assert.deepEqual(assertLayeringModeExecutionSupported({ layering_mode: 'static' }), {
      ok: false,
      reason: 'layering_mode_static_kill_switch_active',
    })
    process.env.LAYERING_MODES_KILL_SWITCH = 'false'
    assert.deepEqual(assertLayeringModeExecutionSupported({ layering_mode: 'static' }), {
      ok: false,
      reason: 'layering_mode_static_mode_disabled',
    })
    process.env.LAYERING_STATIC_EXECUTION_ENABLED = 'true'
    assert.deepEqual(assertLayeringModeExecutionSupported({ layering_mode: 'static' }), {
      ok: false,
      reason: 'layering_mode_static_account_not_allowlisted',
    })
  } finally {
    if (priorEnabled == null) delete process.env.LAYERING_MODES_EXECUTION_ENABLED
    else process.env.LAYERING_MODES_EXECUTION_ENABLED = priorEnabled
    if (priorStatic == null) delete process.env.LAYERING_STATIC_EXECUTION_ENABLED
    else process.env.LAYERING_STATIC_EXECUTION_ENABLED = priorStatic
    if (priorAllowlist == null) delete process.env.LAYERING_MODES_ACCOUNT_ALLOWLIST
    else process.env.LAYERING_MODES_ACCOUNT_ALLOWLIST = priorAllowlist
    if (priorKill == null) delete process.env.LAYERING_MODES_KILL_SWITCH
    else process.env.LAYERING_MODES_KILL_SWITCH = priorKill
    if (priorPrepare == null) delete process.env.LAYERING_MODES_PREPARE_ONLY
    else process.env.LAYERING_MODES_PREPARE_ONLY = priorPrepare
  }
})

test('planner blocks static/dynamic range execution when feature gate is off', () => {
  const priorEnabled = process.env.LAYERING_MODES_EXECUTION_ENABLED
  const priorKill = process.env.LAYERING_MODES_KILL_SWITCH
  delete process.env.LAYERING_MODES_EXECUTION_ENABLED
  delete process.env.LAYERING_MODES_KILL_SWITCH
  try {
    const plan = planManualOrders({
      parsed: {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 2400,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 2390,
        tp: [2410],
        lot_size: null,
      },
      resolvedSymbol: 'XAUUSD',
      baseOperation: 'Buy',
      manual: {
        trade_style: 'multi',
        range_trading: true,
        layering_mode: 'static',
        static_layer_count: 5,
        fixed_lot: 0.1,
        multi_trade_leg_percent: 20,
        range_percent: 50,
        range_step_pips: 3,
        range_distance_pips: 30,
      },
      ctx: {
        point: 0.01,
        digits: 2,
        minLot: 0.01,
        lotStep: 0.01,
        defaultLot: 0.01,
        lastBalance: null,
      },
      channelKeywords: null,
      manualLot: 0.1,
      commentPrefix: 'test',
    })
    assert.equal(plan.orders.length, 0)
    assert.equal(plan.skip_reason, 'layering_mode_static_global_disabled')
  } finally {
    if (priorEnabled == null) delete process.env.LAYERING_MODES_EXECUTION_ENABLED
    else process.env.LAYERING_MODES_EXECUTION_ENABLED = priorEnabled
    if (priorKill == null) delete process.env.LAYERING_MODES_KILL_SWITCH
    else process.env.LAYERING_MODES_KILL_SWITCH = priorKill
  }
})

test('legacy row without plan metadata deserializes as legacy', () => {
  const plan = parseLayeringPlanSnapshot(null)
  assert.ok(plan)
  assert.equal(plan.mode, 'legacy')
  assert.equal(plan.planId, 'legacy')
  assert.equal(plan.lockedAt, null)
})

test('valid legacy snapshot parses when explicitly persisted', () => {
  const plan = parseLayeringPlanSnapshot({
    schemaVersion: 0,
    calculatorVersion: 'legacy',
    mode: 'legacy',
    planId: 'legacy_001',
    side: 'buy',
    anchorSource: 'unknown',
    createdAt: CREATED_AT,
    lockedAt: null,
  })
  assert.ok(plan)
  assert.equal(plan.mode, 'legacy')
})

test('valid static snapshot parses with strict immutable fields', () => {
  const plan = parseLayeringPlanSnapshot(validStaticSnapshot())
  assert.ok(plan)
  assert.equal(plan.mode, 'static')
  assert.equal(plan.configuredStaticLayerCount, 5)
})

test('valid dynamic snapshot parses with strict immutable fields', () => {
  const plan = parseLayeringPlanSnapshot(validDynamicSnapshot())
  assert.ok(plan)
  assert.equal(plan.mode, 'dynamic')
  assert.equal(plan.configuredDynamicStepPips, 5)
})

test('locked plan cannot change mode', () => {
  const plan = parseLayeringPlanSnapshot(validStaticSnapshot({ lockedAt: LOCKED_AT }))
  assert.ok(plan)
  assert.throws(() => changeLayeringPlanMode(plan, 'dynamic'), /cannot change/)
})

test('snapshot round-trip preserves independent configuration values', () => {
  const plan = parseLayeringPlanSnapshot(validDynamicSnapshot())
  assert.ok(plan)
  const roundTrip = parseLayeringPlanSnapshot(serializeLayeringPlanSnapshot(plan))
  assert.deepEqual(roundTrip, plan)
})

test('snapshot anchor sources are exact and invalid values are rejected', () => {
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ anchorSource: 'account' })), null)
  const plan = parseLayeringPlanSnapshot({
    schemaVersion: 0,
    calculatorVersion: 'legacy',
    mode: 'legacy',
    planId: 'legacy_002',
    side: 'buy',
    anchorSource: 'unknown',
    createdAt: CREATED_AT,
    lockedAt: null,
  })
  assert.ok(plan)
  assert.equal(plan.anchorSource, 'unknown')
})

test('planned layer count must be an integer within bounds', () => {
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedLayerCount: 1.5 })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedLayerCount: 0 })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedLayerCount: 21 })), null)
})

test('static count must be an integer within bounds', () => {
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ configuredStaticLayerCount: 1.5 })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ configuredStaticLayerCount: 0 })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ configuredStaticLayerCount: 21 })), null)
})

test('dynamic step must be a positive finite JSON number', () => {
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicStepPips: 0 })), null)
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicStepPips: -1 })), null)
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicStepPips: Number.NaN })), null)
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicStepPips: Number.POSITIVE_INFINITY })), null)
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicStepPips: '5' })), null)
})

test('dynamic max layers must be an integer within bounds', () => {
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicMaxLayers: 2.5 })), null)
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicMaxLayers: 0 })), null)
  assert.equal(parseLayeringPlanSnapshot(validDynamicSnapshot({ configuredDynamicMaxLayers: 21 })), null)
})

test('planned total lot must be a non-negative finite JSON number', () => {
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedTotalLot: -0.01 })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedTotalLot: Number.NaN })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedTotalLot: Number.POSITIVE_INFINITY })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedTotalLot: '0.1' })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ plannedTotalLot: 0 })), null)
})

test('plan id format is bounded and path-safe', () => {
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ planId: 'bad id' })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ planId: 'short' })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ planId: 'x'.repeat(129) })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ planId: ' plan_static_001' })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ planId: 'plan/static/001' })), null)
  assert.ok(parseLayeringPlanSnapshot(validStaticSnapshot({ planId: 'plan-static_001' })))
})

test('timestamps and lock order are strict', () => {
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ createdAt: 'today' })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({ lockedAt: 'later' })), null)
  assert.equal(parseLayeringPlanSnapshot(validStaticSnapshot({
    createdAt: LOCKED_AT,
    lockedAt: CREATED_AT,
  })), null)
})

test('malformed non-null metadata does not become legacy', () => {
  assert.equal(parseLayeringPlanSnapshot({ anchorSource: 'unknown', createdAt: CREATED_AT }), null)
  assert.equal(parseLayeringPlanSnapshot({ mode: 'bogus', anchorSource: 'unknown', createdAt: CREATED_AT }), null)
})

test('parser never throws on arbitrary input', () => {
  const throwing = new Proxy({}, {
    get() {
      throw new Error('boom')
    },
  })
  const values: unknown[] = [
    undefined,
    1,
    'text',
    [],
    throwing,
    validStaticSnapshot({ originalRangeLow: Number.NaN }),
    validStaticSnapshot({ originalRangeLow: 3360, originalRangeHigh: 3340 }),
    validDynamicSnapshot({ anchorPrice: null }),
  ]
  for (const value of values) {
    assert.doesNotThrow(() => parseLayeringPlanSnapshot(value))
  }
})

test('migration is additive and leaves old rows nullable legacy', () => {
  const sql = readFileSync('../supabase/migrations/20260730130000_layering_modes_foundation.sql', 'utf8')
  assert.match(sql, /add column if not exists layer_plan_id text/i)
  assert.match(sql, /add column if not exists layer_plan_metadata jsonb/i)
  assert.match(sql, /where layer_plan_id is not null/i)
  assert.doesNotMatch(sql, /\bdelete\b|\bdrop column\b|\bupdate public\.range_pending_legs\b/i)
})
