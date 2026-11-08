import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cancelTradesPendingOrders, type TradesPendingCancelCounts } from './tradesPendingCancel'
import type { PendingCancelApi } from './pendingOrderCancel'

type Row = { id: string; broker_account_id: string; metaapi_order_id: string | null }

function fakeSupabase(opts: {
  rows?: Row[]
  settleData?: Array<{ id: string }>
  lookupError?: string
  filters?: Array<{ col: string; args: unknown[] }>
  updates?: Array<Record<string, unknown>>
} = {}) {
  const filters = opts.filters ?? []
  const updates = opts.updates ?? []
  const state = { update: null as Record<string, unknown> | null }
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.select = self
  chain.in = (col: string, args: unknown[]) => {
    filters.push({ col, args })
    return chain
  }
  chain.eq = (col: string, value: unknown) => {
    filters.push({ col, args: [value] })
    return chain
  }
  chain.order = self
  chain.update = (payload: Record<string, unknown>) => {
    state.update = payload
    updates.push(payload)
    return chain
  }
  chain.limit = () =>
    Promise.resolve({
      data: opts.rows ?? [],
      error: opts.lookupError ? { message: opts.lookupError } : null,
    })
  chain.then = (fulfilled: (value: unknown) => unknown, rejected?: (reason: unknown) => unknown) => {
    if (state.update) {
      return Promise.resolve({
        error: null,
        data: opts.settleData ?? [{ id: opts.rows?.[0]?.id ?? 'tr-1' }],
      }).then(fulfilled, rejected)
    }
    return Promise.resolve({ data: [], error: null }).then(fulfilled, rejected)
  }
  return { from: () => chain, filters, updates }
}

type ApiCalls = Array<{ endpoint: string; sessionId: string; ticket: number }>

function makeApi(opts: {
  orders?: unknown[] | Error
  withSnapshot?: boolean
  failCancel?: boolean
} = {}) {
  const calls: ApiCalls = []
  const api: PendingCancelApi = {
    async orderClose(sessionId, args) {
      calls.push({ endpoint: 'orderClose', sessionId, ticket: args.ticket })
    },
    async orderCancel(sessionId, args) {
      calls.push({ endpoint: 'orderCancel', sessionId, ticket: args.ticket })
      if (opts.failCancel) throw new Error('Invalid request')
    },
  }
  if (opts.withSnapshot !== false) {
    api.openedOrders = async () => {
      if (opts.orders instanceof Error) throw opts.orders
      return opts.orders ?? [{ ticket: 2067348975, operation: 'BuyLimit' }]
    }
  }
  return { api, calls }
}

function expectCounts(
  actual: TradesPendingCancelCounts,
  expected: Partial<TradesPendingCancelCounts>,
) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(
      actual[key as keyof TradesPendingCancelCounts],
      value,
      `count ${key} (actual ${JSON.stringify(actual)})`,
    )
  }
}

const row: Row = { id: 'tr-1', broker_account_id: 'broker-1', metaapi_order_id: '2067348975' }
const argsFor = (rows: Row[], api: PendingCancelApi) => ({
  signalIds: ['sig-1'],
  brokerAccountIds: ['broker-1'],
  resolve: (brokerAccountId: string) =>
    brokerAccountId === 'broker-1' ? { api, sessionId: 'uuid-1' } : null,
  rows,
})

describe('cancelTradesPendingOrders', () => {
  it('cancels a verified resting order and settles the row', async () => {
    const { api, calls } = makeApi({ orders: [{ ticket: 2067348975, operation: 'BuyLimit' }] })
    const supabase = fakeSupabase({ rows: [row] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      ...argsFor([row], api),
    })
    expectCounts(counts, { found: 1, cancelled: 1, failed: 0, filled: 0 })
    assert.deepEqual(calls, [{ endpoint: 'orderCancel', sessionId: 'uuid-1', ticket: 2067348975 }])
    assert.equal(supabase.updates.length, 1)
    assert.equal(supabase.updates[0]!.status, 'cancelled')
    assert.ok(typeof supabase.updates[0]!.closed_at === 'string')
  })

  it('scopes the query to the given signals and brokers', async () => {
    const { api } = makeApi()
    const supabase = fakeSupabase({ rows: [] })
    await cancelTradesPendingOrders({ supabase: supabase as never, ...argsFor([], api) })
    assert.deepEqual(supabase.filters, [
      { col: 'signal_id', args: ['sig-1'] },
      { col: 'broker_account_id', args: ['broker-1'] },
      { col: 'status', args: ['pending'] },
    ])
  })

  it('never touches a ticket that has become a live position', async () => {
    const { api, calls } = makeApi({ orders: [{ ticket: 2067348975, operation: 'Buy' }] })
    const supabase = fakeSupabase({ rows: [row] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      ...argsFor([row], api),
    })
    expectCounts(counts, { found: 1, cancelled: 0, filled: 1 })
    assert.equal(calls.length, 0)
    assert.equal(supabase.updates.length, 0)
  })

  it('leaves rows alone when the ticket is absent from the snapshot', async () => {
    const { api, calls } = makeApi({ orders: [] })
    const supabase = fakeSupabase({ rows: [row] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      ...argsFor([row], api),
    })
    expectCounts(counts, { found: 1, cancelled: 0, absent: 1 })
    assert.equal(calls.length, 0)
    assert.equal(supabase.updates.length, 0)
  })

  it('cancels nothing when the snapshot cannot be fetched', async () => {
    const { api, calls } = makeApi({ orders: new Error('bridge down') })
    const supabase = fakeSupabase({ rows: [row] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      ...argsFor([row], api),
    })
    expectCounts(counts, { found: 1, cancelled: 0, unverifiable: 1 })
    assert.equal(calls.length, 0)
    assert.equal(supabase.updates.length, 0)
  })

  it('keeps the direct-cancel behaviour for providers without a snapshot', async () => {
    const { api, calls } = makeApi({ withSnapshot: false })
    const supabase = fakeSupabase({ rows: [row] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      ...argsFor([row], api),
    })
    expectCounts(counts, { found: 1, cancelled: 1 })
    assert.deepEqual(calls, [{ endpoint: 'orderCancel', sessionId: 'uuid-1', ticket: 2067348975 }])
    assert.equal(supabase.updates.length, 1)
  })

  it('leaves the row when the broker refuses the cancel', async () => {
    const { api } = makeApi({ failCancel: true })
    const supabase = fakeSupabase({ rows: [row] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      ...argsFor([row], api),
    })
    expectCounts(counts, { found: 1, cancelled: 0, failed: 1 })
    assert.equal(supabase.updates.length, 0)
  })

  it('skips rows whose broker session cannot be resolved', async () => {
    const supabase = fakeSupabase({ rows: [row] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      signalIds: ['sig-1'],
      brokerAccountIds: ['broker-1'],
      resolve: () => null,
    })
    expectCounts(counts, { found: 1, cancelled: 0, unresolvable: 1 })
    assert.equal(supabase.updates.length, 0)
  })

  it('counts only rows the settle CAS actually changed', async () => {
    const { api } = makeApi()
    const supabase = fakeSupabase({ rows: [row], settleData: [] })
    const counts = await cancelTradesPendingOrders({
      supabase: supabase as never,
      ...argsFor([row], api),
    })
    expectCounts(counts, { found: 1, cancelled: 0 })
  })

  it('returns all-zero counts without querying when inputs are empty', async () => {
    const counts = await cancelTradesPendingOrders({
      supabase: {
        from() {
          throw new Error('must not query')
        },
      } as never,
      signalIds: [],
      brokerAccountIds: ['broker-1'],
      resolve: () => null,
    })
    expectCounts(counts, {
      found: 0,
      cancelled: 0,
      failed: 0,
      filled: 0,
      absent: 0,
      unresolvable: 0,
      unverifiable: 0,
    })
  })
})
