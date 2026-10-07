import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyManagement } from './managementExecutor'
import type { BrokerRow, ParsedSignal, RangePendingCancelScope, SignalRow } from './types'

type Row = Record<string, unknown>

type ProviderState = {
  tables: Record<string, Row[]>
  updates: Array<{ table: string; patch: Row; filters: Record<string, unknown> }>
  inserts: Array<{ table: string; payload: unknown }>
  closeCalls: number[]
  cancelScopes: RangePendingCancelScope[]
  resolverCalls: number
}

const USER_ID = 'provider-user'
const CHANNEL_ID = 'provider-channel'
const BROKER_ID = 'provider-broker'
const UUID = '22222222-2222-4222-8222-222222222222'

function trade(id: string, signalId: string, ticket: number): Row {
  return {
    id,
    signal_id: signalId,
    broker_account_id: BROKER_ID,
    metaapi_order_id: String(ticket),
    symbol: 'XAUUSD',
    direction: 'buy',
    lot_size: 0.02,
    status: 'open',
    sl: 2300,
    tp: 2500,
    entry_price: 2400,
    opened_at: new Date(ticket).toISOString(),
    user_id: USER_ID,
  }
}

function rangeLeg(id: string, signalId: string, status = 'pending'): Row {
  return {
    id,
    signal_id: signalId,
    user_id: USER_ID,
    broker_account_id: BROKER_ID,
    symbol: 'XAUUSD',
    step_idx: 1,
    is_buy: true,
    anchor_price: 2400,
    stoploss: 2300,
    takeprofit: 2500,
    cwe_close_price: null,
    status,
  }
}

function artifact(id: string, signalId: string, status: string): Row {
  return {
    id,
    signal_id: signalId,
    user_id: USER_ID,
    broker_account_id: BROKER_ID,
    metaapi_account_id: UUID,
    symbol: 'XAUUSD',
    trade_id: null,
    broker_ticket: String(id === 'entry-p' ? 501 : 502),
    is_buy: true,
    status,
  }
}

function makeState(overrides: Partial<Record<'trades' | 'range_pending_legs' | 'signal_entry_pending_orders' | 'signal_range_entry_waits', Row[]>> = {}): ProviderState {
  return {
    tables: {
      trades: overrides.trades ?? [],
      range_pending_legs: overrides.range_pending_legs ?? [],
      signal_entry_pending_orders: overrides.signal_entry_pending_orders ?? [],
      signal_range_entry_waits: overrides.signal_range_entry_waits ?? [],
      signals: [
        { id: 'P', user_id: USER_ID, channel_id: CHANNEL_ID, parsed_data: { action: 'buy', symbol: 'XAUUSD' } },
        { id: 'Q', user_id: USER_ID, channel_id: CHANNEL_ID, parsed_data: { action: 'buy', symbol: 'XAUUSD' } },
      ],
      trade_execution_logs: [],
      trade_channel_attributions: [],
      channel_active_trade_params: [],
    },
    updates: [],
    inserts: [],
    closeCalls: [],
    cancelScopes: [],
    resolverCalls: 0,
  }
}

function makeSupabase(state: ProviderState) {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {}
      const ins: Record<string, unknown[]> = {}
      let limitN = Infinity
      let patch: Row | null = null

      const filtered = () => {
        let rows = [...(state.tables[table] ?? [])]
        for (const [key, value] of Object.entries(eqs)) rows = rows.filter(row => row[key] === value)
        for (const [key, values] of Object.entries(ins)) rows = rows.filter(row => values.includes(row[key]))
        return rows.slice(0, limitN)
      }
      const resolve = () => {
        const rows = filtered()
        if (patch) {
          state.updates.push({ table, patch: { ...patch }, filters: { ...eqs } })
          for (const row of rows) Object.assign(row, patch)
          return Promise.resolve({ data: rows, error: null, count: rows.length })
        }
        return Promise.resolve({ data: rows, error: null, count: rows.length })
      }
      const query: Record<string, unknown> = {
        select() { return query },
        eq(key: string, value: unknown) { eqs[key] = value; return query },
        in(key: string, values: unknown[]) { ins[key] = values; return query },
        not() { return query },
        is() { return query },
        gte() { return query },
        lte() { return query },
        or() { return query },
        order() { return query },
        limit(value: number) { limitN = value; return query },
        maybeSingle() {
          return resolve().then(result => ({ data: (result.data as Row[])[0] ?? null, error: null }))
        },
        update(value: Row) { patch = value; return query },
        insert(payload: unknown) {
          state.inserts.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
        upsert(payload: unknown) {
          state.inserts.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
        delete() { return query },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          return resolve().then(onFulfilled, onRejected)
        },
      }
      return query
    },
  }
}

function broker(): BrokerRow {
  return {
    id: BROKER_ID,
    user_id: USER_ID,
    provider: 'fxsocket',
    is_active: true,
    platform: 'mt5',
    connection_status: 'connected',
    fxsocket_account_id: UUID,
    metaapi_account_id: null,
    account_login: '1001',
    broker_server: 'demo',
    copier_mode: 'manual',
    signal_channel_ids: [CHANNEL_ID],
    enforce_signal_channel_filter: true,
    ai_settings: null,
    manual_settings: { trade_style: 'single', fixed_lot: 0.01 },
    default_lot_size: 0.01,
    last_balance: 1000,
    last_equity: 1000,
    last_currency: 'USD',
    channel_message_filters: null,
    channel_trading_configs: null,
  }
}

function closeSignal(parentSignalId = 'P'): SignalRow {
  return {
    id: 'close-100',
    user_id: USER_ID,
    channel_id: CHANNEL_ID,
    parsed_data: null,
    status: 'parsed',
    parent_signal_id: parentSignalId,
    is_modification: true,
    telegram_message_id: 'close-message',
    reply_to_message_id: null,
  }
}

const closeParsed = {
  action: 'close',
  symbol: 'XAUUSD',
  entry_price: null,
  entry_zone_low: null,
  entry_zone_high: null,
  sl: null,
  tp: [],
  lot_size: null,
  provider_signal_number: 100,
  provider_order_type: 'close',
} as ParsedSignal

async function run(state: ProviderState): Promise<void> {
  const supabase = makeSupabase(state)
  const api = {
    openedOrders: async () => state.tables.trades
      .filter(row => row.status === 'open')
      .map(row => ({
        ticket: Number(row.metaapi_order_id),
        operation: row.direction === 'buy' ? 'Buy' : 'Sell',
        symbol: row.symbol,
        lots: row.lot_size,
        openPrice: row.entry_price,
      })),
    orderClose: async (_uuid: string, args: { ticket: number }) => {
      state.closeCalls.push(args.ticket)
      const row = state.tables.trades.find(candidate => Number(candidate.metaapi_order_id) === args.ticket)
      if (row) row.status = 'closed'
      return { ticket: args.ticket, state: 'Filled' }
    },
  }
  await applyManagement({
    supabase,
    apiFor: () => api,
    apiForUuid: () => api,
    resolveBasketAnchorSignalIdForOpenTrades: async () => {
      state.resolverCalls += 1
      throw new Error('provider close must not use generic basket resolver')
    },
    cancelRangePendingLegsForScopes: async (
      _userId: string,
      _logSignalId: string,
      scopes: RangePendingCancelScope[],
    ) => { state.cancelScopes.push(...scopes) },
    resolveBrokerSymbolForLiveEntry: async (_uuid: string, symbol: string) => symbol,
    getSymbolParams: async () => ({
      digits: 2,
      point: 0.01,
      minLot: 0.01,
      maxLot: 100,
      lotStep: 0.01,
      contractSize: 100,
      stopsLevel: 0,
      freezeLevel: 0,
      loadedAt: Date.now(),
    }),
    getChannelMeta: async () => ({ commentSlug: 'provider-channel' }),
    applyCloseWorseEntriesInstruction: async () => ({ legsTotal: 0, legsParallelism: 1 }),
  } as never, closeSignal(), closeParsed, [broker()], { liveMgmtFast: true })
}

describe('exact provider Close Order scope', () => {
  it('closes only the correlated parent while a newer same-symbol basket remains open', async () => {
    const state = makeState({ trades: [trade('p-live', 'P', 1001), trade('q-live', 'Q', 1011)] })
    await run(state)
    assert.deepEqual(state.closeCalls, [1001])
    assert.equal(state.tables.trades.find(row => row.signal_id === 'Q')?.status, 'open')
    assert.equal(state.resolverCalls, 0)
    const successLog = state.inserts.find(record =>
      record.table === 'trade_execution_logs'
      && (record.payload as Row).action === 'mgmt_close'
      && (record.payload as Row).status === 'success'
    )
    assert.equal(((successLog?.payload as Row)?.request_payload as Row)?.mgmt_scope, 'provider_order')
  })

  it('treats delayed duplicate Close #100 as already closed without touching live #101', async () => {
    const state = makeState({ trades: [trade('q-live', 'Q', 1011)] })
    await run(state)
    assert.deepEqual(state.closeCalls, [])
    assert.deepEqual(state.cancelScopes, [])
    assert.equal(state.tables.trades[0]?.status, 'open')
    assert.equal(state.resolverCalls, 0)
    assert.equal(state.updates.some(update =>
      update.table === 'signals'
      && update.patch.skip_reason === 'provider_order_already_closed'
    ), true)
  })

  it('cancels only parent P range pending legs', async () => {
    const state = makeState({
      trades: [trade('q-live', 'Q', 1011)],
      range_pending_legs: [rangeLeg('range-p', 'P'), rangeLeg('range-q', 'Q')],
    })
    await run(state)
    assert.ok(state.cancelScopes.length > 0)
    assert.ok(state.cancelScopes.every(scope => scope.signalId === 'P'))
    assert.equal(state.tables.trades[0]?.status, 'open')
  })

  it('cancels only parent P signal-entry broker pending orders', async () => {
    const state = makeState({
      trades: [trade('q-live', 'Q', 1011)],
      signal_entry_pending_orders: [
        artifact('entry-p', 'P', 'broker_pending'),
        artifact('entry-q', 'Q', 'broker_pending'),
      ],
    })
    await run(state)
    assert.ok(state.cancelScopes.length > 0)
    assert.ok(state.cancelScopes.every(scope => scope.signalId === 'P'))
    assert.equal(state.tables.trades[0]?.status, 'open')
  })

  it('cancels only parent P deferred range wait', async () => {
    const state = makeState({
      trades: [trade('q-live', 'Q', 1011)],
      signal_range_entry_waits: [
        artifact('wait-p', 'P', 'waiting'),
        artifact('wait-q', 'Q', 'waiting'),
      ],
    })
    await run(state)
    assert.equal(state.tables.signal_range_entry_waits.find(row => row.signal_id === 'P')?.status, 'cancelled')
    assert.equal(state.tables.signal_range_entry_waits.find(row => row.signal_id === 'Q')?.status, 'waiting')
    assert.equal(state.tables.trades[0]?.status, 'open')
  })
})
