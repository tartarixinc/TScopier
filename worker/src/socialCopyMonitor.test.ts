import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrokerProvider } from './brokerProvider'
import { constrainedCopyVolume, normalizeSourcePosition, SocialCopyMonitor, type SocialCopySubscriptionRow } from './socialCopyMonitor'

const subscription = (patch: Partial<SocialCopySubscriptionRow> = {}): SocialCopySubscriptionRow => ({
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  source_id: 'source-1',
  destination_broker_account_id: 'dst',
  sizing_mode: 'fixed_lot', fixed_lot: 0.12, lot_multiplier: 1, max_lot: 0.2,
  max_daily_loss: null, requested_account_mode: 'demo',
  source_account_mode: 'demo', destination_account_mode: 'demo', execution_path: 'broker', symbol_map: {},
  status: 'pending', desired_status: 'active', error_code: null, ...patch,
})

type Row = Record<string, unknown>

class Query implements PromiseLike<{ data: unknown; error: Row | null }> {
  private filters: Array<(row: Row) => boolean> = []
  private mutation: 'insert' | 'update' | null = null
  private payload: Row = {}
  private wantsSingle = false
  private selectedColumns = '*'
  constructor(private db: FakeDb, private table: string) {}
  select(columns = '*'): this {
    this.selectedColumns = columns
    if (this.table === 'broker_accounts') this.db.brokerAccountSelections.push(columns)
    return this
  }
  order(): this { return this }
  eq(key: string, value: unknown): this { this.filters.push(row => row[key] === value); return this }
  in(key: string, values: unknown[]): this { this.filters.push(row => values.includes(row[key])); return this }
  single(): this { this.wantsSingle = true; return this }
  insert(payload: Row): this { this.mutation = 'insert'; this.payload = payload; return this }
  update(payload: Row): this { this.mutation = 'update'; this.payload = payload; return this }
  then<TResult1 = { data: unknown; error: Row | null }, TResult2 = never>(resolve?: ((value: { data: unknown; error: Row | null }) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(resolve, reject)
  }
  private execute(): { data: unknown; error: Row | null } {
    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = [])
    const matches = rows.filter(row => this.filters.every(filter => filter(row)))
    if (this.mutation === 'update') {
      for (const row of matches) Object.assign(row, this.payload)
      return { data: matches, error: null }
    }
    if (this.mutation === 'insert') {
      if (this.table === 'social_copy_execution_events' && rows.some(row => row.subscription_id === this.payload.subscription_id && row.idempotency_key === this.payload.idempotency_key)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      }
      if (this.table === 'social_copy_trade_mappings' && rows.some(row => row.subscription_id === this.payload.subscription_id && row.source_ticket === this.payload.source_ticket)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      }
      const row = { id: `${this.table}-${rows.length + 1}`, ...this.payload }
      rows.push(row)
      return { data: this.wantsSingle ? row : [row], error: null }
    }
    if (this.mutation === null && this.table === 'broker_accounts' && this.db.missingBrokerColumn
      && this.selectedColumns.split(',').some(column => column.trim() === this.db.missingBrokerColumn)) {
      const column = this.db.missingBrokerColumn
      return { data: null, error: { message: `column broker_accounts.${column} does not exist` } }
    }
    const data = this.wantsSingle ? (matches[0] ?? null) : matches
    return { data, error: this.wantsSingle && !data ? { message: 'not found' } : null }
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {
    social_copy_sources: [{ id: 'source-1', broker_account_id: 'src', status: 'published' }],
    broker_accounts: [broker('src'), broker('dst')],
    social_copy_trade_mappings: [], social_copy_execution_events: [], social_copy_subscriptions: [],
  }
  /** Test hook: while set, the first broker_accounts select fails as if the
   * database predates that provider column (see `missingProviderIdColumn`). */
  missingBrokerColumn: string | null = null
  brokerAccountSelections: string[] = []
  claimed: SocialCopySubscriptionRow[] = []
  rpc = async (name: string): Promise<{ data: unknown; error: null }> => ({ data: name === 'claim_social_copy_subscriptions' ? this.claimed : name === 'check_social_copy_subscription_authorization' ? true : null, error: null })
  from = (table: string): Query => new Query(this, table)
}

function broker(id: string): Row {
  return {
    id, user_id: `${id}-user`, provider: 'fxsocket', platform: 'MT5', is_active: true,
    connection_status: 'connected', linked_account_type: 'Demo', fxsocket_account_id: `${id}-session`,
    metaapi_account_id: null, mtapi_session_id: null, ctrader_account_id: null,
    writer_epoch: 1, provider_transition_state: 'stable',
  }
}

function provider(options: { orders?: unknown[]; ready?: boolean; sendError?: Error; symbolError?: Error; destinationOrders?: unknown[] } = {}): BrokerProvider & { sends: number; closes: number; modifies: number; lastCloseLots: number | undefined } {
  let calls = 0
  return {
    name: 'fxsocket', sends: 0, closes: 0, modifies: 0, lastCloseLots: undefined,
    seedPlatformCache() {}, async getV1Account() { return {} as never }, async connectEx() { return '' }, async connectByToken() {}, async ensureConnected() {}, async checkConnect() {}, async disconnect() {}, async keepSessionAlive() { return true }, async keepSessionAliveDetailed() { return {} as never },
    async verifyTradingReady() { return options.ready ?? true },
    async orderSend() { this.sends++; if (options.sendError) throw options.sendError; return { ticket: 9001 } },
    async orderModify() { this.modifies++; return { ticket: 9001 } }, async orderClose(_id, args) { this.closes++; this.lastCloseLots = args.lots; return { ticket: 9001 } },
    async openedOrders() { calls++; return calls === 1 ? (options.orders ?? []) : (options.destinationOrders ?? options.orders ?? []) },
    async closedOrders() { return [] }, async orderHistory() { return [] }, async historyPositions() { return [] },
    async orderHistoryPage() { return { orders: [], pagesCount: 0 } }, async closedOrdersHistory() { return [] }, async closedOrdersHistoryLite() { return [] },
    async accountSummary() { return { equity: 1000 } }, async quote() { return { symbol: 'EURUSD', bid: 1, ask: 1.1 } },
    async symbolParams() { if (options.symbolError) throw options.symbolError; return { groupParams: { minLot: 0.01, maxLot: 10, lotStep: 0.01 } } }, async symbols() { return [] },
    async mtStatus() { return {} }, async terminalStatus() { return {} },
  }
}

const sourcePosition = { ticket: 42, symbol: 'EURUSD', operation: 'Buy', lots: 0.3, stopLoss: 1.05, takeProfit: 1.2 }

test('normalizes only supported market positions and constrains volume to broker steps', () => {
  assert.deepEqual(normalizeSourcePosition(sourcePosition), { ticket: '42', symbol: 'EURUSD', side: 'buy', volume: 0.3, stopLoss: 1.05, takeProfit: 1.2 })
  assert.equal(normalizeSourcePosition({ ...sourcePosition, operation: 'BuyLimit' }), null)
  assert.equal(constrainedCopyVolume(0.127, { min: 0.01, max: 1, step: 0.01 }, 0.2), 0.12)
  assert.equal(constrainedCopyVolume(0.001, { min: 0.01, max: 1, step: 0.01 }, 0.2), null)
})

test('source disconnection fails closed with an actionable persisted error', async () => {
  const db = new FakeDb(); const sub = subscription(); db.claimed = [sub]; db.tables.social_copy_subscriptions = [{ ...sub }]
  const unavailable = provider({ ready: false })
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: () => unavailable })
  await monitor.tick()
  const state = db.tables.social_copy_subscriptions[0]
  assert.equal(state?.status, 'error')
  assert.equal(state?.error_code, 'BROKER_DISCONNECTED')
  assert.equal(unavailable.sends, 0)
})

test('unsupported destination symbols fail before any broker write', async () => {
  const db = new FakeDb(); const sub = subscription(); db.claimed = [sub]; db.tables.social_copy_subscriptions = [{ ...sub }]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ symbolError: new Error('symbol EURUSD is unavailable') })
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: row => String((row as Row).id) === 'src' ? source : destination })
  await monitor.tick()
  assert.equal(destination.sends, 0)
  assert.equal(db.tables.social_copy_subscriptions[0]?.status, 'error')
  assert.equal(db.tables.social_copy_subscriptions[0]?.error_code, 'UNSUPPORTED_SYMBOL')
})

test('destination failure is uncertain, never retried as a duplicate', async () => {
  const db = new FakeDb(); const sub = subscription(); db.claimed = [sub]; db.tables.social_copy_subscriptions = [{ ...sub }]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ sendError: new Error('temporary broker failure') })
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: row => String((row as Row).id) === 'src' ? source : destination })
  await monitor.tick()
  assert.equal(destination.sends, 1)
  assert.equal(db.tables.social_copy_trade_mappings[0]?.state, 'uncertain')
  assert.equal(db.tables.social_copy_execution_events[0]?.status, 'uncertain')
  await monitor.tick()
  assert.equal(destination.sends, 1, 'restart/retry must not duplicate an uncertain open')
})

test('restart recovers an acknowledged broker order from its deterministic comment', async () => {
  const db = new FakeDb(); const sub = subscription({ status: 'active' }); db.claimed = [sub]; db.tables.social_copy_subscriptions = [{ ...sub }]
  const comment = `sc:${sub.id.slice(0, 8)}:42`
  db.tables.social_copy_trade_mappings = [{ id: 'map-1', subscription_id: sub.id, source_ticket: '42', destination_ticket: null, source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy', source_volume: 0.3, destination_volume: 0.12, source_stop_loss: 1.05, source_take_profit: 1.2, state: 'opening', broker_comment: comment }]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12, comment }] })
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: row => String((row as Row).id) === 'src' ? source : destination })
  await monitor.tick()
  assert.equal(destination.sends, 0)
  assert.equal(db.tables.social_copy_trade_mappings[0]?.destination_ticket, '9001')
  assert.equal(db.tables.social_copy_trade_mappings[0]?.state, 'open')
})

test('source partial close and stop changes propagate to the mapped destination', async () => {
  const db = new FakeDb(); const sub = subscription({ status: 'active' }); db.claimed = [sub]; db.tables.social_copy_subscriptions = [{ ...sub }]
  db.tables.social_copy_trade_mappings = [{ id: 'map-1', subscription_id: sub.id, source_ticket: '42', destination_ticket: '9001', source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy', source_volume: 0.3, destination_volume: 0.12, source_stop_loss: 1.0, source_take_profit: 1.2, state: 'open', broker_comment: 'copy' }]
  const source = provider({ orders: [{ ...sourcePosition, lots: 0.15, stopLoss: 1.08 }] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: row => String((row as Row).id) === 'src' ? source : destination })
  await monitor.tick()
  assert.equal(destination.closes, 1)
  assert.equal(destination.lastCloseLots, 0.06)
  assert.equal(destination.modifies, 1)
  assert.equal(db.tables.social_copy_trade_mappings[0]?.source_volume, 0.15)
  assert.equal(db.tables.social_copy_trade_mappings[0]?.destination_volume, 0.06)
  assert.equal(db.tables.social_copy_trade_mappings[0]?.source_stop_loss, 1.08)
})

  const db = new FakeDb(); const paused = subscription({ desired_status: 'paused' }); db.claimed = [paused]; db.tables.social_copy_subscriptions = [{ ...paused }]
test('pause is acknowledged without broker writes and stop closes mapped positions', async () => {
  const api = provider()
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: () => api })
  await monitor.tick()
  assert.equal(db.tables.social_copy_subscriptions[0]?.status, 'paused')
  assert.equal(api.sends, 0)

  const stopped = subscription({ desired_status: 'stopped' }); db.claimed = [stopped]; Object.assign(db.tables.social_copy_subscriptions[0]!, stopped)
  db.tables.social_copy_trade_mappings = [{ id: 'map-1', subscription_id: stopped.id, source_ticket: '42', destination_ticket: '9001', source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy', source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null, state: 'open', broker_comment: 'copy' }]
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  const stopping = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: () => destination })
  await stopping.tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.tables.social_copy_subscriptions[0]?.status, 'stopped')
})

test('a database without later provider columns retries with the legacy column set', async () => {
  const db = new FakeDb()
  db.missingBrokerColumn = 'matchtrader_account_id'
  const sub = subscription({ status: 'active' })
  db.claimed = [sub]
  db.tables.social_copy_subscriptions = [{ ...sub }]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider()
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, providerFor: row => String((row as Row).id) === 'src' ? source : destination })
  await monitor.tick()
  assert.ok(db.brokerAccountSelections.some(columns => columns.includes('matchtrader_account_id')))
  assert.ok(db.brokerAccountSelections.some(columns => !columns.includes('matchtrader_account_id')))
  assert.equal(destination.sends, 1, 'the fallback read must keep the subscription working')
  assert.equal(db.tables.social_copy_trade_mappings[0]?.state, 'open')
})


test('synthetic subscriptions are persisted and acknowledged without resolving or writing to a broker', async () => {
  const db = new FakeDb()
  const sub = subscription({ execution_path: 'synthetic_simulation' })
  db.claimed = [sub]
  db.tables.social_copy_subscriptions = [{ ...sub }]
  let providerCalls = 0
  const monitor = new SocialCopyMonitor(db as never, {
    executionEnabled: true,
    syntheticSimulationEnabled: true,
    providerFor: () => { providerCalls++; return provider() },
  })
  await monitor.tick()
  assert.equal(providerCalls, 0)
  assert.equal(db.tables.social_copy_subscriptions[0]?.status, 'active')
  assert.equal(db.tables.social_copy_execution_events[0]?.action, 'simulation')
  assert.deepEqual(db.tables.social_copy_execution_events[0]?.result_payload, {
    simulated: true,
    broker_orders_created: 0,
  })
})

test('supports every verified Demo and Live source/destination mode combination when live execution is enabled', async () => {
  const combinations = [
    ['demo', 'demo'],
    ['demo', 'live'],
    ['live', 'demo'],
    ['live', 'live'],
  ] as const
  for (const [sourceMode, destinationMode] of combinations) {
    const db = new FakeDb()
    db.tables.broker_accounts = [
      broker('src'),
      broker('dst'),
    ]
    db.tables.broker_accounts[0]!.linked_account_type = sourceMode
    db.tables.broker_accounts[1]!.linked_account_type = destinationMode
    const sub = subscription({
      requested_account_mode: destinationMode,
      source_account_mode: sourceMode,
      destination_account_mode: destinationMode,
    })
    db.claimed = [sub]
    db.tables.social_copy_subscriptions = [{ ...sub }]
    const source = provider()
    const destination = provider()
    const monitor = new SocialCopyMonitor(db as never, {
      executionEnabled: true,
      allowLive: true,
      providerFor: row => String((row as Row).id) === 'src' ? source : destination,
    })
    await monitor.tick()
    assert.equal(db.tables.social_copy_subscriptions[0]?.status, 'active', `${sourceMode}-to-${destinationMode}`)
    assert.equal(source.sends + destination.sends, 0)
  }
})

test('live-involved broker execution fails observably when SOCIAL_COPY_ALLOW_LIVE is disabled', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts[0]!.linked_account_type = 'live'
  const sub = subscription({ source_account_mode: 'live' })
  db.claimed = [sub]
  db.tables.social_copy_subscriptions = [{ ...sub }]
  const api = provider()
  const monitor = new SocialCopyMonitor(db as never, { executionEnabled: true, allowLive: false, providerFor: () => api })
  await monitor.tick()
  assert.equal(db.tables.social_copy_subscriptions[0]?.status, 'error')
  assert.equal(db.tables.social_copy_subscriptions[0]?.error_code, 'LIVE_EXECUTION_DISABLED')
  assert.equal(api.sends, 0)
})
