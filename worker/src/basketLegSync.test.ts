import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyBasketLegSync, type BasketOpenLeg } from './basketSlTpReconcile'
import { applyMgmtModifyToBasketGroups } from './managementModifyBaskets'
import { BasketSlTpReconcileMonitor, isAllLegsGhostOnBroker, isEmptyOpenedOrdersInconclusive } from './basketSlTpReconcileMonitor'
import type { MgmtTradeRow } from './managementScope'

const UUID = '11111111-1111-1111-1111-111111111111'

type MockCalls = {
  upserts: Array<{ table: string; payload: unknown }>
  inserts: Array<{ table: string; payload: unknown }>
  updates: Array<{ table: string; payload: unknown }>
}

/** Minimal chainable Supabase mock for the reconcile/modify paths. */
function makeMockSupabase() {
  const calls: MockCalls = { upserts: [], inserts: [], updates: [] }
  function builder(table: string) {
    const state: { data: unknown; error: unknown } = { data: null, error: null }
    const b: Record<string, unknown> = {}
    const self = () => b
    b.insert = (payload: unknown) => { calls.inserts.push({ table, payload }); return b }
    b.update = (payload: unknown) => {
      calls.updates.push({ table, payload })
      if (table === 'basket_reconcile_jobs') state.data = [{ id: 'reclaimed-1' }]
      return b
    }
    b.upsert = (payload: unknown) => {
      calls.upserts.push({ table, payload })
      if (table === 'basket_reconcile_jobs') state.data = { id: 'job-1' }
      return b
    }
    b.delete = self
    b.select = self
    b.eq = self
    b.in = self
    b.lte = self
    b.lt = self
    b.gte = self
    b.not = self
    b.ilike = self
    b.order = self
    b.limit = self
    b.maybeSingle = () => Promise.resolve({ data: state.data, error: state.error })
    b.single = () => Promise.resolve({ data: state.data, error: state.error })
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: state.data, error: state.error }).then(res, rej)
    return b
  }
  return { supabase: { from: (t: string) => builder(t) }, calls }
}

const SYMBOL_PARAMS = {
  digits: 2,
  point: 0.01,
  minLot: 0.01,
  lotStep: 0.01,
  contractSize: 100,
  stopsLevel: 0,
  freezeLevel: 0,
}

function buyLeg(ticket: number): BasketOpenLeg {
  return {
    id: `trade-${ticket}`,
    signal_id: 'anchor-1',
    metaapi_order_id: String(ticket),
    opened_at: new Date(Date.now() + ticket).toISOString(),
    lot_size: 0.05,
    sl: null,
    tp: null,
    entry_price: 4000,
    direction: 'buy',
    symbol: 'XAUUSD',
  }
}

let savedStraggler: string | undefined

beforeEach(() => {
  savedStraggler = process.env.BASKET_MGMT_STRAGGLER_ROUNDS
  // Keep retries small so doomed-leg tests stay fast.
  process.env.BASKET_MGMT_STRAGGLER_ROUNDS = '2'
})

afterEach(() => {
  if (savedStraggler === undefined) delete process.env.BASKET_MGMT_STRAGGLER_ROUNDS
  else process.env.BASKET_MGMT_STRAGGLER_ROUNDS = savedStraggler
})

describe('applyBasketLegSync', () => {
  it('retries a transient straggler leg and completes without a reconcile job', async () => {
    const { supabase, calls } = makeMockSupabase()
    const legs = Array.from({ length: 8 }, (_, i) => buyLeg(2000 + i))
    let flakyAttempts = 0
    const api = {
      quote: async () => ({ bid: 4000, ask: 4000.2, symbol: 'XAUUSD' }),
      openedOrders: async () => legs.map(l => ({ ticket: Number(l.metaapi_order_id) })),
      orderModify: async (_uuid: string, args: { ticket: number; stoploss?: number; takeprofit?: number }) => {
        if (args.ticket === 2003 && flakyAttempts++ === 0) {
          throw new Error('Order rejected: temporary')
        }
        return { stopLoss: args.stoploss, takeProfit: args.takeprofit }
      },
    }

    const result = await applyBasketLegSync({
      supabase: supabase as never,
      api: api as never,
      uuid: UUID,
      symbol: 'XAUUSD',
      direction: 'buy',
      baseLot: 0.05,
      params: SYMBOL_PARAMS,
      signalId: 'sig-mod',
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      channelId: 'chan-1',
      anchorSignalId: 'anchor-1',
      familyTrades: legs,
      perLegTargets: legs.map(() => ({ stoploss: 3990, takeprofit: 4020 })),
      nImmCwe: 0,
      overrideTp: null,
      openedTickets: new Set(legs.map(l => Number(l.metaapi_order_id))),
      explicitChannelTargets: true,
    })

    assert.equal(result.mergeFailed, false)
    assert.equal(result.modifiedTradeIds.size, 8)
    assert.equal(result.reconcileEnqueued, false)
    assert.equal(
      calls.upserts.some(c => c.table === 'basket_reconcile_jobs'),
      false,
      'should not enqueue a reconcile job when all legs sync',
    )
  })

  it('enqueues a reconcile job when legs keep failing on the broker', async () => {
    const { supabase, calls } = makeMockSupabase()
    const legs = Array.from({ length: 16 }, (_, i) => buyLeg(1000 + i))
    const doomed = new Set([1001, 1002])
    const api = {
      quote: async () => ({ bid: 4000, ask: 4000.2, symbol: 'XAUUSD' }),
      openedOrders: async () => legs.map(l => ({ ticket: Number(l.metaapi_order_id) })),
      orderModify: async (_uuid: string, args: { ticket: number; stoploss?: number; takeprofit?: number }) => {
        if (doomed.has(args.ticket)) throw new Error('Order rejected')
        return { stopLoss: args.stoploss, takeProfit: args.takeprofit }
      },
    }

    const result = await applyBasketLegSync({
      supabase: supabase as never,
      api: api as never,
      uuid: UUID,
      symbol: 'XAUUSD',
      direction: 'buy',
      baseLot: 0.05,
      params: SYMBOL_PARAMS,
      signalId: 'sig-mod',
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      channelId: 'chan-1',
      anchorSignalId: 'anchor-1',
      familyTrades: legs,
      perLegTargets: legs.map(() => ({ stoploss: 3990, takeprofit: 4020 })),
      nImmCwe: 0,
      overrideTp: null,
      openedTickets: new Set(legs.map(l => Number(l.metaapi_order_id))),
      explicitChannelTargets: true,
    })

    assert.equal(result.mergeFailed, true)
    assert.equal(result.reconcileEnqueued, true)
    assert.equal(result.summary.failed, 2)
    assert.equal(
      calls.upserts.some(c => c.table === 'basket_reconcile_jobs'),
      true,
      'partial basket sync must enqueue a reconcile job',
    )
  })
})

describe('applyMgmtModifyToBasketGroups', () => {
  it('reports allSynced=false and enqueues reconcile when broker rejects legs', async () => {
    const { supabase, calls } = makeMockSupabase()
    const rows: MgmtTradeRow[] = Array.from({ length: 16 }, (_, i) => ({
      id: `trade-${1000 + i}`,
      signal_id: 'anchor-1',
      broker_account_id: 'broker-1',
      metaapi_order_id: String(1000 + i),
      symbol: 'XAUUSD',
      direction: 'buy',
      lot_size: 0.05,
      status: 'open',
      sl: null,
      tp: null,
      entry_price: 4000,
      opened_at: new Date(Date.now() + i).toISOString(),
    }))
    const doomed = new Set([1001, 1002])
    const api = {
      symbolParams: async () => SYMBOL_PARAMS,
      quote: async () => ({ bid: 4000, ask: 4000.2, symbol: 'XAUUSD' }),
      openedOrders: async () => rows.map(r => ({ ticket: Number(r.metaapi_order_id) })),
      orderModify: async (_uuid: string, args: { ticket: number; stoploss?: number; takeprofit?: number }) => {
        if (doomed.has(args.ticket)) throw new Error('Order rejected')
        return { stopLoss: args.stoploss, takeProfit: args.takeprofit }
      },
    }
    const broker = {
      id: 'broker-1',
      fxsocket_account_id: UUID,
      manual_settings: {},
      channel_message_filters: null,
      default_lot_size: 0.05,
    }

    const result = await applyMgmtModifyToBasketGroups({
      supabase: supabase as never,
      apiFor: () => api as never,
      signal: { id: 'sig-mod', user_id: 'user-1', channel_id: 'chan-1' },
      parsed: { sl: 3990, tp: [4020] },
      rowsByBrokerSignal: new Map([['broker-1|anchor-1', rows]]),
      brokersById: new Map([['broker-1', broker]]),
      hasNewSl: true,
      hasNewTp: true,
      parsedTpLevels: [4020],
      liveMgmtFast: false,
    })

    assert.equal(result.allSynced, false)
    assert.equal(
      calls.upserts.some(c => c.table === 'basket_reconcile_jobs'),
      true,
      'mgmt modify must enqueue a reconcile job for the failed legs',
    )
  })
})

describe('BasketSlTpReconcileMonitor stale-claim recovery', () => {
  it('resets stale claimed jobs back to pending', async () => {
    const { supabase, calls } = makeMockSupabase()
    const monitor = new BasketSlTpReconcileMonitor(supabase as never)
    await (monitor as unknown as { reclaimStaleClaimedJobs: () => Promise<void> }).reclaimStaleClaimedJobs()

    const reclaim = calls.updates.find(
      c => c.table === 'basket_reconcile_jobs'
        && (c.payload as { status?: string }).status === 'pending',
    )
    assert.ok(reclaim, 'should issue a pending-reset update on basket_reconcile_jobs')
    assert.equal((reclaim!.payload as { locked_at?: unknown }).locked_at, null)
    assert.equal((reclaim!.payload as { locked_by?: unknown }).locked_by, null)
  })
})

describe('BasketSlTpReconcileMonitor ghost / empty snapshot guards', () => {
  it('treats an empty OpenedOrders snapshot as inconclusive (not all-closed)', () => {
    assert.equal(isEmptyOpenedOrdersInconclusive(0), true)
    assert.equal(isEmptyOpenedOrdersInconclusive(1), false)
  })

  it('closes the job when every open leg is absent from a non-empty snapshot', () => {
    assert.equal(isAllLegsGhostOnBroker({
      openLegs: 1,
      skippedNotOnBroker: 1,
      modified: 0,
      failed: 0,
    }), true)
    assert.equal(isAllLegsGhostOnBroker({
      openLegs: 2,
      skippedNotOnBroker: 2,
      modified: 0,
      failed: 0,
    }), true)
  })

  it('does not ghost-close when a leg modified, failed, or legs remain on broker', () => {
    assert.equal(isAllLegsGhostOnBroker({
      openLegs: 2,
      skippedNotOnBroker: 1,
      modified: 1,
      failed: 0,
    }), false, 'partial presence is not a ghost basket')
    assert.equal(isAllLegsGhostOnBroker({
      openLegs: 1,
      skippedNotOnBroker: 1,
      modified: 0,
      failed: 1,
    }), false, 'hard broker errors keep the retry path')
    assert.equal(isAllLegsGhostOnBroker({
      openLegs: 0,
      skippedNotOnBroker: 0,
      modified: 0,
      failed: 0,
    }), false, 'empty basket is handled by the no-legs early return')
    assert.equal(isAllLegsGhostOnBroker({
      openLegs: 1,
      skippedNotOnBroker: 0,
      modified: 1,
      failed: 0,
    }), false, 'ticket still on broker — normal success path')
  })
})
