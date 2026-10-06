import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyManagement } from './managementExecutor'
import type { BrokerRow, ParsedSignal, SignalRow } from './types'
import type { MgmtTradeRow } from '../managementScope'

type FakeTrade = MgmtTradeRow & {
  user_id: string
  telegram_channel_id?: string | null
  auto_be_applied_at?: string | null
}

type UpdateRecord = { table: string; filters: Record<string, unknown>; patch: Record<string, unknown> }
type InsertRecord = { table: string; payload: unknown }

type TestState = {
  trades: FakeTrade[]
  signals: Record<string, { id: string; channel_id: string | null; parent_signal_id: string | null; parsed_data: ParsedSignal | null }>
  updates: UpdateRecord[]
  inserts: InsertRecord[]
  upserts: InsertRecord[]
}

const USER_ID = 'user-stefan'
const CHANNEL_ID = 'signals-tester'
const BROKER_ID = 'broker-1'
const FX_UUID = '11111111-1111-4111-8111-111111111111'

function restoreEnv(key: string, value: string | undefined): void {
  if (value == null) delete process.env[key]
  else process.env[key] = value
}

function broker(): BrokerRow {
  return {
    id: BROKER_ID,
    user_id: USER_ID,
    is_active: true,
    platform: 'mt5',
    connection_status: 'connected',
    fxsocket_account_id: FX_UUID,
    metaapi_account_id: null,
    account_login: null,
    broker_server: null,
    copier_mode: 'manual',
    signal_channel_ids: [CHANNEL_ID],
    enforce_signal_channel_filter: true,
    ai_settings: null,
    manual_settings: {
      trade_style: 'multi',
      fixed_lot: 0.01,
      breakeven_offset_pips: 0,
    },
    default_lot_size: 0.01,
    last_balance: 10_000,
    last_equity: 10_000,
    last_currency: 'USD',
    channel_message_filters: null,
    channel_trading_configs: null,
  }
}

function signal(id: string, parentSignalId: string | null, replyTo: string | null): SignalRow {
  return {
    id,
    user_id: USER_ID,
    channel_id: CHANNEL_ID,
    parsed_data: null,
    status: 'parsed',
    parent_signal_id: parentSignalId,
    is_modification: true,
    created_at: '2026-09-03T10:22:00.000Z',
    telegram_message_id: `tg-${id}`,
    reply_to_message_id: replyTo,
  }
}

function trade(id: string, signalId: string, ticket: number, entryPrice: number): FakeTrade {
  return {
    id,
    signal_id: signalId,
    broker_account_id: BROKER_ID,
    metaapi_order_id: String(ticket),
    symbol: 'XAUUSD',
    direction: 'buy',
    lot_size: 0.01,
    status: 'open',
    sl: 4290,
    tp: 4350,
    entry_price: entryPrice,
    opened_at: ticket < 2000 ? '2026-09-03T10:14:30.000Z' : '2026-09-03T10:16:30.000Z',
    user_id: USER_ID,
    telegram_channel_id: CHANNEL_ID,
    auto_be_applied_at: null,
  }
}

function makeState(trades: FakeTrade[]): TestState {
  return {
    trades,
    signals: {
      'signal-a': {
        id: 'signal-a',
        channel_id: CHANNEL_ID,
        parent_signal_id: null,
        parsed_data: { action: 'buy', symbol: 'XAUUSD', entry_zone_low: 4306.8, entry_zone_high: 4308, sl: 4301, tp: [4311.5] } as ParsedSignal,
      },
      'signal-b': {
        id: 'signal-b',
        channel_id: CHANNEL_ID,
        parent_signal_id: null,
        parsed_data: { action: 'buy', symbol: 'XAUUSD', entry_zone_low: 4307.2, entry_zone_high: 4308.4, sl: 4302, tp: [4312] } as ParsedSignal,
      },
    },
    updates: [],
    inserts: [],
    upserts: [],
  }
}

function makeSupabase(state: TestState) {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {}
      const ins: Record<string, unknown[]> = {}
      let limitN = Infinity
      let updatePatch: Record<string, unknown> | null = null

      const applyFilters = <T extends Record<string, unknown>>(rows: T[]): T[] => {
        let out = rows
        for (const [col, val] of Object.entries(eqs)) {
          out = out.filter(row => row[col] === val)
        }
        for (const [col, vals] of Object.entries(ins)) {
          out = out.filter(row => vals.includes(row[col]))
        }
        return out.slice(0, limitN)
      }

      const resolve = () => {
        let data: unknown[] = []
        if (table === 'signals') {
          data = applyFilters(Object.values(state.signals) as unknown as Record<string, unknown>[])
        } else if (table === 'trades') {
          data = applyFilters(state.trades as unknown as Record<string, unknown>[])
        } else if (table === 'range_pending_legs' || table === 'signal_entry_pending_orders') {
          data = []
        } else if (table === 'trade_channel_attributions' || table === 'channel_active_trade_params') {
          data = []
        }
        return Promise.resolve({ data, error: null, count: data.length })
      }

      const query: Record<string, unknown> = {
        select() { return query },
        eq(col: string, val: unknown) { eqs[col] = val; return query },
        in(col: string, vals: unknown[]) { ins[col] = vals; return query },
        not() { return query },
        gte() { return query },
        lte() { return query },
        order() { return query },
        limit(n: number) { limitN = n; return query },
        maybeSingle() {
          return resolve().then(res => ({ data: (res.data as unknown[])[0] ?? null, error: null }))
        },
        insert(payload: unknown) {
          state.inserts.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
        upsert(payload: unknown) {
          state.upserts.push({ table, payload })
          return Promise.resolve({ data: null, error: null })
        },
        update(patch: Record<string, unknown>) {
          updatePatch = patch
          return query
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          if (updatePatch) {
            state.updates.push({ table, filters: { ...eqs }, patch: updatePatch })
            if (table === 'trades' && typeof eqs.id === 'string') {
              const found = state.trades.find(row => row.id === eqs.id)
              if (found) Object.assign(found, updatePatch)
            }
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected)
          }
          return resolve().then(onFulfilled, onRejected)
        },
      }
      return query
    },
  }
}

function makeApi(state: TestState, modifiedTickets: number[]) {
  return {
    openedOrders: async () => state.trades
      .filter(row => row.status === 'open')
      .map(row => ({
        ticket: Number(row.metaapi_order_id),
        symbol: row.symbol,
        operation: row.direction === 'buy' ? 'Buy' : 'Sell',
        lots: row.lot_size,
        openPrice: row.entry_price,
        stopLoss: row.sl,
        takeProfit: row.tp,
      })),
    quote: async () => ({ bid: 4320, ask: 4320.2 }),
    orderModify: async (_uuid: string, args: { ticket: number; stoploss?: number; takeprofit?: number }) => {
      modifiedTickets.push(args.ticket)
      return { ticket: args.ticket, stopLoss: args.stoploss ?? null, takeProfit: args.takeprofit ?? null }
    },
  }
}

async function runBreakevenReply(parentSignalId: string): Promise<{
  resultLegs: number
  modifiedTickets: number[]
  state: TestState
}> {
  const trades = [
    trade('a-leg-1', 'signal-a', 1001, 4308.0),
    trade('a-leg-2', 'signal-a', 1002, 4306.8),
    trade('b-leg-1', 'signal-b', 2001, 4308.4),
    trade('b-leg-2', 'signal-b', 2002, 4307.2),
  ]
  const state = makeState(trades)
  const modifiedTickets: number[] = []
  const api = makeApi(state, modifiedTickets)
  const ctx = {
    supabase: makeSupabase(state),
    apiFor: () => api,
    resolveBrokerSymbolForLiveEntry: async (_uuid: string, symbol: string) => symbol,
    getSymbolParams: async () => ({
      digits: 1,
      point: 0.1,
      minLot: 0.01,
      maxLot: 100,
      lotStep: 0.01,
      contractSize: 100,
      stopsLevel: 0,
      freezeLevel: 0,
      loadedAt: Date.now(),
    }),
    resolveBasketAnchorSignalIdForOpenTrades: async ({ parentSignalId: parent }: { parentSignalId: string | null }) => parent,
    cancelRangePendingLegsForScopes: async () => undefined,
    getChannelMeta: async () => ({ commentSlug: 'signals-tester' }),
    applyCloseWorseEntriesInstruction: async () => ({ legsTotal: 0, legsParallelism: 1 }),
  }

  const result = await applyManagement(
    ctx as never,
    signal(`mgmt-${parentSignalId}`, parentSignalId, `tg-${parentSignalId}`),
    { action: 'breakeven', symbol: null, entry_price: null, entry_zone_low: null, entry_zone_high: null, sl: null, tp: [], lot_size: null } as ParsedSignal,
    [broker()],
  )

  return { resultLegs: result.legsTotal, modifiedTickets, state }
}

describe('reply-scoped management', () => {
  const oldFxKey = process.env.FXSOCKET_API_KEY
  const oldV2 = process.env.EXECUTION_ENGINE

  it('moves Signal A basket to breakeven without modifying Signal B', async () => {
    process.env.FXSOCKET_API_KEY = 'test-only'
    delete process.env.EXECUTION_ENGINE
    try {
      const out = await runBreakevenReply('signal-a')
      assert.deepEqual(out.modifiedTickets.sort((a, b) => a - b), [1001, 1002])
      assert.equal(out.resultLegs, 2)
      assert.deepEqual(
        out.state.trades.filter(row => row.signal_id === 'signal-b').map(row => row.sl),
        [4290, 4290],
      )
      assert.equal(out.state.inserts.some(row => row.table === 'trades'), false)
    } finally {
      restoreEnv('FXSOCKET_API_KEY', oldFxKey)
      restoreEnv('EXECUTION_ENGINE', oldV2)
    }
  })

  it('moves Signal B basket to breakeven when replying to Signal B', async () => {
    process.env.FXSOCKET_API_KEY = 'test-only'
    delete process.env.EXECUTION_ENGINE
    try {
      const out = await runBreakevenReply('signal-b')
      assert.deepEqual(out.modifiedTickets.sort((a, b) => a - b), [2001, 2002])
      assert.equal(out.resultLegs, 2)
      assert.deepEqual(
        out.state.trades.filter(row => row.signal_id === 'signal-a').map(row => row.sl),
        [4290, 4290],
      )
    } finally {
      restoreEnv('FXSOCKET_API_KEY', oldFxKey)
      restoreEnv('EXECUTION_ENGINE', oldV2)
    }
  })

  it('keeps existing single-basket management behavior', async () => {
    process.env.FXSOCKET_API_KEY = 'test-only'
    delete process.env.EXECUTION_ENGINE
    try {
      const state = makeState([
        trade('a-leg-1', 'signal-a', 1001, 4308.0),
        trade('a-leg-2', 'signal-a', 1002, 4306.8),
      ])
      const modifiedTickets: number[] = []
      const api = makeApi(state, modifiedTickets)
      const ctx = {
        supabase: makeSupabase(state),
        apiFor: () => api,
        resolveBrokerSymbolForLiveEntry: async (_uuid: string, symbol: string) => symbol,
        getSymbolParams: async () => ({
          digits: 1,
          point: 0.1,
          minLot: 0.01,
          maxLot: 100,
          lotStep: 0.01,
          contractSize: 100,
          stopsLevel: 0,
          freezeLevel: 0,
          loadedAt: Date.now(),
        }),
        resolveBasketAnchorSignalIdForOpenTrades: async () => null,
        cancelRangePendingLegsForScopes: async () => undefined,
        getChannelMeta: async () => ({ commentSlug: 'signals-tester' }),
        applyCloseWorseEntriesInstruction: async () => ({ legsTotal: 0, legsParallelism: 1 }),
      }

      const result = await applyManagement(
        ctx as never,
        signal('mgmt-unthreaded', null, null),
        { action: 'breakeven', symbol: 'XAUUSD', entry_price: null, entry_zone_low: null, entry_zone_high: null, sl: null, tp: [], lot_size: null } as ParsedSignal,
        [broker()],
      )

      assert.deepEqual(modifiedTickets.sort((a, b) => a - b), [1001, 1002])
      assert.equal(result.legsTotal, 2)
    } finally {
      restoreEnv('FXSOCKET_API_KEY', oldFxKey)
      restoreEnv('EXECUTION_ENGINE', oldV2)
    }
  })
})

describe('PARTIAL_PROFIT broker verification', () => {
  async function runPartial(args: {
    volume: number
    mutateTo?: number
    failPostRead?: boolean
    postTicket?: number
  }): Promise<{ state: TestState; closeCalls: Array<{ ticket: number; lots?: number }>; openedCalls: number }> {
    const oldFxKey = process.env.FXSOCKET_API_KEY
    process.env.FXSOCKET_API_KEY = 'test-only'
    try {
      const leg = trade('partial-leg', 'signal-a', 1001, 4308)
      leg.lot_size = args.volume
      const state = makeState([leg])
      const closeCalls: Array<{ ticket: number; lots?: number }> = []
      let openedCalls = 0
      let brokerVolume = args.volume
      let brokerTicket = 1001
      const api = {
        openedOrders: async () => {
          openedCalls += 1
          if (args.failPostRead && openedCalls > 1) throw new Error('OpenedOrders unavailable')
          return state.trades.filter(row => row.status === 'open').map(row => ({
            ticket: brokerTicket,
            symbol: row.symbol,
            operation: 'Buy',
            lots: brokerVolume,
            openPrice: row.entry_price,
          }))
        },
        orderClose: async (_uuid: string, closeArgs: { ticket: number; lots?: number }) => {
          closeCalls.push(closeArgs)
          if (args.mutateTo != null) {
            brokerVolume = args.mutateTo
            brokerTicket = args.postTicket ?? brokerTicket
          }
          return { ticket: closeArgs.ticket }
        },
      }
      const ctx = {
        supabase: makeSupabase(state),
        apiFor: () => api,
        resolveBrokerSymbolForLiveEntry: async (_uuid: string, symbol: string) => symbol,
        getSymbolParams: async () => ({
          digits: 2,
          point: 0.01,
          minLot: 0.01,
          maxLot: 100,
          lotStep: 0.01,
          contractSize: 1,
          stopsLevel: 0,
          freezeLevel: 0,
          loadedAt: Date.now(),
        }),
        resolveBasketAnchorSignalIdForOpenTrades: async () => null,
        cancelRangePendingLegsForScopes: async () => undefined,
        getChannelMeta: async () => ({ commentSlug: 'signals-tester' }),
        applyCloseWorseEntriesInstruction: async () => ({ legsTotal: 0, legsParallelism: 1 }),
      }
      await applyManagement(
        ctx as never,
        signal('mgmt-partial', null, null),
        {
          action: 'partial_profit',
          symbol: 'XAUUSD',
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
          sl: null,
          tp: [],
          lot_size: null,
          partial_close_fraction: 0.5,
        } as ParsedSignal,
        [broker()],
      )
      return { state, closeCalls, openedCalls }
    } finally {
      restoreEnv('FXSOCKET_API_KEY', oldFxKey)
    }
  }

  it('rejects 0.01 at 50% without calling broker or marking Executed', async () => {
    const out = await runPartial({ volume: 0.01 })
    assert.equal(out.closeCalls.length, 0)
    assert.equal(out.state.trades[0]?.lot_size, 0.01)
    assert.equal(out.state.updates.some(u => u.table === 'signals' && u.patch.status === 'executed'), false)
    assert.equal(out.state.updates.some(u =>
      u.table === 'signals'
      && u.patch.status === 'skipped'
      && u.patch.skip_reason === 'partial_close_unavailable_for_position_size'
    ), true)
  })

  it('closes 0.01 from 0.02 only after broker readback verifies 0.01 remains', async () => {
    const out = await runPartial({ volume: 0.02, mutateTo: 0.01 })
    assert.deepEqual(out.closeCalls, [{ ticket: 1001, lots: 0.01 }])
    assert.equal(out.openedCalls, 2)
    assert.equal(out.state.trades[0]?.status, 'open')
    assert.equal(out.state.trades[0]?.lot_size, 0.01)
    assert.equal(out.state.updates.some(u => u.table === 'signals' && u.patch.status === 'executed'), true)
  })

  it('persists a canonical replacement ticket after verified partial-close readback', async () => {
    const out = await runPartial({ volume: 0.02, mutateTo: 0.01, postTicket: 2002 })
    assert.deepEqual(out.closeCalls, [{ ticket: 1001, lots: 0.01 }])
    assert.equal(out.state.trades[0]?.metaapi_order_id, '2002')
    assert.equal(out.state.trades[0]?.lot_size, 0.01)
    assert.equal(out.state.updates.some(u => u.table === 'signals' && u.patch.status === 'executed'), true)
  })

  it('does not report Executed when broker nominally succeeds but volume is unchanged', async () => {
    const out = await runPartial({ volume: 0.02 })
    assert.equal(out.closeCalls.length, 1)
    assert.equal(out.state.trades[0]?.lot_size, 0.02)
    assert.equal(out.state.updates.some(u => u.table === 'signals' && u.patch.status === 'executed'), false)
    assert.equal(out.state.updates.some(u =>
      u.table === 'signals' && u.patch.skip_reason === 'partial_close_reconciliation_required'
    ), true)
  })

  it('does not report Executed when post-close OpenedOrders readback fails', async () => {
    const out = await runPartial({ volume: 0.02, failPostRead: true })
    assert.equal(out.closeCalls.length, 1)
    assert.equal(out.state.updates.some(u => u.table === 'signals' && u.patch.status === 'executed'), false)
    assert.equal(out.state.updates.some(u =>
      u.table === 'signals' && u.patch.skip_reason === 'partial_close_reconciliation_required'
    ), true)
  })
})

describe('provider external order close scope', () => {
  it('fails closed when an explicit Close Order provider ID has no matched parent signal', async () => {
    const state = makeState([trade('a-leg-1', 'signal-a', 1001, 4308)])
    await applyManagement(
      {
        supabase: makeSupabase(state),
        apiFor: () => {
          throw new Error('unresolved provider close must not reach broker execution')
        },
      } as never,
      signal('mgmt-provider-close', null, null),
      {
        action: 'close',
        symbol: 'XAUUSD',
        entry_price: null,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: null,
        tp: [],
        lot_size: null,
        provider_signal_number: 719910669,
        provider_order_type: 'close',
      } as ParsedSignal,
      [broker()],
    )
    assert.equal(state.trades[0]?.status, 'open')
    assert.equal(state.updates.some(u =>
      u.table === 'signals'
      && u.patch.status === 'skipped'
      && u.patch.skip_reason === 'provider_order_id_unresolved'
    ), true)
  })
})
