import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrokerProvider } from '../brokerProvider'
import { MirrorCopyMonitor } from './mirrorCopyMonitor'

type Row = Record<string, unknown>

const LINK_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'

/** The shape the mirror UI writes into broker_copy_links.manual_settings. */
function settings(overrides: Record<string, unknown> = {}): Row {
  return {
    symbol_mapping: {},
    copy_risk: {
      sizing: { mode: 'fixed_lot', fixed_lot: 0.12, lot_multiplier: 1, max_lot: 0.2 },
      stops: { copy_source_sl: true, copy_source_tp: true },
      filters: { direction: 'both' },
    },
    ...overrides,
  }
}

class Query implements PromiseLike<{ data: unknown; error: Row | null }> {
  private filters: Array<(row: Row) => boolean> = []
  private mutation: 'insert' | 'update' | null = null
  private payload: Row = {}
  private wantsSingle = false
  constructor(private db: FakeDb, private table: string) {}
  select(): this { return this }
  order(): this { return this }
  eq(key: string, value: unknown): this { this.filters.push(row => row[key] === value); return this }
  neq(key: string, value: unknown): this { this.filters.push(row => row[key] !== value); return this }
  in(key: string, values: unknown[]): this { this.filters.push(row => values.includes(row[key])); return this }
  single(): this { this.wantsSingle = true; return this }
  insert(payload: Row): this { this.mutation = 'insert'; this.payload = payload; return this }
  update(payload: Row): this { this.mutation = 'update'; this.payload = payload; return this }
  then<TResult1 = { data: unknown; error: Row | null }, TResult2 = never>(
    resolve?: ((value: { data: unknown; error: Row | null }) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
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
      if (this.table === 'mirror_copy_execution_events' && rows.some(row => row.link_id === this.payload.link_id && row.idempotency_key === this.payload.idempotency_key)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      }
      if (this.table === 'mirror_copy_trade_mappings' && rows.some(row => row.link_id === this.payload.link_id && row.source_ticket === this.payload.source_ticket)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } }
      }
      if (this.table === 'mirror_copy_execution_events') {
        const now = new Date().toISOString()
        this.payload = { status: 'claimed', attempt_count: 1, completed_at: null, created_at: now, updated_at: now, ...this.payload }
      }
      const row = { id: `${this.table}-${rows.length + 1}`, ...this.payload }
      rows.push(row)
      return { data: this.wantsSingle ? row : [row], error: null }
    }
    const data = this.wantsSingle ? (matches[0] ? { ...matches[0] } : null) : matches.map(row => ({ ...row }))
    if (this.mutation === null && this.table === 'mirror_copy_trade_mappings') this.db.onTableRead?.(this.table)
    return { data, error: this.wantsSingle && !data ? { message: 'not found' } : null }
  }
}

class FakeDb {
  /** Test hook: fired after the worker reads mirror_copy_trade_mappings (select only). */
  onTableRead?: (table: string) => void
  tables: Record<string, Row[]> = {
    broker_accounts: [broker('src'), broker('dst')],
    broker_copy_links: [{
      id: LINK_ID, user_id: 'user-1', source_broker_account_id: 'src',
      destination_broker_account_id: 'dst', manual_settings: settings(),
    }],
    mirror_copy_link_state: [{
      link_id: LINK_ID, desired_status: 'active', status: 'pending', error_code: null,
    }],
    mirror_copy_master_state: [{ broker_account_id: 'src', status: 'pending', lease_owner: 'test-worker' }],
    mirror_copy_trade_mappings: [],
    mirror_copy_execution_events: [],
  }
  claimed: Row[] = [{ broker_account_id: 'src', status: 'pending' }]
  rpc = async (name: string): Promise<{ data: unknown; error: null }> => ({
    data: name === 'claim_mirror_copy_masters' ? this.claimed : null, error: null,
  })
  from = (table: string): Query => new Query(this, table)
  linkState(): Row { return this.tables.mirror_copy_link_state[0]! }
}

function broker(id: string, patch: Row = {}): Row {
  return {
    id, user_id: 'user-1', provider: 'fxsocket', platform: 'MT5', is_active: true,
    connection_status: 'connected', linked_account_type: 'Demo', fxsocket_account_id: `${id}-session`,
    metaapi_account_id: null, mtapi_session_id: null, ctrader_account_id: null,
    writer_epoch: 1, provider_transition_state: 'stable', margin_mode: 'hedging', ...patch,
  }
}

function provider(options: {
  orders?: unknown[]
  destinationOrders?: unknown[]
  closedOrdersHistory?: unknown[]
  historyPositions?: unknown[]
  ready?: boolean
  sendError?: Error
  sendErrorAt?: number
  closeErrorAt?: number
  symbolError?: Error
  symbols?: unknown[]
  symbolsError?: Error
} = {}): BrokerProvider & { sends: number; closes: number; modifies: number; lastCloseLots: number | undefined } {
  let calls = 0
  return {
    name: 'fxsocket', sends: 0, closes: 0, modifies: 0, lastCloseLots: undefined,
    seedPlatformCache() {}, async getV1Account() { return {} as never }, async connectEx() { return '' },
    async connectByToken() {}, async ensureConnected() {}, async checkConnect() {}, async disconnect() {},
    async keepSessionAlive() { return true }, async keepSessionAliveDetailed() { return {} as never },
    async verifyTradingReady() { return options.ready ?? true },
    async orderSend() {
      this.sends++
      if (options.sendError) throw options.sendError
      if (options.sendErrorAt && this.sends === options.sendErrorAt) throw new Error('temporary broker failure')
      return { ticket: 9001 }
    },
    async orderModify() { this.modifies++; return { ticket: 9001 } },
    async orderClose(_id, args) {
      this.closes++
      this.lastCloseLots = args.lots
      if (options.closeErrorAt && this.closes === options.closeErrorAt) throw new Error('temporary close failure')
      return { ticket: 9001 }
    },
    async openedOrders() { calls++; return calls === 1 ? (options.orders ?? []) : (options.destinationOrders ?? options.orders ?? []) },
    async closedOrders() { return [] }, async orderHistory() { return [] },
    async historyPositions() { return options.historyPositions ?? [] }, async orderHistoryPage() { return { orders: [], pagesCount: 0 } },
    async closedOrdersHistory() { return options.closedOrdersHistory ?? [] }, async closedOrdersHistoryLite() { return options.closedOrdersHistory ?? [] },
    async accountSummary() { return { equity: 1000 } }, async quote() { return { symbol: 'EURUSD', bid: 1, ask: 1.1 } },
    async symbolParams() { if (options.symbolError) throw options.symbolError; return { groupParams: { minLot: 0.01, maxLot: 10, lotStep: 0.01 } } },
    async symbols() { if (options.symbolsError) throw options.symbolsError; return options.symbols ?? [] }, async mtStatus() { return {} }, async terminalStatus() { return {} },
  }
}

const sourcePosition = { ticket: 42, symbol: 'EURUSD', operation: 'Buy', lots: 0.3, stopLoss: 1.05, takeProfit: 1.2 }

function monitor(db: FakeDb, source: BrokerProvider, destination: BrokerProvider, patch: Record<string, unknown> = {}): MirrorCopyMonitor {
  return new MirrorCopyMonitor(db as never, {
    executionEnabled: true,
    workerId: 'test-worker',
    providerFor: row => (row as Row).id === 'src' ? source : destination,
    ...patch,
  })
}

test('a netting or unknown destination account fails closed before any broker write', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts = [broker('src'), broker('dst', { margin_mode: 'netting' })]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider()
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 0)
  assert.equal(source.sends, 0)
  assert.equal(db.linkState().status, 'unsupported_provider')
  assert.equal(db.linkState().error_code, 'ACCOUNT_MODE_UNSUPPORTED')
})

test('execution disabled records intent and touches no broker', async () => {
  const db = new FakeDb()
  const source = provider({ orders: [sourcePosition] })
  const destination = provider()
  const instance = monitor(db, source, destination, { executionEnabled: false })
  await instance.tick()
  assert.equal(destination.sends, 0)
  assert.equal(db.linkState().status, 'error')
  assert.equal(db.linkState().error_code, 'EXECUTION_DISABLED')
})

test('opens one copy per source position with a deterministic comment', async () => {
  const db = new FakeDb()
  const source = provider({ orders: [sourcePosition] })
  const destination = provider()
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 1)
  const mapping = db.tables.mirror_copy_trade_mappings[0]!
  assert.equal(mapping.state, 'open')
  assert.equal(mapping.destination_ticket, '9001')
  assert.equal(mapping.destination_volume, 0.12)
  assert.equal(mapping.broker_comment, `mc:${LINK_ID.slice(0, 8)}:42`)
  assert.equal(db.linkState().status, 'active')
})

test('an uncertain open is never retried as a duplicate', async () => {
  const db = new FakeDb()
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ sendError: new Error('temporary broker failure') })
  const instance = monitor(db, source, destination)
  await instance.tick()
  assert.equal(destination.sends, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'uncertain')
  await instance.tick()
  assert.equal(destination.sends, 1, 'restart/retry must not duplicate an uncertain open')
})

test('restart recovers an acknowledged order from its deterministic comment', async () => {
  const db = new FakeDb()
  const comment = `mc:${LINK_ID.slice(0, 8)}:42`
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: null,
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: 1.05, source_take_profit: 1.2,
    state: 'opening', broker_comment: comment,
  }]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12, comment }] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 0)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.destination_ticket, '9001')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'open')
})

test('source partial close and stop changes propagate to the mapped destination', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: 1.0, source_take_profit: 1.2,
    state: 'open', broker_comment: 'mc',
  }]
  const source = provider({ orders: [{ ...sourcePosition, lots: 0.15, stopLoss: 1.08 }] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(destination.lastCloseLots, 0.06)
  assert.equal(destination.modifies, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.source_volume, 0.15)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.destination_volume, 0.06)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.source_stop_loss, 1.08)
})

test('pause is acknowledged without broker writes and stop closes mapped positions', async () => {
  const db = new FakeDb()
  const api = provider()
  const instance = monitor(db, api, api)
  Object.assign(db.linkState(), { desired_status: 'paused' })
  await instance.tick()
  assert.equal(db.linkState().status, 'paused')
  assert.equal(api.sends, 0)
  assert.equal(api.closes, 0)

  const dest = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  const stopping = monitor(db, provider(), dest)
  Object.assign(db.linkState(), { desired_status: 'stopped' })
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'open', broker_comment: 'mc',
  }]
  await stopping.tick()
  assert.equal(dest.closes, 1)
  assert.equal(db.linkState().status, 'stopped')
})

test('a source ticket missing from open orders closes its copy only when history confirms it', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'open', broker_comment: 'mc',
  }]
  const source = provider({ orders: [], closedOrdersHistory: [{ ticket: 900, order: 0, entry: 'Out', position: 42, closePrice: 1.1, profit: 5 }] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
})

test('an inconclusive history read leaves the copy open and records the unresolved source', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'open', broker_comment: 'mc',
  }]
  const source = provider({ orders: [] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 0, 'must not drop a possibly-live source ticket')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'open')
  const event = db.tables.mirror_copy_execution_events.find(row => row.action === 'reconcile')
  assert.equal(event?.status, 'skipped')
  assert.equal(event?.error_code, 'SOURCE_TICKET_UNRESOLVED')
})

test('a link whose brokers belong to another user fails closed before any broker write', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts = [broker('src'), broker('dst', { user_id: 'someone-else' })]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider()
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 0)
  assert.equal(source.sends, 0)
  assert.equal(db.linkState().status, 'error')
  assert.equal(db.linkState().error_code, 'OWNER_MISMATCH')
})

test('an opening mapping with no ticket and no matching order is abandoned, not retried', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: null,
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'opening', broker_comment: `mc:${LINK_ID.slice(0, 8)}:42`,
  }]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ orders: [] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 0)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'error')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.last_error_code, 'OPEN_ABANDONED')
})

test('a stop request while execution is disabled touches no broker', async () => {
  const db = new FakeDb()
  Object.assign(db.linkState(), { desired_status: 'stopped' })
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'open', broker_comment: 'mc',
  }]
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  await monitor(db, provider(), destination, { executionEnabled: false }).tick()
  assert.equal(destination.closes, 0)
  assert.equal(db.linkState().status, 'error')
  assert.equal(db.linkState().error_code, 'EXECUTION_DISABLED')
})

test('one failing position does not stop the others and is surfaced as a partial reconcile', async () => {
  const db = new FakeDb()
  const source = provider({ orders: [sourcePosition, { ...sourcePosition, ticket: 43 }] })
  const destination = provider({ orders: [], sendErrorAt: 2 })
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 2)
  const states = db.tables.mirror_copy_trade_mappings.map(row => row.state)
  assert.deepEqual(states, ['open', 'uncertain'])
  assert.equal(db.linkState().status, 'error')
  assert.equal(db.linkState().error_code, 'RECONCILE_PARTIAL')
})

test('a transient close failure is retried instead of wedging the copy open', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'open', broker_comment: 'mc',
  }]
  const source = provider({ orders: [], closedOrdersHistory: [{ ticket: 900, order: 0, entry: 'Out', position: 42, closePrice: 1.1, profit: 5 }] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }], closeErrorAt: 1 })
  const instance = monitor(db, source, destination, { uncertainRetryMs: 0 })
  await instance.tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'open', 'a failed close must not mark the copy closed')
  await instance.tick()
  assert.equal(destination.closes, 2, 'the uncertain close must be retried on a later tick')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
})

test('a resize that already reached its target is not closed a second time', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: 1.05, source_take_profit: 1.2,
    state: 'open', broker_comment: 'mc',
  }]
  const source = provider({ orders: [{ ...sourcePosition, lots: 0.15 }] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.06 }] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 0, 'the destination already holds the target volume')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.source_volume, 0.15)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.destination_volume, 0.06)
})

test('a close event left claimed by a crashed worker is reclaimed once stale', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'open', broker_comment: 'mc',
  }]
  db.tables.mirror_copy_execution_events = [{
    id: 'evt-1', link_id: LINK_ID, mapping_id: 'map-1', source_ticket: '42', action: 'close',
    idempotency_key: 'close:42', status: 'claimed', attempt_count: 1,
    updated_at: new Date(Date.now() - 10 * 60_000).toISOString(), completed_at: null,
  }]
  const source = provider({ orders: [], closedOrdersHistory: [{ ticket: 900, order: 0, entry: 'Out', position: 42, closePrice: 1.1, profit: 5 }] })
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.tables.mirror_copy_execution_events[0]?.status, 'succeeded')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
})

test('an MT4 destination is treated as hedging even when margin_mode is unknown', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts = [broker('src'), broker('dst', { platform: 'MT4', margin_mode: 'unknown' })]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider()
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 1)
  assert.equal(db.linkState().status, 'active')
})

test('a stop still flattens copies on a netting destination', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts = [broker('src'), broker('dst', { margin_mode: 'netting' })]
  Object.assign(db.linkState(), { desired_status: 'stopped', status: 'active' })
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: null, source_take_profit: null,
    state: 'open', broker_comment: 'mc',
  }]
  const destination = provider({ orders: [{ ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }] })
  await monitor(db, provider(), destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.linkState().status, 'stopped')
})

test('an MT5 destination with unknown margin_mode fails closed', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts = [broker('src'), broker('dst', { platform: 'MT5', margin_mode: 'unknown' })]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider()
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 0)
  assert.equal(db.linkState().status, 'unsupported_provider')
  assert.equal(db.linkState().error_code, 'ACCOUNT_MODE_UNSUPPORTED')
})

const goldPosition = { ticket: 77, symbol: 'XAUUSDm', operation: 'Buy', lots: 0.05, stopLoss: 4109, takeProfit: 4118 }

test('a decorated master symbol resolves against the destination inventory before opening', async () => {
  const db = new FakeDb()
  const source = provider({ orders: [goldPosition] })
  const destination = provider({ symbols: ['XAUUSD', 'EURUSD'] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 1)
  const mapping = db.tables.mirror_copy_trade_mappings[0]!
  assert.equal(mapping.source_symbol, 'XAUUSDm')
  assert.equal(mapping.destination_symbol, 'XAUUSD')
  assert.equal(db.linkState().status, 'active')
})

test('a link-level symbol mapping wins over inventory resolution', async () => {
  const db = new FakeDb()
  db.tables.broker_copy_links[0]!.manual_settings = settings({ symbol_mapping: { XAUUSDm: 'GOLD' } })
  const source = provider({ orders: [goldPosition] })
  const destination = provider({ symbols: ['XAUUSD', 'GOLD'] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]!.destination_symbol, 'GOLD')
  assert.equal(db.linkState().status, 'active')
})

test('without a destination inventory the planned symbol is sent unchanged', async () => {
  const db = new FakeDb()
  const source = provider({ orders: [goldPosition] })
  const destination = provider({ symbols: [] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]!.destination_symbol, 'XAUUSDm')
})

test('a failing /Symbols endpoint falls back to the planned symbol', async () => {
  const db = new FakeDb()
  const source = provider({ orders: [goldPosition] })
  const destination = provider({ symbolsError: new Error('symbols unavailable') })
  await monitor(db, source, destination).tick()
  assert.equal(destination.sends, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]!.destination_symbol, 'XAUUSDm')
  assert.equal(db.linkState().status, 'active')
})
function closingMapping(patch: Row = {}): Row {
  return {
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: '9001',
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: 1.05, source_take_profit: 1.2,
    state: 'closing', broker_comment: 'mc', ...patch,
  }
}

const openDestOrder = { ticket: 9001, symbol: 'EURUSD', operation: 'Buy', lots: 0.12 }

test('a user-requested close runs on the next tick even while the source is still open', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [closingMapping()]
  // Source still holds ticket 42: without the drain it would be synced (stop
  // modify), and re-opening must not happen once the copy is closed.
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ orders: [openDestOrder] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(destination.modifies, 0, 'a closing copy must not receive stop syncs')
  assert.equal(destination.sends, 0, 'a closed copy must never be re-opened')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
  assert.equal(db.linkState().status, 'active')
})

test('a user-requested close needs no source-history confirmation', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [closingMapping()]
  // Source gone and history empty: the confirmSourceClosed gate would refuse,
  // but an explicit request is intent and must still close.
  const source = provider({ orders: [], closedOrdersHistory: [] })
  const destination = provider({ orders: [openDestOrder] })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
  const unresolved = db.tables.mirror_copy_execution_events.find(row => row.action === 'reconcile')
  assert.equal(unresolved, undefined, 'a requested close must not record an unresolved source')
})

test('a paused link still honours a requested close, then stays paused', async () => {
  const db = new FakeDb()
  Object.assign(db.linkState(), { desired_status: 'paused' })
  db.tables.mirror_copy_trade_mappings = [closingMapping()]
  const destination = provider({ orders: [openDestOrder] })
  await monitor(db, provider(), destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
  assert.equal(db.linkState().status, 'paused')
})

test('a failed requested close keeps the request alive for the next tick', async () => {
  const db = new FakeDb()
  db.tables.mirror_copy_trade_mappings = [closingMapping({ destination_ticket: null, broker_comment: `mc:${LINK_ID.slice(0, 8)}:42` })]
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({
    orders: [{ ...openDestOrder, comment: `mc:${LINK_ID.slice(0, 8)}:42` }],
    closeErrorAt: 1,
  })
  await monitor(db, source, destination).tick()
  assert.equal(destination.closes, 1)
  const mapping = db.tables.mirror_copy_trade_mappings[0]!
  // finalizeOpen adopted the recovered ticket but must not have flipped the row
  // back to 'open': the user's request survives the failure.
  assert.equal(mapping.destination_ticket, '9001')
  assert.equal(mapping.state, 'closing')
  const event = db.tables.mirror_copy_execution_events.find(row => row.action === 'close')
  assert.equal(event?.status, 'uncertain')
  assert.equal(db.linkState().status, 'error')
  assert.equal(db.linkState().error_code, 'RECONCILE_PARTIAL')
})

test('stop flattens a pending requested close along with the open copies', async () => {
  const db = new FakeDb()
  Object.assign(db.linkState(), { desired_status: 'stopped', status: 'active' })
  db.tables.mirror_copy_trade_mappings = [closingMapping()]
  const destination = provider({ orders: [openDestOrder] })
  await monitor(db, provider(), destination).tick()
  assert.equal(destination.closes, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
  assert.equal(db.linkState().status, 'stopped')
})

test('a close requested while an uncertain open is being adopted is not resurrected to open', async () => {
  const db = new FakeDb()
  const comment = `mc:${LINK_ID.slice(0, 8)}:42`
  // Read 1 is the requested-close sweep (row still 'uncertain', nothing to do).
  // Read 2 is the main mappings select: the worker snapshots the row as
  // 'uncertain', then the RPC flips the live row to 'closing' before
  // finalizeOpen runs — the guard must not write 'open' over that request.
  db.tables.mirror_copy_trade_mappings = [{
    id: 'map-1', link_id: LINK_ID, source_ticket: '42', destination_ticket: null,
    source_symbol: 'EURUSD', destination_symbol: 'EURUSD', source_side: 'buy',
    source_volume: 0.3, destination_volume: 0.12, source_stop_loss: 1.05, source_take_profit: 1.2,
    state: 'uncertain', broker_comment: comment,
  }]
  let reads = 0
  db.onTableRead = () => {
    reads++
    if (reads !== 2) return
    const row = db.tables.mirror_copy_trade_mappings[0]
    if (row && row.state === 'uncertain') row.state = 'closing'
  }
  const source = provider({ orders: [sourcePosition] })
  const destination = provider({ orders: [{ ...openDestOrder, comment }] })
  await monitor(db, source, destination).tick()
  const mapping = db.tables.mirror_copy_trade_mappings[0]!
  assert.equal(mapping.destination_ticket, '9001', 'the recovered ticket is still adopted')
  assert.equal(mapping.state, 'closing', 'the mid-tick close request must survive finalizeOpen')
  // The next tick drains it through the normal requested-close path.
  db.onTableRead = undefined
  const destination2 = provider({ orders: [{ ...openDestOrder, comment }] })
  await monitor(db, provider({ orders: [sourcePosition] }), destination2).tick()
  assert.equal(destination2.closes, 1)
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
})

test('a requested close still runs when the destination account mode is unsupported', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts = [broker('src'), broker('dst', { margin_mode: 'netting' })]
  db.tables.mirror_copy_trade_mappings = [closingMapping()]
  const destination = provider({ orders: [openDestOrder] })
  await monitor(db, provider(), destination).tick()
  assert.equal(destination.closes, 1, 'closing by ticket is safe on any account mode')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
  assert.equal(db.linkState().status, 'unsupported_provider')
  assert.equal(db.linkState().error_code, 'ACCOUNT_MODE_UNSUPPORTED')
})

test('a requested close still runs when the source account is down', async () => {
  const db = new FakeDb()
  db.tables.broker_accounts = [broker('src', { is_active: false }), broker('dst')]
  db.tables.mirror_copy_trade_mappings = [closingMapping()]
  const destination = provider({ orders: [openDestOrder] })
  // The source is down: the normal reconcile would throw BROKER_DISCONNECTED
  // before ever reaching the drain, so the sweep must run ahead of that gate.
  await monitor(db, provider(), destination).tick()
  assert.equal(destination.closes, 1, 'closing needs only the destination')
  assert.equal(db.tables.mirror_copy_trade_mappings[0]?.state, 'closed')
  assert.equal(db.linkState().status, 'error')
  assert.equal(db.linkState().error_code, 'BROKER_DISCONNECTED')
})

