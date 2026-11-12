import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { applyManagement } from './tradeExecutor/managementExecutor'
import type { TradeExecutorContext } from './tradeExecutor/context'
import type { BrokerRow, SignalRow } from './tradeExecutor/types'

const originalKey = process.env.FXSOCKET_API_KEY

afterEach(() => {
  if (originalKey === undefined) delete process.env.FXSOCKET_API_KEY
  else process.env.FXSOCKET_API_KEY = originalKey
})

function makeSignal(overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id: 'sig-mgmt-1',
    user_id: 'user-1',
    channel_id: 'ch-1',
    parsed_data: { action: 'delete_pendings' },
    status: 'parsed',
    parent_signal_id: 'sig-parent-1',
    is_modification: true,
    created_at: new Date().toISOString(),
    telegram_message_id: '200',
    reply_to_message_id: '100',
    ...overrides,
  } as SignalRow
}

function makeBroker(overrides: Partial<BrokerRow> = {}): BrokerRow {
  return {
    id: 'broker-1',
    user_id: 'user-1',
    metaapi_account_id: 'uuid-1',
    login: '1',
    server: 'Demo',
    platform: 'mt5',
    is_active: true,
    channel_message_filters: {},
    ...overrides,
  } as BrokerRow
}

function makeSupabase(opts: {
  entryPending?: boolean
  rangePending?: boolean
  channelSignals?: Array<{ id: string }>
  signalUpdates?: Array<Record<string, unknown>>
  logs?: Array<Record<string, unknown>>
  tradesPending?: Array<{ id: string; broker_account_id: string; metaapi_order_id: string | null }>
  tradeUpdates?: Array<Record<string, unknown>>
}) {
  const signalUpdates = opts.signalUpdates ?? []
  const logs = opts.logs ?? []
  // The pending-row lookups are reached through different filter orders
  // (reply path: eq(signal).in(broker)… / channel path: in(signal).in(broker)…),
  // so expose every filter as a pass-through until the terminal limit().
  const pendingChain = (data: Array<Record<string, unknown>>) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['eq', 'in', 'order']) chain[m] = () => chain
    chain.limit = () => Promise.resolve({ data, error: null })
    return { select: () => chain }
  }
  const sepRows = opts.entryPending
    ? [{ id: 'sep-1', signal_id: 'sig-ch-1', broker_account_id: 'broker-1' }]
    : []
  const rangeRows = opts.rangePending
    ? [{ id: 'rpl-1', signal_id: 'sig-ch-1', broker_account_id: 'broker-1' }]
    : []
  return {
    from(table: string) {
      if (table === 'signals') {
        return {
          update(payload: Record<string, unknown>) {
            signalUpdates.push(payload)
            return {
              eq() {
                return {
                  eq() {
                    return Promise.resolve({ error: null })
                  },
                }
              },
            }
          },
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () =>
                  Promise.resolve({
                    data: opts.channelSignals ?? [{ id: 'sig-ch-9' }],
                    error: null,
                  }),
              }),
            }),
          }),
        }
      }
      if (table === 'trade_execution_logs') {
        return {
          insert(row: Record<string, unknown>) {
            logs.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'signal_entry_pending_orders') return pendingChain(sepRows)
      if (table === 'range_pending_legs') return pendingChain(rangeRows)
      if (table === 'trades') {
        // Lookup: select().in(signal).in(broker).eq(status).order().limit()
        // Settle: update(payload).eq(id).eq(status).select(id)
        return {
          select: () => ({
            in: () => ({
              in: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({ data: opts.tradesPending ?? [], error: null }),
                  }),
                }),
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            opts.tradeUpdates?.push(payload)
            return {
              eq: () => ({
                eq: () => ({
                  select: () =>
                    Promise.resolve({
                      error: null,
                      data: [{ id: opts.tradesPending?.[0]?.id ?? 'tr-1' }],
                    }),
                }),
              }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

describe('applyManagement delete_pendings', () => {
  it('sweeps the whole channel when the message is standalone (not a reply)', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const logs: Array<Record<string, unknown>> = []
    const signalUpdates: Array<Record<string, unknown>> = []
    const cancelCalls: unknown[] = []
    const ctx = {
      supabase: makeSupabase({
        channelSignals: [{ id: 'sig-ch-1' }],
        entryPending: true,
        rangePending: true,
        logs,
        signalUpdates,
      }),
      cancelRangePendingLegsForScopes: async (...args: unknown[]) => {
        cancelCalls.push(args)
      },
    } as unknown as TradeExecutorContext

    await applyManagement(
      ctx,
      makeSignal({ reply_to_message_id: null, parent_signal_id: null }),
      { action: 'delete_pendings' } as never,
      [makeBroker()],
    )

    assert.ok(
      !logs.some(l => l.action === 'mgmt_skip'),
      'standalone delete_pendings must not skip',
    )
    const ok = logs.find(l => l.action === 'delete_pendings' && l.status === 'success')
    assert.ok(ok, 'must write a channel-wide delete_pendings success log')
    const payload = ok.request_payload as { mgmt_scope?: string; reply_scoped?: boolean }
    assert.equal(payload.mgmt_scope, 'channel')
    assert.equal(payload.reply_scoped, false)
    assert.equal(cancelCalls.length, 1)
    const scopes = (cancelCalls[0] as unknown[])[2] as Array<{
      signalId: string
      brokerAccountId: string
    }>
    assert.deepEqual(scopes, [{ signalId: 'sig-ch-1', brokerAccountId: 'broker-1', symbol: '' }])
    assert.ok(signalUpdates.some(u => u.status === 'executed'))
  })

  it('reports delete_pendings_none for a standalone message when nothing is pending', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const logs: Array<Record<string, unknown>> = []
    const ctx = {
      supabase: makeSupabase({ channelSignals: [{ id: 'sig-ch-1' }], logs }),
      cancelRangePendingLegsForScopes: async () => {},
    } as unknown as TradeExecutorContext

    await applyManagement(
      ctx,
      makeSignal({ reply_to_message_id: null, parent_signal_id: null }),
      { action: 'delete_pendings' } as never,
      [makeBroker()],
    )

    const skip = logs.find(l => l.action === 'mgmt_skip')
    assert.ok(skip, 'must log a skip when the channel has nothing pending')
    const payload = skip.request_payload as { skip_reason?: string; mgmt_scope?: string }
    assert.equal(payload.skip_reason, 'delete_pendings_none')
    assert.equal(payload.mgmt_scope, 'channel')
  })

  it('skips when reply has no parent_signal_id', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const logs: Array<Record<string, unknown>> = []
    const cancelCalls: unknown[] = []
    const ctx = {
      supabase: makeSupabase({ logs }),
      cancelRangePendingLegsForScopes: async (...args: unknown[]) => {
        cancelCalls.push(args)
      },
    } as unknown as TradeExecutorContext

    await applyManagement(
      ctx,
      makeSignal({ parent_signal_id: null }),
      { action: 'delete_pendings' } as never,
      [makeBroker()],
    )

    assert.equal(cancelCalls.length, 0)
    assert.equal(
      (logs.find(l => l.action === 'mgmt_skip')?.request_payload as { skip_reason?: string })?.skip_reason,
      'delete_pendings_no_parent',
    )
  })

  it('cancels only parent signal scopes when pending exists', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const logs: Array<Record<string, unknown>> = []
    const signalUpdates: Array<Record<string, unknown>> = []
    const cancelCalls: unknown[] = []
    const ctx = {
      supabase: makeSupabase({ entryPending: true, logs, signalUpdates }),
      cancelRangePendingLegsForScopes: async (...args: unknown[]) => {
        cancelCalls.push(args)
      },
    } as unknown as TradeExecutorContext

    await applyManagement(
      ctx,
      makeSignal(),
      { action: 'delete_pendings' } as never,
      [makeBroker()],
    )

    assert.equal(cancelCalls.length, 1)
    const [userId, logSignalId, scopes, reason] = cancelCalls[0] as [
      string,
      string,
      Array<{ signalId: string; brokerAccountId: string }>,
      string,
    ]
    assert.equal(userId, 'user-1')
    assert.equal(logSignalId, 'sig-mgmt-1')
    assert.equal(reason, 'delete_pendings')
    assert.deepEqual(scopes, [{ signalId: 'sig-parent-1', brokerAccountId: 'broker-1', symbol: '' }])
    assert.ok(logs.some(l => l.action === 'delete_pendings' && l.status === 'success'))
    assert.ok(signalUpdates.some(u => u.status === 'executed'))
  })

  it('skips when no pending rows for parent', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const logs: Array<Record<string, unknown>> = []
    const cancelCalls: unknown[] = []
    const ctx = {
      supabase: makeSupabase({ entryPending: false, rangePending: false, logs }),
      cancelRangePendingLegsForScopes: async (...args: unknown[]) => {
        cancelCalls.push(args)
      },
    } as unknown as TradeExecutorContext

    await applyManagement(
      ctx,
      makeSignal(),
      { action: 'delete_pendings' } as never,
      [makeBroker()],
    )

    assert.equal(cancelCalls.length, 0)
    assert.equal(
      (logs.find(l => l.action === 'mgmt_skip')?.request_payload as { skip_reason?: string })?.skip_reason,
      'delete_pendings_none',
    )
  })

  it('cancels resting trades-pending orders when no sep or range rows exist', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const logs: Array<Record<string, unknown>> = []
    const signalUpdates: Array<Record<string, unknown>> = []
    const tradeUpdates: Array<Record<string, unknown>> = []
    const apiCalls: Array<{ endpoint: string; sessionId: string; ticket: number }> = []
    const api = {
      async orderCancel(sessionId: string, args: { ticket: number }) {
        apiCalls.push({ endpoint: 'orderCancel', sessionId, ticket: args.ticket })
        return {}
      },
      async orderClose(sessionId: string, args: { ticket: number }) {
        apiCalls.push({ endpoint: 'orderClose', sessionId, ticket: args.ticket })
        return {}
      },
    }
    const ctx = {
      supabase: makeSupabase({
        logs,
        signalUpdates,
        tradeUpdates,
        tradesPending: [
          { id: 'tr-1', broker_account_id: 'broker-1', metaapi_order_id: '2067348975' },
        ],
      }),
      cancelRangePendingLegsForScopes: async () => undefined,
      apiFor: () => api,
    } as unknown as TradeExecutorContext

    await applyManagement(
      ctx,
      makeSignal(),
      { action: 'delete_pendings' } as never,
      // brokerSessionUuid only accepts a real MT uuid, otherwise resolve() is
      // null and nothing can be cancelled.
      [makeBroker({ metaapi_account_id: '00000000-0000-4000-8000-000000000001' })],
    )

    // Not skipped: the trades-pending order alone is enough to act.
    assert.ok(
      !logs.some(
        l =>
          l.action === 'mgmt_skip' &&
          (l.request_payload as { skip_reason?: string })?.skip_reason === 'delete_pendings_none',
      ),
      'must not report delete_pendings_none when a resting order was cancelled',
    )
    assert.deepEqual(apiCalls, [
      { endpoint: 'orderCancel', sessionId: '00000000-0000-4000-8000-000000000001', ticket: 2067348975 },
    ])
    assert.equal(tradeUpdates.length, 1)
    assert.equal(tradeUpdates[0]!.status, 'cancelled')
    assert.ok(typeof tradeUpdates[0]!.closed_at === 'string')
    const success = logs.find(l => l.action === 'delete_pendings' && l.status === 'success')
    assert.ok(success, 'must write the delete_pendings success log')
    assert.equal(
      (success!.request_payload as { trades_pending_cancelled?: number })?.trades_pending_cancelled,
      1,
    )
    assert.ok(signalUpdates.some(u => u.status === 'executed'))
  })

  it('reports cancel_failed (not none) when resting orders exist but the broker refuses', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const logs: Array<Record<string, unknown>> = []
    const api = {
      async orderClose() {
        throw new Error('Invalid request')
      },
      async orderCancel() {
        throw new Error('Invalid request')
      },
    }
    const ctx = {
      supabase: makeSupabase({
        logs,
        tradesPending: [
          { id: 'tr-1', broker_account_id: 'broker-1', metaapi_order_id: '2067348975' },
        ],
      }),
      cancelRangePendingLegsForScopes: async () => undefined,
      apiFor: () => api,
    } as unknown as TradeExecutorContext

    await applyManagement(
      ctx,
      makeSignal(),
      { action: 'delete_pendings' } as never,
      [makeBroker({ metaapi_account_id: '00000000-0000-4000-8000-000000000001' })],
    )

    const skip = logs.find(l => l.action === 'mgmt_skip')
    assert.ok(skip, 'must skip with a reason')
    const payload = skip!.request_payload as Record<string, unknown>
    assert.equal(payload.skip_reason, 'delete_pendings_cancel_failed')
    assert.equal(payload.trades_pending_found, 1)
    assert.equal(payload.trades_pending_cancelled, 0)
    assert.equal(payload.trades_pending_failed, 1)
    assert.ok(
      !logs.some(
        l =>
          l.action === 'mgmt_skip' &&
          (l.request_payload as { skip_reason?: string })?.skip_reason === 'delete_pendings_none',
      ),
      'must not claim "none found" when orders were found',
    )
  })
})
