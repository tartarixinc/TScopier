import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  evaluateTpTouch,
  FireLegResult,
  fillWithinTriggerBand,
  isTriggered,
  layerLatencyPayload,
  shouldLockBasketLayering,
  VirtualPendingMonitor,
} from './virtualPendingMonitor'
import { isAdverselyCrossed, isOutwardCatchUp } from './tradeExecutor/helpers'
import { isBlockedByShallowerStep } from './virtualPendingMonitor'
import {
  computeLayerFireBudget,
  isLegEligibleByDistance,
  newLayersForTick,
  selectLegsForLayerTick,
  selectPendingLegsForDistanceBurst,
} from './layerConcurrentFire'
import {
  initWorkerSentry,
  resetWorkerSentryForTests,
  setSentryAdapterForTests,
} from './observability/sentry'
import { resetBusinessEventsForTests } from './observability/businessEvents'

type TestLeg = {
  id: string
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  step_idx: number
  is_buy: boolean
  volume: number
  anchor_price: number
  trigger_price: number
  stoploss: number | null
  takeprofit: number | null
  slippage: number
  comment: string | null
  expert_id: number | null
  expires_at: string | null
  status: string
  cwe_close_price: number | null
}

type FireLegHarness = {
  operations: string[]
  brokerSends: number
  supabase: FakeSupabase
  monitor: VirtualPendingMonitor
  fireLeg: (leg: TestLeg, bid: number, ask: number) => Promise<FireLegResult>
  recordFireLegResult: (
    result: FireLegResult,
    leg: Pick<TestLeg, 'signal_id' | 'broker_account_id' | 'step_idx'>,
    active: Map<string, Set<number>>,
    fired: Map<string, Set<number>>,
  ) => FireLegResult['outcome']
}

type FakeSupabaseOptions = {
  operations: string[]
  claimedRow?: { id: string } | null
}

class MockScope {
  level: string | null = null
  tags: Record<string, string> = {}
  contexts: Record<string, unknown> = {}
  extras: Record<string, unknown> = {}
  fingerprint: string[] | null = null
  setLevel(level: string): void { this.level = level }
  setTag(key: string, value: string): void { this.tags[key] = value }
  setContext(key: string, value: unknown): void { this.contexts[key] = value }
  setExtra(key: string, value: unknown): void { this.extras[key] = value }
  setFingerprint(value: string[]): void { this.fingerprint = value }
}

function setupSentry() {
  resetWorkerSentryForTests()
  resetBusinessEventsForTests()
  delete process.env.SENTRY_BUSINESS_EVENT_COOLDOWN_MS
  const mock = {
    capturedMessages: [] as unknown[],
    breadcrumbs: [] as unknown[],
    scopes: [] as MockScope[],
    captureMessage(msg: string, level?: string) {
      mock.capturedMessages.push({ msg, level })
      return 'event-id'
    },
    init() {},
    captureException() { return 'event-id' },
    addBreadcrumb(crumb: unknown) { mock.breadcrumbs.push(crumb) },
    setTag() {},
    setContext() {},
    withScope(fn: (scope: MockScope) => void) {
      const scope = new MockScope()
      mock.scopes.push(scope)
      fn(scope)
    },
    async flush() { return true },
  }
  setSentryAdapterForTests(mock as never)
  initWorkerSentry({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  return mock
}

class FakeSupabase {
  readonly operations: string[]
  claimedRow: { id: string } | null
  releaseFilters: Array<{ id?: unknown; status?: unknown }> = []

  constructor(opts: FakeSupabaseOptions) {
    this.operations = opts.operations
    this.claimedRow = opts.claimedRow === undefined ? { id: 'leg-1' } : opts.claimedRow
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table)
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null; count?: number | null }> {
  private op: 'select' | 'update' | 'insert' | 'delete' | null = null
  private selected = ''
  private payload: Record<string, unknown> | null = null
  private filters = new Map<string, unknown>()

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(columns = ''): this {
    this.op = this.op ?? 'select'
    this.selected = columns
    return this
  }

  update(payload: Record<string, unknown>): this {
    this.op = 'update'
    this.payload = payload
    return this
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = 'insert'
    this.payload = Array.isArray(payload) ? { rows: payload } : payload
    return this
  }

  delete(): this {
    this.op = 'delete'
    return this
  }

  eq(key: string, value: unknown): this {
    this.filters.set(key, value)
    return this
  }

  in(): this {
    return this
  }

  not(): this {
    return this
  }

  order(): this {
    return this
  }

  limit(): this {
    return this
  }

  maybeSingle(): Promise<{ data: unknown; error: null; count?: number | null }> {
    return Promise.resolve(this.resolve())
  }

  then<TResult1 = { data: unknown; error: null; count?: number | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count?: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected)
  }

  private resolve(): { data: unknown; error: null; count?: number | null } {
    if (this.table === 'range_pending_legs' && this.op === 'update' && this.payload?.status === 'claimed') {
      this.db.operations.push('claim')
      return { data: this.db.claimedRow, error: null }
    }
    if (this.table === 'range_pending_legs' && this.op === 'update' && this.payload?.status === 'pending') {
      this.db.operations.push('release')
      this.db.releaseFilters.push({
        id: this.filters.get('id'),
        status: this.filters.get('status'),
      })
      return { data: null, error: null }
    }
    if (this.table === 'range_pending_legs' && this.op === 'delete') {
      this.db.operations.push('cleanup')
      return { data: [{ id: 'leg-1' }], error: null }
    }
    if (this.table === 'range_pending_legs' && this.selected === 'stoploss,takeprofit,cwe_close_price') {
      this.db.operations.push('sltp-refresh')
      return { data: { stoploss: 99, takeprofit: 105, cwe_close_price: null }, error: null }
    }
    if (this.table === 'signals' && this.selected === 'channel_id') {
      this.db.operations.push('layer-till-close')
      return { data: { channel_id: null }, error: null }
    }
    if (this.table === 'signals') {
      this.db.operations.push('signal-stop-refresh')
      return { data: { channel_id: null, created_at: null, parsed_data: {} }, error: null }
    }
    if (this.table === 'broker_accounts') {
      this.db.operations.push('broker-settings')
      return { data: { manual_settings: {}, channel_trading_configs: null }, error: null }
    }
    if (this.table === 'range_pending_tp_locks') {
      this.db.operations.push('tp-lock-check')
      return { data: null, count: 0, error: null }
    }
    if (this.table === 'trade_execution_logs' && this.op === 'select') {
      this.db.operations.push('cap-check')
      return { data: null, count: 0, error: null }
    }
    if (this.table === 'trades' && this.op === 'select') {
      this.db.operations.push('open-trades-check')
      return { data: [], error: null }
    }
    if (this.table === 'trades' && this.op === 'insert') {
      this.db.operations.push('trade-insert')
      return { data: { id: 'trade-1' }, error: null }
    }
    if (this.table === 'trade_execution_logs' && this.op === 'insert') {
      this.db.operations.push('execution-log')
      return { data: null, error: null }
    }
    return { data: null, count: 0, error: null }
  }
}

function makeTestLeg(overrides: Partial<TestLeg> = {}): TestLeg {
  return {
    id: 'leg-1',
    signal_id: 'signal-1',
    user_id: 'user-1',
    broker_account_id: 'broker-1',
    metaapi_account_id: 'session-1',
    symbol: 'XAUUSD',
    step_idx: 1,
    is_buy: true,
    volume: 0.01,
    anchor_price: 101,
    trigger_price: 100,
    stoploss: 99,
    takeprofit: 105,
    slippage: 20,
    comment: null,
    expert_id: null,
    expires_at: null,
    status: 'pending',
    cwe_close_price: null,
    ...overrides,
  }
}

function makeFireLegHarness(opts: {
  claimedRow?: { id: string } | null
  staleReason?: string | null
  symbolPoint?: number | null
  manual?: Record<string, unknown>
  openPrice?: number
} = {}): FireLegHarness & { sendArgs: Array<{ stoploss?: number; takeprofit?: number }> } {
  process.env.FXSOCKET_API_KEY = process.env.FXSOCKET_API_KEY || 'test-key'
  const operations: string[] = []
  const sendArgs: Array<{ stoploss?: number; takeprofit?: number }> = []
  let brokerSends = 0
  const supabase = new FakeSupabase({ operations, claimedRow: opts.claimedRow })
  const monitor = new VirtualPendingMonitor(supabase as never)
  const m = monitor as unknown as {
    getSymbolParams: () => Promise<{ digits: number; point: number | null; minLot: number; lotStep: number; contractSize: null; stopsLevel: number; freezeLevel: number; loadedAt: number }>
    getStaleLegReason: () => Promise<string | null>
    sendLegOrder: (
      _leg: unknown,
      args: { stoploss?: number; takeprofit?: number },
    ) => Promise<{ openPrice: number; lots: number }>
    markLegFiredWithRetry: () => Promise<void>
    loadManualSettingsForLeg: () => Promise<Record<string, unknown>>
    fireLeg: FireLegHarness['fireLeg']
    recordFireLegResult: FireLegHarness['recordFireLegResult']
  }
  m.getSymbolParams = async () => {
    operations.push('symbol-params')
    return {
      digits: 2,
      point: opts.symbolPoint === undefined ? 0.01 : opts.symbolPoint,
      minLot: 0.01,
      lotStep: 0.01,
      contractSize: null,
      stopsLevel: 0,
      freezeLevel: 0,
      loadedAt: Date.now(),
    }
  }
  m.getStaleLegReason = async () => {
    operations.push('stale-check')
    return opts.staleReason ?? null
  }
  m.sendLegOrder = async (_leg, args) => {
    operations.push('broker-send')
    sendArgs.push({ stoploss: args.stoploss, takeprofit: args.takeprofit })
    brokerSends += 1
    return { openPrice: opts.openPrice ?? 100, lots: 0.01 }
  }
  m.markLegFiredWithRetry = async () => {
    operations.push('mark-fired')
  }
  m.loadManualSettingsForLeg = async () => opts.manual ?? {}
  return {
    operations,
    get brokerSends() {
      return brokerSends
    },
    supabase,
    monitor,
    fireLeg: m.fireLeg.bind(monitor),
    recordFireLegResult: m.recordFireLegResult.bind(monitor),
    sendArgs,
  }
}

// Buy ladder = averaging DOWN: trigger fires when bid drops to / below trigger_price.
test('isTriggered: buy fires when bid <= trigger', () => {
  assert.equal(isTriggered(true, 1840, 1839.5, 1839.6), true)
  assert.equal(isTriggered(true, 1840, 1840, 1840.1), true)   // exactly at trigger
})

test('isTriggered: buy does NOT fire when bid > trigger', () => {
  assert.equal(isTriggered(true, 1840, 1850, 1850.1), false)
})

// Sell ladder = averaging UP: trigger fires when ask rises to / above trigger_price.
test('isTriggered: sell fires when ask >= trigger', () => {
  assert.equal(isTriggered(false, 1860, 1859.9, 1860), true)  // exactly at trigger
  assert.equal(isTriggered(false, 1860, 1860, 1861), true)
})

test('isTriggered: sell does NOT fire when ask < trigger', () => {
  assert.equal(isTriggered(false, 1860, 1849, 1849.5), false)
})

test('isTriggered: rejects invalid inputs', () => {
  assert.equal(isTriggered(true, 0, 1840, 1841), false)
  assert.equal(isTriggered(true, NaN, 1840, 1841), false)
  assert.equal(isTriggered(true, 1840, NaN, 1841), false)
  assert.equal(isTriggered(false, 1840, 1841, NaN), false)
})

// Pip math sanity: a buy ladder anchored at 1850 with stepPriceOffset=1.0 and
// stepIdx=3 has trigger = 1847. Bid at 1847.0 ⇒ fire.
test('isTriggered: realistic XAUUSD buy ladder fires correctly', () => {
  const anchor = 1850
  const stepPriceOffset = 1.0 // 10 smart pips on XAUUSD @ 2-digit
  const trigger = anchor - 3 * stepPriceOffset
  assert.equal(trigger, 1847)
  assert.equal(isTriggered(true, trigger, 1846.95, 1847.05), true)
  assert.equal(isTriggered(true, trigger, 1847.05, 1847.15), false)
})

// XAUUSD: point=0.01, slippage 20 points ⇒ tolerance $0.20 around the rung.
test('fillWithinTriggerBand: buy fill at/near the rung is allowed', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4109.50, ask: 4109.70, slippagePoints: 20, point: 0.01 }),
    { ok: true },
  )
})

test('fillWithinTriggerBand: buy fill BELOW the rung (better entry) is allowed', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4105.10, ask: 4105.30, slippagePoints: 20, point: 0.01 }),
    { ok: true },
  )
})

// Regression for the "layer fired at the top of a rally" bug: trigger crossed
// on a dip, but by send time ask rallied $2 above the rung — must NOT fire.
test('fillWithinTriggerBand: buy fill far above the rung is rejected', () => {
  const out = fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4111.60, ask: 4111.81, slippagePoints: 20, point: 0.01 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no_longer_triggered')
})

test('fillWithinTriggerBand: buy still triggered on bid but ask outside slippage band is rejected', () => {
  const out = fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4109.60, ask: 4110.40, slippagePoints: 20, point: 0.01 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'fill_outside_trigger_band')
})

test('fillWithinTriggerBand: sell fill below the rung beyond slippage is rejected', () => {
  const out = fillWithinTriggerBand({ isBuy: false, triggerPrice: 4120, bid: 4118.90, ask: 4120.05, slippagePoints: 20, point: 0.01 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'fill_outside_trigger_band')
})

test('fillWithinTriggerBand: sell fill at/above the rung is allowed', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: false, triggerPrice: 4120, bid: 4120.10, ask: 4120.30, slippagePoints: 20, point: 0.01 }),
    { ok: true },
  )
})

test('fillWithinTriggerBand: without symbol point only re-checks the trigger', () => {
  assert.deepEqual(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4109.60, ask: 4112.00, slippagePoints: 20, point: null }),
    { ok: true },
  )
  assert.equal(
    fillWithinTriggerBand({ isBuy: true, triggerPrice: 4109.63, bid: 4111.00, ask: 4111.20, slippagePoints: 20, point: null }).ok,
    false,
  )
})

test('layerLatencyPayload: calculates critical path durations', () => {
  const out = layerLatencyPayload({
    market_tick_received_at: 1000,
    layer_lookup_started_at: 900,
    layer_lookup_completed_at: 950,
    layer_cross_detected_at: 1015,
    layer_claim_started_at: 1020,
    layer_claim_acquired_at: 1032,
    broker_request_started_at: 1100,
    broker_response_received_at: 1230,
    pending_leg_updated_at: 1240,
    layer_reconciled_at: 1300,
  }, { leg_id: 'leg-1' })

  assert.equal(out.leg_id, 'leg-1')
  assert.equal(out.tick_to_cross_detection_ms, 15)
  assert.equal(out.layer_lookup_ms, 50)
  assert.equal(out.claim_ms, 12)
  assert.equal(out.cross_to_broker_request_ms, 85)
  assert.equal(out.broker_response_ms, 130)
  assert.equal(out.complete_layer_execution_ms, 300)
})

test('VirtualPendingMonitor.fireLeg: stale basket safety check runs before claim', async () => {
  const h = makeFireLegHarness()
  const result = await h.fireLeg(makeTestLeg(), 99.9, 100.05)

  assert.equal(result.outcome, 'fired')
  assert.ok(h.operations.includes('claim'))
  assert.ok(h.operations.includes('stale-check'))
  assert.ok(h.operations.indexOf('stale-check') < h.operations.indexOf('claim'))
  assert.ok(h.operations.lastIndexOf('stale-check') > h.operations.indexOf('claim'))
  assert.ok(h.operations.indexOf('sltp-refresh') < h.operations.lastIndexOf('stale-check'))
})

test('VirtualPendingMonitor.fireLeg: losing claimant short-circuits before broker work', async () => {
  const h = makeFireLegHarness({ claimedRow: null })
  const result = await h.fireLeg(makeTestLeg(), 99.9, 100.05)
  const active = new Map<string, Set<number>>([['signal-1|broker-1', new Set([1])]])
  const fired = new Map<string, Set<number>>()
  const outcome = h.recordFireLegResult(result, makeTestLeg(), active, fired)

  assert.equal(result.outcome, 'not_claimed')
  assert.equal(outcome, 'not_claimed')
  assert.ok(h.operations.includes('stale-check'))
  assert.ok(h.operations.includes('claim'))
  assert.ok(h.operations.indexOf('stale-check') < h.operations.indexOf('claim'))
  assert.equal(h.operations.includes('sltp-refresh'), false)
  assert.equal(h.operations.includes('broker-send'), false)
  assert.equal(h.brokerSends, 0)
  assert.deepEqual([...active.get('signal-1|broker-1') ?? []], [1])
  assert.equal(fired.has('signal-1|broker-1'), false)
})

test('VirtualPendingMonitor.fireLeg: slipped price releases claimed leg without broker dispatch', async () => {
  const h = makeFireLegHarness()
  const result = await h.fireLeg(makeTestLeg(), 99.9, 100.5)
  const active = new Map<string, Set<number>>([['signal-1|broker-1', new Set([1])]])
  const fired = new Map<string, Set<number>>()
  h.recordFireLegResult(result, makeTestLeg(), active, fired)

  assert.deepEqual(result, { outcome: 'skipped', reason: 'fill_outside_trigger_band' })
  assert.ok(h.operations.indexOf('claim') < h.operations.indexOf('release'))
  assert.deepEqual(h.supabase.releaseFilters, [{ id: 'leg-1', status: 'claimed' }])
  assert.equal(h.operations.includes('broker-send'), false)
  assert.equal(h.brokerSends, 0)
  assert.deepEqual([...active.get('signal-1|broker-1') ?? []], [1])
  assert.equal(fired.has('signal-1|broker-1'), false)
})

test('VirtualPendingMonitor.fireLeg: successful claimant re-checks flatness after claim and dispatches once', async () => {
  const h = makeFireLegHarness()
  const leg = makeTestLeg()
  const result = await h.fireLeg(leg, 99.9, 100.05)
  const active = new Map<string, Set<number>>([['signal-1|broker-1', new Set([1])]])
  const fired = new Map<string, Set<number>>()
  const outcome = h.recordFireLegResult(result, leg, active, fired)

  assert.equal(result.outcome, 'fired')
  assert.equal(outcome, 'fired')
  assert.ok(h.operations.indexOf('stale-check') < h.operations.indexOf('claim'))
  assert.ok(h.operations.lastIndexOf('stale-check') > h.operations.indexOf('claim'))
  assert.ok(h.operations.lastIndexOf('stale-check') < h.operations.indexOf('broker-send'))
  assert.equal(h.brokerSends, 1)
  assert.deepEqual([...active.get('signal-1|broker-1') ?? []], [])
  assert.deepEqual([...fired.get('signal-1|broker-1') ?? []], [1])
})

test('VirtualPendingMonitor.fireLeg: stale basket cleanup is skipped, not fired', async () => {
  const h = makeFireLegHarness({ staleReason: 'basket_flat' })
  const leg = makeTestLeg()
  const result = await h.fireLeg(leg, 99.9, 100.05)
  const active = new Map<string, Set<number>>([['signal-1|broker-1', new Set([1])]])
  const fired = new Map<string, Set<number>>()
  const outcome = h.recordFireLegResult(result, leg, active, fired)

  assert.deepEqual(result, { outcome: 'skipped', reason: 'basket_flat' })
  assert.equal(outcome, 'skipped')
  assert.ok(h.operations.includes('stale-check'))
  assert.equal(h.operations.includes('claim'), false)
  assert.ok(h.operations.indexOf('stale-check') < h.operations.indexOf('cleanup'))
  assert.equal(h.operations.includes('broker-send'), false)
  assert.equal(h.brokerSends, 0)
  assert.deepEqual([...active.get('signal-1|broker-1') ?? []], [1])
  assert.equal(fired.has('signal-1|broker-1'), false)
})

test('VirtualPendingMonitor.fireLeg: override SL 80 is from fill, not shared basket SL (buy)', async () => {
  const h = makeFireLegHarness({
    manual: { use_predefined_sl_pips: true, predefined_sl_pips: 80 },
    openPrice: 1990,
  })
  const result = await h.fireLeg(makeTestLeg({
    trigger_price: 1990,
    stoploss: 1992,
    takeprofit: 2100,
    anchor_price: 2000,
  }), 1989.9, 1990)
  assert.equal(result.outcome, 'fired')
  assert.equal(h.brokerSends, 1)
  assert.equal(h.sendArgs[0]?.stoploss, 1982)
  assert.ok((h.sendArgs[0]?.stoploss ?? 0) < 1990)
})

test('VirtualPendingMonitor.fireLeg: override SL 80 is from fill, not shared basket SL (sell)', async () => {
  const h = makeFireLegHarness({
    manual: { use_predefined_sl_pips: true, predefined_sl_pips: 80 },
    openPrice: 2010,
  })
  const result = await h.fireLeg(makeTestLeg({
    is_buy: false,
    trigger_price: 2010,
    stoploss: 2008,
    takeprofit: 1900,
    anchor_price: 2000,
  }), 2010, 2010.1)
  assert.equal(result.outcome, 'fired')
  assert.equal(h.brokerSends, 1)
  assert.equal(h.sendArgs[0]?.stoploss, 2018)
  assert.ok((h.sendArgs[0]?.stoploss ?? 0) > 2010)
})

test('VirtualPendingMonitor.fireLeg: override TP 30 is from fill, not shared basket TP (buy)', async () => {
  const h = makeFireLegHarness({
    manual: { use_predefined_tp_pips: true, predefined_tp_pips: [30] },
    openPrice: 2005,
  })
  const result = await h.fireLeg(makeTestLeg({
    trigger_price: 2005,
    stoploss: 1992,
    takeprofit: 2003,
    anchor_price: 2000,
  }), 2004.9, 2005)
  assert.equal(result.outcome, 'fired')
  assert.equal(h.brokerSends, 1)
  assert.equal(h.sendArgs[0]?.takeprofit, 2008)
  assert.ok((h.sendArgs[0]?.takeprofit ?? 0) > 2005)
})

test('VirtualPendingMonitor.fireLeg: override TP 30 is from fill, not shared basket TP (sell)', async () => {
  const h = makeFireLegHarness({
    manual: { use_predefined_tp_pips: true, predefined_tp_pips: [30] },
    openPrice: 1990,
  })
  const result = await h.fireLeg(makeTestLeg({
    is_buy: false,
    trigger_price: 1990,
    stoploss: 2008,
    takeprofit: 1997,
    anchor_price: 2000,
  }), 1990, 1990.1)
  assert.equal(result.outcome, 'fired')
  assert.equal(h.brokerSends, 1)
  assert.equal(h.sendArgs[0]?.takeprofit, 1987)
  assert.ok((h.sendArgs[0]?.takeprofit ?? 0) < 1990)
})

test('VirtualPendingMonitor.enqueueReconcileForLegBasket emits exactly one issue on enqueue failure', async () => {
  const mock = setupSentry()
  const monitor = new VirtualPendingMonitor({
    from(table: string) {
      if (table === 'trades') {
        return {
          select() { throw new Error('enqueue failed token=secret') },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never)

  await (monitor as unknown as {
    enqueueReconcileForLegBasket: (leg: TestLeg, channelId: string | null) => Promise<void>
  }).enqueueReconcileForLegBasket(makeTestLeg(), null)

  assert.equal(mock.capturedMessages.length, 1)
  assert.equal(mock.scopes[0]?.tags.event_name, 'deferred_trade_follow_up_failed')
  assert.equal(mock.scopes[0]?.tags.reason_code, 'BASKET_RECONCILE_ENQUEUE_FAILED')
})

test('evaluateTpTouch: buy basket locks at nearest TP touch', () => {
  const out = evaluateTpTouch({
    direction: 'buy',
    tps: [4510, 4530, 4550],
    bid: 4510,
    ask: 4510.2,
  })
  assert.equal(out.touched, true)
  assert.equal(out.triggerPrice, 4510)
  assert.equal(out.triggerSide, 'bid')
})

test('evaluateTpTouch: sell basket locks at nearest TP touch', () => {
  const out = evaluateTpTouch({
    direction: 'sell',
    tps: [4500, 4480, 4460],
    bid: 4500.2,
    ask: 4500,
  })
  assert.equal(out.touched, true)
  assert.equal(out.triggerPrice, 4500)
  assert.equal(out.triggerSide, 'ask')
})

test('evaluateTpTouch: ignores invalid TP direction/noise', () => {
  const out = evaluateTpTouch({
    direction: 'unknown',
    tps: [4500, 0, Number.NaN],
    bid: 4600,
    ask: 4600.5,
  })
  assert.equal(out.touched, false)
  assert.equal(out.triggerPrice, null)
  assert.equal(out.triggerSide, null)
})

test('shouldLockBasketLayering: live TP touch locks (sell)', () => {
  const out = shouldLockBasketLayering({
    direction: 'sell',
    openTps: [4089.8, 4087.1, 4074.5],
    openCount: 3,
    closedCount: 0,
    bid: 4090,
    ask: 4089.7,
  })
  assert.equal(out.lock, true)
  assert.equal(out.reason, 'tp_touched')
  assert.equal(out.triggerPrice, 4089.8)
})

test('shouldLockBasketLayering: partially closed basket locks even when quote is far from remaining TPs', () => {
  // TP1 trades closed at the broker; only deep-TP trades remain open and the
  // quote has reversed away — the open-only touch check can never fire.
  const out = shouldLockBasketLayering({
    direction: 'sell',
    openTps: [4074.5],
    openCount: 5,
    closedCount: 16,
    bid: 4094.5,
    ask: 4094.8,
  })
  assert.equal(out.lock, true)
  assert.equal(out.reason, 'basket_partially_closed')
  assert.equal(out.triggerPrice, null)
})

test('shouldLockBasketLayering: fully open basket with no touch stays unlocked', () => {
  const out = shouldLockBasketLayering({
    direction: 'buy',
    openTps: [4120, 4140],
    openCount: 4,
    closedCount: 0,
    bid: 4095,
    ask: 4095.3,
  })
  assert.equal(out.lock, false)
  assert.equal(out.reason, null)
})

test('shouldLockBasketLayering: flat basket with closed legs locks to stop refire', () => {
  const out = shouldLockBasketLayering({
    direction: 'sell',
    openTps: [],
    openCount: 0,
    closedCount: 12,
    bid: 4094.5,
    ask: 4094.8,
  })
  assert.equal(out.lock, true)
  assert.equal(out.reason, 'basket_fully_closed')
})

test('shouldLockBasketLayering: empty basket with no history stays unlocked', () => {
  const out = shouldLockBasketLayering({
    direction: 'sell',
    openTps: [],
    openCount: 0,
    closedCount: 0,
    bid: 4094.5,
    ask: 4094.8,
  })
  assert.equal(out.lock, false)
  assert.equal(out.reason, null)
})

test('VirtualPendingMonitor: auto path excludes broker_pending status', () => {
  assert.deepEqual(VirtualPendingMonitor.AUTO_LAYER_STATUSES, ['pending'])
  assert.ok(!VirtualPendingMonitor.AUTO_LAYER_STATUSES.includes('broker_pending' as never))
})

test('SELL retrace scenario: shallow rungs do not cross on pullback', () => {
  assert.equal(isAdverselyCrossed(false, 4089.5, 4090, 4090.1, 4089.5, 4089.6), false)
  assert.equal(isAdverselyCrossed(false, 4090.2, 4091, 4091.1, 4090.5, 4090.6), false)
  assert.equal(isAdverselyCrossed(false, 4090, 4089.8, 4089.9, 4090, 4090.1), true)
})

test('SELL catch-up: deeper rung eligible while holding after gap, not on retrace', () => {
  assert.equal(isOutwardCatchUp(false, 4089.6, 4092, 4092.1, 4092, 4092.1), true)
  assert.equal(isOutwardCatchUp(false, 4089.6, 4092, 4092.1, 4089.5, 4089.6), false)
})

test('isBlockedByShallowerStep: blocks deeper rung when shallower still pending', () => {
  const active = new Map<string, Set<number>>([['sig|broker', new Set([1])]])
  assert.equal(
    isBlockedByShallowerStep({ signal_id: 'sig', broker_account_id: 'broker', step_idx: 2 }, active),
    true,
  )
  assert.equal(
    isBlockedByShallowerStep({ signal_id: 'sig', broker_account_id: 'broker', step_idx: 1 }, active),
    false,
  )
})

test('layer tick: slow market high budget fires only crossed triggers', () => {
  const pending = [1, 2, 3, 4, 5, 6].map(step_idx => ({
    id: `leg-${step_idx}`,
    step_idx,
    anchor_price: 4080,
    trigger_price: 4080 - step_idx * 0.03,
    is_buy: true,
  }))
  const selected = selectLegsForLayerTick({
    pendingLegs: pending,
    isBuy: true,
    anchor: 4080,
    bid: 4079.97,
    ask: 4079.99,
    stepPriceOffset: 0.03,
    highestFiredStepIdx: 0,
  })
  assert.deepEqual(selected.map(l => l.step_idx), [1])
})

test('layer tick: catch-up burst capped at 3 when multiple triggers crossed', () => {
  const pending = [1, 2, 3, 4, 5, 6].map(step_idx => ({
    id: `leg-${step_idx}`,
    step_idx,
    anchor_price: 4080,
    trigger_price: 4080 - step_idx * 0.03,
    is_buy: true,
  }))
  const selected = selectLegsForLayerTick({
    pendingLegs: pending,
    isBuy: true,
    anchor: 4080,
    bid: 4079.82,
    ask: 4079.84,
    stepPriceOffset: 0.03,
    highestFiredStepIdx: 0,
    maxFiresPerTick: 3,
  })
  assert.deepEqual(selected.map(l => l.step_idx), [1, 2, 3])
})

test('legacy distance burst: 3-pip step at -6 pips selects steps 1-2 from all pending', () => {
  const pending = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(step_idx => ({
    id: `leg-${step_idx}`,
    step_idx,
    anchor_price: 4080,
    trigger_price: 4080 - step_idx * 0.03,
    is_buy: true,
  }))
  const budget = computeLayerFireBudget({
    isBuy: true,
    anchor: 4080,
    bid: 4079.94,
    ask: 4079.96,
    stepPriceOffset: 0.03,
  })
  assert.equal(budget, 2)
  const selected = selectPendingLegsForDistanceBurst({ pendingLegs: pending, budget })
  assert.deepEqual(selected.map(l => l.step_idx), [1, 2])
})

test('distance burst: -9 pips total selects step 3 only when steps 1-2 already fired', () => {
  const pending = [3, 4, 5, 6].map(step_idx => ({
    id: `leg-${step_idx}`,
    step_idx,
    anchor_price: 4080,
    trigger_price: 4080 - step_idx * 0.03,
    is_buy: true,
  }))
  const budget = computeLayerFireBudget({
    isBuy: true,
    anchor: 4080,
    bid: 4079.91,
    ask: 4079.93,
    stepPriceOffset: 0.03,
  })
  assert.equal(budget, 3)
  const selected = selectPendingLegsForDistanceBurst({ pendingLegs: pending, budget })
  assert.deepEqual(selected.map(l => l.step_idx), [3])
})

test('distance burst: -18 pips selects steps 4-6 when 1-3 already fired', () => {
  const pending = [4, 5, 6, 7].map(step_idx => ({
    id: `leg-${step_idx}`,
    step_idx,
    anchor_price: 4080,
    trigger_price: 4080 - step_idx * 0.03,
    is_buy: true,
  }))
  const budget = computeLayerFireBudget({
    isBuy: true,
    anchor: 4080,
    bid: 4079.82,
    ask: 4079.84,
    stepPriceOffset: 0.03,
  })
  assert.equal(budget, 6)
  assert.deepEqual(newLayersForTick(budget, 3), [4, 5, 6])
  const selected = selectPendingLegsForDistanceBurst({ pendingLegs: pending, budget })
  assert.deepEqual(selected.map(l => l.step_idx), [4, 5, 6])
})

test('legacy distance burst: eligibility does not require trigger cross', () => {
  assert.equal(isLegEligibleByDistance(true, 4080, 4079.94, 4079.96, 2, 0.03), true)
  assert.equal(isLegEligibleByDistance(true, 4080, 4079.97, 4079.99, 2, 0.03), false)
})

test('distance burst: sell side selects multiple rungs when price gaps up', () => {
  const pending = [1, 2, 3].map(step_idx => ({
    id: `leg-${step_idx}`,
    step_idx,
    anchor_price: 4080,
    trigger_price: 4080 + step_idx * 0.02,
    is_buy: false,
  }))
  const budget = computeLayerFireBudget({
    isBuy: false,
    anchor: 4080,
    bid: 4080.04,
    ask: 4080.06,
    stepPriceOffset: 0.02,
  })
  assert.equal(budget, 3)
  const selected = selectPendingLegsForDistanceBurst({ pendingLegs: pending, budget })
  assert.deepEqual(selected.map(l => l.step_idx), [1, 2, 3])
})
