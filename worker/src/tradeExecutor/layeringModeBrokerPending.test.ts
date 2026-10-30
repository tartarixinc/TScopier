import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { calculateStaticLayerPlan } from '../manualPlanning/layeringModeCalculators'
import {
  buildLayeringPlanSnapshot,
  computeLayeringPlanFingerprint,
  generateLayerPlanId,
} from '../manualPlanning/layeringPlanPersistence'
import type { LayeringPlanSnapshot } from '../manualPlanning/types'
import {
  activateLayeringBrokerPendingOrders,
  brokerOrderMatchesLayer,
  brokerPendingOperationForLayer,
  buildLayeringBrokerPendingClientReference,
  findBrokerOrderByClientReference,
  validateBrokerPendingPrice,
} from './layeringModeBrokerPending'
import { recoverNativeLayeringSubmissions } from './layeringModeBrokerPendingRecovery'

const OLD_ENV = { ...process.env }

function restoreEnv(): void {
  process.env = { ...OLD_ENV }
}

function enableLayeringEnv(): void {
  process.env.LAYERING_MODES_EXECUTION_ENABLED = 'true'
  process.env.LAYERING_STATIC_EXECUTION_ENABLED = 'true'
  process.env.LAYERING_DYNAMIC_EXECUTION_ENABLED = 'true'
  process.env.LAYERING_MODES_ACCOUNT_ALLOWLIST = '22222222-2222-4222-8222-222222222222'
  process.env.LAYERING_MODES_PREPARE_ONLY = 'false'
  process.env.LAYERING_MODES_KILL_SWITCH = 'false'
}

function snapshot(): LayeringPlanSnapshot {
  const identity = {
    signalId: '11111111-1111-4111-8111-111111111111',
    brokerAccountId: '22222222-2222-4222-8222-222222222222',
    basketKey: 'basket-static',
    symbol: 'XAUUSD',
    side: 'buy' as const,
    mode: 'static' as const,
  }
  const planId = generateLayerPlanId(identity)
  assert.ok(planId)
  const calc = calculateStaticLayerPlan({
    side: 'buy',
    rangeLow: 3340,
    rangeHigh: 3360,
    totalLayerCount: 5,
    symbolDigits: 2,
    intendedTotalLot: 0.1,
    minLot: 0.01,
    lotStep: 0.01,
  })
  assert.equal(calc.ok, true)
  const built = buildLayeringPlanSnapshot({
    ...identity,
    planId,
    calculatedPlan: calc,
    anchorSource: 'signal',
    configuredStaticLayerCount: 5,
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  assert.equal(built.ok, true)
  return built.snapshot
}

type Row = Record<string, unknown>

class Query {
  private readonly filters: Array<(row: Row) => boolean> = []
  private readonly inFilters: Array<{ key: string; values: unknown[] }> = []
  private readonly isFilters: Array<{ key: string; value: unknown }> = []
  private patch: Row | null = null
  private selected = false

  constructor(private readonly db: MockSupabase, private readonly table: string) {}

  select() { this.selected = true; return this }
  order() { return this }
  limit() { return this }
  not() { return this }
  eq(key: string, value: unknown) { this.filters.push(row => row[key] === value); return this }
  in(key: string, values: unknown[]) { this.inFilters.push({ key, values }); return this }
  is(key: string, value: unknown) { this.isFilters.push({ key, value }); return this }
  update(patch: Row) { this.patch = patch; return this }
  insert(row: Row) { this.rows().push({ ...row }); return Promise.resolve({ data: { id: row.id ?? 'inserted' }, error: null }) }

  async maybeSingle() {
    const rows = this.filtered()
    if (this.patch) {
      if (this.db.failNextConfirm && this.patch.native_submission_status === 'confirmed') {
        this.db.failNextConfirm = false
        return { data: null, error: null }
      }
      if (this.db.forceClaimLoss && this.patch.native_submission_status === 'submission_claimed') {
        return { data: null, error: null }
      }
      const row = rows[0]
      if (!row) return { data: null, error: null }
      Object.assign(row, this.patch)
      return { data: this.selected ? { ...row } : null, error: null }
    }
    return { data: rows[0] ? { ...rows[0] } : null, error: null }
  }

  then(resolve: (value: { data: Row[]; error: null }) => void, reject?: (reason: unknown) => void) {
    try {
      if (this.patch) this.filtered().forEach(row => Object.assign(row, this.patch))
      resolve({ data: this.filtered().map(row => ({ ...row })), error: null })
    } catch (err) {
      reject?.(err)
    }
  }

  private rows(): Row[] {
    return this.table === 'range_pending_legs' ? this.db.legs : this.db.plans
  }

  private filtered(): Row[] {
    return this.rows().filter(row => (
      this.filters.every(fn => fn(row))
      && this.inFilters.every(f => f.values.includes(row[f.key]))
      && this.isFilters.every(f => f.value === null ? row[f.key] == null : row[f.key] === f.value)
    ))
  }
}

class MockSupabase {
  readonly plans: Row[]
  readonly legs: Row[] = []
  readonly rpcCalls: Array<{ name: string; args: Row }> = []
  failNextConfirm = false
  forceClaimLoss = false

  constructor(private readonly snap: LayeringPlanSnapshot) {
    this.plans = [{
      layer_plan_id: snap.planId,
      signal_id: snap.signalId,
      broker_account_id: snap.brokerAccountId,
      basket_key: snap.basketKey ?? '',
      mode: snap.mode,
      status: 'prepared',
      layer_plan_metadata: snap,
      semantic_fingerprint: computeLayeringPlanFingerprint(snap),
      created_at: snap.createdAt,
      locked_at: snap.lockedAt,
    }]
  }

  from(table: string) {
    return new Query(this, table)
  }

  async rpc(name: string, args: Row) {
    this.rpcCalls.push({ name, args })
    assert.equal(name, 'activate_layering_plan')
    assert.equal(args.p_layer_plan_id, this.snap.planId)
    assert.equal(args.p_execution_mechanism, 'pending_order')
    assert.equal(args.p_exclude_first_layer, true)
    assert.equal(Object.prototype.hasOwnProperty.call(args, 'p_legs'), false)
    const plan = this.plans[0]!
    if (plan.status === 'active') return { data: 'already_active', error: null }
    plan.status = 'active'
    for (let idx = 1; idx < this.snap.fundedPrices!.length; idx += 1) {
      this.legs.push({
        id: `leg-${idx + 1}`,
        layer_plan_id: this.snap.planId,
        layer_plan_metadata: this.snap,
        signal_id: this.snap.signalId,
        user_id: '33333333-3333-4333-8333-333333333333',
        broker_account_id: this.snap.brokerAccountId,
        metaapi_account_id: '44444444-4444-4444-8444-444444444444',
        symbol: this.snap.symbol,
        step_idx: idx + 1,
        is_buy: true,
        volume: this.snap.lots![idx],
        anchor_price: this.snap.fundedPrices![0],
        trigger_price: this.snap.fundedPrices![idx],
        stoploss: 3300,
        takeprofit: 3400,
        slippage: 20,
        comment: 'TScopier:test',
        expert_id: 909090,
        expires_at: null,
        status: 'broker_pending',
        native_submission_status: 'planned',
        submission_attempt: 0,
      })
    }
    return { data: 'activated', error: null }
  }
}

function prepFor(snap = snapshot(), opts?: { opened?: unknown[]; openedThrows?: Error; sendThrows?: Error; sendThrowsOnce?: Error; afterSend?: () => void }) {
  const sends: unknown[] = []
  const api = {
    async openedOrders() {
      if (opts?.openedThrows) throw opts.openedThrows
      return opts?.opened ?? []
    },
    async quote() { return { symbol: 'XAUUSD', bid: 3365, ask: 3365.5 } },
    async orderSend(_uuid: string, args: unknown) {
      sends.push(args)
      opts?.afterSend?.()
      if (opts?.sendThrowsOnce && sends.length === 1) throw opts.sendThrowsOnce
      if (opts?.sendThrows) throw opts.sendThrows
      return { ticket: 9000 + sends.length }
    },
    async orderClose(_uuid: string, args: { ticket: number }) { return { ticket: args.ticket } },
  }
  const supabase = new MockSupabase(snap)
  const prep = {
    api,
    ctx: { supabase },
    signal: { id: snap.signalId, user_id: '33333333-3333-4333-8333-333333333333' },
    broker: {
      id: snap.brokerAccountId,
      platform: 'MT5',
      fxsocket_account_id: 'fx-1',
      connection_status: 'connected',
      trade_allowed: true,
    },
    uuid: '44444444-4444-4444-8444-444444444444',
    symbol: 'XAUUSD',
    params: { digits: 2, point: 0.01, stopsLevel: 0, freezeLevel: 0, minLot: 0.01, maxLot: 100, lotStep: 0.01 },
    manual: { range_layering_type: 'pending_order' },
    commentPrefix: 'TScopier:test',
    legs: [{ args: { stoploss: 3300, takeprofit: 3400, slippage: 20, expertID: 909090 } }],
  }
  return { prep: prep as never, api, sends, supabase }
}

test('broker pending operation maps averaging direction to limit orders', () => {
  assert.equal(brokerPendingOperationForLayer('buy'), 'BuyLimit')
  assert.equal(brokerPendingOperationForLayer('sell'), 'SellLimit')
})

test('deterministic client reference is safe and identity-sensitive', () => {
  const a = buildLayeringBrokerPendingClientReference({ planId: 'layerplan_abc12345', stepIdx: 2, brokerAccountId: 'acct-a' })
  const b = buildLayeringBrokerPendingClientReference({ planId: 'layerplan_abc12345', stepIdx: 2, brokerAccountId: 'acct-a' })
  const c = buildLayeringBrokerPendingClientReference({ planId: 'layerplan_abc12345', stepIdx: 3, brokerAccountId: 'acct-a' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^layer_[A-Za-z0-9_-]{16}_2$/)
  assert.ok(a.length <= 31)
  assert.doesNotMatch(a, /acct|layerplan_abc12345/)
})

test('broker order reconciliation finds matching reference and validates shape', () => {
  const order = { ticket: 99, symbol: 'XAUUSD', operation: 'BuyLimit', openPrice: 3355, lots: 0.02, comment: 'layer_ref_2' }
  assert.equal(findBrokerOrderByClientReference([order], 'layer_ref_2'), order)
  assert.equal(brokerOrderMatchesLayer({ order, symbol: 'XAUUSD', operation: 'BuyLimit', price: 3355, lot: 0.02, digits: 2 }), true)
  assert.equal(brokerOrderMatchesLayer({ order, symbol: 'XAUUSD', operation: 'BuyLimit', price: 3350, lot: 0.02, digits: 2 }), false)
})

test('pending price validation rejects wrong-side or too-close levels', () => {
  assert.equal(validateBrokerPendingPrice({ side: 'buy', price: 99, bid: 100, ask: 100.2, point: 0.01, stopsLevel: 0, freezeLevel: 0 }), null)
  assert.equal(validateBrokerPendingPrice({ side: 'sell', price: 101, bid: 100, ask: 100.2, point: 0.01, stopsLevel: 0, freezeLevel: 0 }), null)
  assert.equal(validateBrokerPendingPrice({ side: 'buy', price: 100.2, bid: 100, ask: 100.2, point: 0.01, stopsLevel: 0, freezeLevel: 0 }), 'broker_pending_min_distance')
  assert.equal(validateBrokerPendingPrice({ side: 'sell', price: 100, bid: 100, ask: 100.2, point: 0.01, stopsLevel: 0, freezeLevel: 0 }), 'broker_pending_min_distance')
})

test('native pending sends only after durable per-leg claim', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap, {
    afterSend: () => {
      assert.equal(supabase.legs.filter(r => r.native_submission_status === 'submission_claimed').length, 1)
    },
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: true, outcome: 'activated', placed: 4, adopted: 0 })
  assert.equal(sends.length, 4)
  for (const args of sends) {
    const a = args as { stoploss?: number; takeprofit?: number }
    assert.equal(a.stoploss, 3300, 'resting broker pending carries planned SL')
    assert.equal(a.takeprofit, 3400, 'resting broker pending carries planned TP')
  }
  assert.deepEqual(supabase.legs.map(r => r.step_idx), [2, 3, 4, 5])
  assert.deepEqual(supabase.legs.map(r => r.trigger_price), snap.fundedPrices!.slice(1))
  assert.equal(supabase.legs.every(r => r.native_submission_status === 'confirmed'), true)
  // Desired stops remain on the DB row for post-fill assignment.
  assert.equal(supabase.legs.every(r => Number(r.stoploss) === 3300), true)
  assert.equal(supabase.legs.every(r => Number(r.takeprofit) === 3400), true)
  restoreEnv()
})

test('broker invalid-stops rejection fails the pending order without a naked resend', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends } = prepFor(snap, {
    sendThrowsOnce: new Error('Invalid stops'),
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_rejected_stops' })
  assert.equal(sends.length, 1, 'no naked resend after the broker rejects stops')
  const first = sends[0] as { stoploss?: number; takeprofit?: number }
  assert.equal(first.stoploss, 3300, 'the attempt carries the planned SL')
  assert.equal(first.takeprofit, 3400, 'the attempt carries the planned TP')
  restoreEnv()
})

test('broker is not called when durable claim loses', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap)
  supabase.forceClaimLoss = true
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_claim_lost' })
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('confirmed native order never resends on retry', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap)
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs.forEach((row, i) => {
    row.native_submission_status = 'confirmed'
    row.ticket = String(7000 + i)
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: true, outcome: 'already_active', placed: 0, adopted: 0 })
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('submission_ambiguous lookup miss never resends and stays manual review', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap)
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'submission_ambiguous'
  supabase.legs[0]!.broker_client_reference = buildLayeringBrokerPendingClientReference({ planId: snap.planId, stepIdx: 2, brokerAccountId: snap.brokerAccountId })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_manual_review_required' })
  assert.equal(sends.length, 0)
  assert.equal(supabase.legs[0]!.native_submission_status, 'reconciliation_required')
  assert.equal(supabase.legs[0]!.reconciliation_reason, 'manual_review_required')
  restoreEnv()
})

test('reconciliation_required lookup miss repeatedly remains non-sendable', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap)
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'reconciliation_required'
  supabase.legs[0]!.broker_client_reference = buildLayeringBrokerPendingClientReference({ planId: snap.planId, stepIdx: 2, brokerAccountId: snap.brokerAccountId })
  await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_manual_review_required' })
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('reconciliation lookup outage does not send', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap, { openedThrows: new Error('OpenedOrders timed out') })
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'reconciliation_required'
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_reconciliation_pending' })
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('matching ambiguous reference is adopted without resend', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const ref = buildLayeringBrokerPendingClientReference({ planId: snap.planId, stepIdx: 2, brokerAccountId: snap.brokerAccountId })
  const { prep, sends, supabase } = prepFor(snap, {
    opened: [{ ticket: 8123, symbol: 'XAUUSD', operation: 'BuyLimit', openPrice: snap.fundedPrices![1], lots: snap.lots![1], comment: ref }],
  })
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'reconciliation_required'
  supabase.legs[0]!.broker_client_reference = ref
  supabase.legs.slice(1).forEach((row, i) => {
    row.native_submission_status = 'confirmed'
    row.ticket = String(9200 + i)
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: true, outcome: 'already_active', placed: 0, adopted: 1 })
  assert.equal(supabase.legs[0]!.native_submission_status, 'confirmed')
  assert.equal(supabase.legs[0]!.ticket, '8123')
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('manual-review native state cannot send', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap)
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'manual_review'
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_not_sendable' })
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('startup recovery claims stale claimed leg and reconciles without orderSend', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const ref = buildLayeringBrokerPendingClientReference({ planId: snap.planId, stepIdx: 2, brokerAccountId: snap.brokerAccountId })
  const { api, sends, supabase } = prepFor(snap, {
    opened: [{ ticket: 9001, symbol: 'XAUUSD', operation: 'BuyLimit', openPrice: snap.fundedPrices![1], lots: snap.lots![1], comment: ref }],
  })
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'submission_claimed'
  const result = await recoverNativeLayeringSubmissions({
    supabase: supabase as never,
    apiLookup: () => api as never,
  })
  assert.deepEqual(result, { scanned: 1, recovered: 1, unresolved: 0, invalid: 0 })
  assert.equal(supabase.legs[0]!.native_submission_status, 'confirmed')
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('startup recovery unresolved miss does not use quote or orderSend', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { api, sends, supabase } = prepFor(snap)
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'reconciliation_required'
  const result = await recoverNativeLayeringSubmissions({
    supabase: supabase as never,
    apiLookup: () => api as never,
  })
  assert.deepEqual(result, { scanned: 1, recovered: 0, unresolved: 1, invalid: 0 })
  assert.equal(sends.length, 0)
  assert.equal(supabase.legs[0]!.native_submission_status, 'manual_review')
  assert.equal(supabase.legs[0]!.reconciliation_claimed_by, null)
  restoreEnv()
})

test('active recovery lease prevents concurrent ownership transfer', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { api, sends, supabase } = prepFor(snap)
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'reconciliation_required'
  supabase.legs[0]!.reconciliation_claimed_by = 'live-worker'
  supabase.legs[0]!.reconciliation_claimed_at = new Date().toISOString()
  const result = await recoverNativeLayeringSubmissions({
    supabase: supabase as never,
    apiLookup: () => api as never,
  })
  assert.deepEqual(result, { scanned: 1, recovered: 0, unresolved: 0, invalid: 0 })
  assert.equal(supabase.legs[0]!.reconciliation_claimed_by, 'live-worker')
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('expired recovery lease is reclaimable after worker crash', async () => {
  restoreEnv()
  enableLayeringEnv()
  process.env.LAYERING_NATIVE_RECOVERY_LEASE_TIMEOUT_MS = '1000'
  const snap = snapshot()
  const ref = buildLayeringBrokerPendingClientReference({ planId: snap.planId, stepIdx: 2, brokerAccountId: snap.brokerAccountId })
  const { api, sends, supabase } = prepFor(snap, {
    opened: [{ ticket: 9123, symbol: 'XAUUSD', operation: 'BuyLimit', openPrice: snap.fundedPrices![1], lots: snap.lots![1], comment: ref }],
  })
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'reconciliation_required'
  supabase.legs[0]!.broker_client_reference = ref
  supabase.legs[0]!.reconciliation_claimed_by = 'crashed-worker'
  supabase.legs[0]!.reconciliation_claimed_at = '1970-01-01T00:00:00.000Z'
  const result = await recoverNativeLayeringSubmissions({
    supabase: supabase as never,
    apiLookup: () => api as never,
  })
  assert.deepEqual(result, { scanned: 1, recovered: 1, unresolved: 0, invalid: 0 })
  assert.equal(supabase.legs[0]!.native_submission_status, 'confirmed')
  assert.equal(supabase.legs[0]!.ticket, '9123')
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('repeated startup recovery can adopt when broker lookup later succeeds after outage', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const ref = buildLayeringBrokerPendingClientReference({ planId: snap.planId, stepIdx: 2, brokerAccountId: snap.brokerAccountId })
  const { api, sends, supabase } = prepFor(snap, { openedThrows: new Error('OpenedOrders timed out') })
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'reconciliation_required'
  supabase.legs[0]!.broker_client_reference = ref
  const first = await recoverNativeLayeringSubmissions({
    supabase: supabase as never,
    apiLookup: () => api as never,
  })
  assert.deepEqual(first, { scanned: 1, recovered: 0, unresolved: 1, invalid: 0 })
  assert.equal(supabase.legs[0]!.native_submission_status, 'reconciliation_required')
  assert.equal(supabase.legs[0]!.reconciliation_claimed_by, null)
  const adoptingApi = {
    ...api,
    async openedOrders() {
      return [{ ticket: 9321, symbol: 'XAUUSD', operation: 'BuyLimit', openPrice: snap.fundedPrices![1], lots: snap.lots![1], comment: ref }]
    },
  }
  const second = await recoverNativeLayeringSubmissions({
    supabase: supabase as never,
    apiLookup: () => adoptingApi as never,
  })
  assert.deepEqual(second, { scanned: 1, recovered: 1, unresolved: 0, invalid: 0 })
  assert.equal(supabase.legs[0]!.native_submission_status, 'confirmed')
  assert.equal(supabase.legs[0]!.ticket, '9321')
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('startup recovery broker lookup timeout releases lease for later retry', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { api, sends, supabase } = prepFor(snap, { openedThrows: new Error('OpenedOrders timed out') })
  await supabase.rpc('activate_layering_plan', { p_layer_plan_id: snap.planId, p_execution_mechanism: 'pending_order', p_exclude_first_layer: true })
  supabase.legs[0]!.native_submission_status = 'submission_ambiguous'
  const result = await recoverNativeLayeringSubmissions({
    supabase: supabase as never,
    apiLookup: () => api as never,
  })
  assert.deepEqual(result, { scanned: 1, recovered: 0, unresolved: 1, invalid: 0 })
  assert.equal(supabase.legs[0]!.native_submission_status, 'reconciliation_required')
  assert.equal(supabase.legs[0]!.reconciliation_claimed_by, null)
  assert.equal(sends.length, 0)
  restoreEnv()
})

test('range broker pending monitor startup invokes native layering recovery', () => {
  const source = readFileSync('src/rangeBrokerPendingMonitor.ts', 'utf8')
  assert.match(source, /recoverNativeLayeringSubmissions/)
  assert.match(source, /void this\.runTick\(\)/)
})

test('broker accepted but DB confirmation failed enters reconciliation state', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap)
  supabase.failNextConfirm = true
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_confirm_failed' })
  assert.equal(sends.length, 1)
  assert.equal(supabase.legs[0]!.native_submission_status, 'reconciliation_required')
  restoreEnv()
})

test('kill switch flipping between orders records first and blocks second send', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends, supabase } = prepFor(snap, {
    afterSend: () => {
      if (sends.length === 1) process.env.LAYERING_MODES_KILL_SWITCH = 'true'
    },
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_blocked' })
  assert.equal(sends.length, 1)
  assert.equal(supabase.legs[0]!.native_submission_status, 'confirmed')
  assert.notEqual(supabase.legs[1]!.native_submission_status, 'confirmed')
  restoreEnv()
})

test('prepare-only flipping between orders blocks later native sends', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends } = prepFor(snap, {
    afterSend: () => {
      if (sends.length === 1) process.env.LAYERING_MODES_PREPARE_ONLY = 'true'
    },
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_blocked' })
  assert.equal(sends.length, 1)
  restoreEnv()
})

test('allowlist removal between orders blocks later native sends', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends } = prepFor(snap, {
    afterSend: () => {
      if (sends.length === 1) process.env.LAYERING_MODES_ACCOUNT_ALLOWLIST = ''
    },
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_blocked' })
  assert.equal(sends.length, 1)
  restoreEnv()
})

test('mode flag disabled between orders blocks later native sends', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const { prep, sends } = prepFor(snap, {
    afterSend: () => {
      if (sends.length === 1) process.env.LAYERING_STATIC_EXECUTION_ENABLED = 'false'
    },
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_blocked' })
  assert.equal(sends.length, 1)
  restoreEnv()
})

test('conflicting broker reference marks the plan invalid and fails closed', async () => {
  restoreEnv()
  enableLayeringEnv()
  const snap = snapshot()
  const ref = buildLayeringBrokerPendingClientReference({ planId: snap.planId, stepIdx: 2, brokerAccountId: snap.brokerAccountId })
  const { prep, sends, supabase } = prepFor(snap, {
    opened: [{ ticket: 501, symbol: 'XAUUSD', operation: 'BuyLimit', openPrice: 1, lots: snap.lots![1], comment: ref }],
  })
  const result = await activateLayeringBrokerPendingOrders({ prep, snapshot: snap, skipFirstLayer: true })
  assert.deepEqual(result, { ok: false, reason: 'broker_pending_conflict' })
  assert.equal(sends.length, 0)
  assert.equal(supabase.plans[0]!.status, 'invalid')
  restoreEnv()
})
