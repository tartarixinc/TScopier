import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  allChannelModifySymbolBuckets,
  applyChannelStopsToBaskets,
  buildMgmtModifyFailureDiagnostic,
  brokerOrderSlMatchesTarget,
  groupLegsByBrokerSignal,
  logMgmtModifyBrokerSummaries,
  mgmtSlApplicableToMarket,
  mgmtUseChannelStopApply,
  verifyLegStopOnBroker,
} from './channelStopApply'
import type { BrokerBasketStopResult, ChannelStopBroker, ChannelStopLeg } from './channelStopApply'
import type { MgmtTradeRow } from './managementScope'

const FX_UUID = '11111111-1111-1111-1111-111111111111'

function chainableSupabase() {
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.insert = () => Promise.resolve({ data: null, error: null })
  builder.update = self
  builder.upsert = () => Promise.resolve({ data: { id: 'job-1' }, error: null })
  builder.delete = self
  builder.select = self
  builder.eq = self
  builder.in = self
  builder.order = self
  builder.limit = self
  builder.maybeSingle = () => Promise.resolve({ data: null, error: null })
  builder.single = () => Promise.resolve({ data: null, error: null })
  builder.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res)
  return { from: () => builder }
}

function recordingSupabase() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const upserts: Array<{ table: string; row: Record<string, unknown> }> = []

  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const self = () => b
    b.insert = (row: Record<string, unknown>) => {
      inserts.push({ table, row })
      return Promise.resolve({ data: null, error: null })
    }
    b.update = self
    b.upsert = (row: Record<string, unknown>) => {
      upserts.push({ table, row })
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
    b.limit = () => Promise.resolve({ data: [], error: null })
    b.maybeSingle = () => Promise.resolve({ data: null, error: null })
    b.single = () => Promise.resolve({ data: { id: 'job-1' }, error: null })
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res)
    return b
  }

  return { supabase: { from: (table: string) => builder(table) }, inserts, upserts }
}

function withFxsocketConfigured<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.FXSOCKET_API_KEY
  process.env.FXSOCKET_API_KEY = 'test-key'
  return fn().finally(() => {
    if (prevKey == null) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = prevKey
  })
}

function testBroker(): ChannelStopBroker {
  return {
    id: 'b1',
    platform: 'mt5',
    fxsocket_account_id: FX_UUID,
    manual_settings: { tp_lots: null },
  }
}

function testLeg(overrides: Partial<ChannelStopLeg> = {}): ChannelStopLeg {
  return {
    id: 't1',
    signal_id: 'anchor',
    broker_account_id: 'b1',
    metaapi_order_id: '1001',
    symbol: 'XAUUSD',
    direction: 'buy',
    sl: 4100,
    tp: 4300,
    opened_at: '2026-06-20T10:00:00Z',
    entry_price: 4150,
    telegram_channel_id: 'ch-1',
    ...overrides,
  }
}

function summaryResult(overrides: Partial<BrokerBasketStopResult> = {}): BrokerBasketStopResult {
  return {
    brokerId: 'b1',
    anchorSignalId: 'anchor',
    symbol: 'XAUUSD',
    direction: 'buy',
    openLegs: 1,
    attempted: 1,
    modified: 1,
    failed: 0,
    skipped: 0,
    verified: 1,
    errors: [],
    fullySynced: true,
    ...overrides,
  }
}

function tradeExecutionRows(inserts: Array<{ table: string; row: Record<string, unknown> }>) {
  return inserts
    .filter(i => i.table === 'trade_execution_logs')
    .map(i => i.row)
}

describe('channelStopApply', () => {
  it('mgmtUseChannelStopApply defaults to true', () => {
    const prev = process.env.MGMT_USE_CHANNEL_STOP_APPLY
    delete process.env.MGMT_USE_CHANNEL_STOP_APPLY
    assert.equal(mgmtUseChannelStopApply(), true)
    process.env.MGMT_USE_CHANNEL_STOP_APPLY = 'false'
    assert.equal(mgmtUseChannelStopApply(), false)
    if (prev == null) delete process.env.MGMT_USE_CHANNEL_STOP_APPLY
    else process.env.MGMT_USE_CHANNEL_STOP_APPLY = prev
  })

  it('groupLegsByBrokerSignal groups by broker and anchor', () => {
    const legs: ChannelStopLeg[] = [
      {
        id: '1',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        metaapi_order_id: '10',
        symbol: 'XAUUSD',
        direction: 'sell',
        sl: 4100,
        tp: 4200,
        opened_at: '2026-06-20T10:00:00Z',
        entry_price: 4115,
        telegram_channel_id: 'ch-1',
      },
      {
        id: '2',
        signal_id: 'sig-a',
        broker_account_id: 'b2',
        metaapi_order_id: '11',
        symbol: 'XAUUSD',
        direction: 'sell',
        sl: 4100,
        tp: 4200,
        opened_at: '2026-06-20T10:01:00Z',
        entry_price: 4115,
        telegram_channel_id: 'ch-1',
      },
    ]
    const grouped = groupLegsByBrokerSignal(legs)
    assert.equal(grouped.size, 2)
    assert.equal(grouped.get('b1|sig-a')?.length, 1)
    assert.equal(grouped.get('b2|sig-a')?.length, 1)
  })

  it('rejects a stop on the wrong side of the live market for its direction', () => {
    assert.equal(mgmtSlApplicableToMarket(4060, 4070, 4070.2, 'buy'), true)
    assert.equal(mgmtSlApplicableToMarket(4135, 4070, 4070.2, 'buy'), false)
    assert.equal(mgmtSlApplicableToMarket(4135, 4129, 4129.2, 'sell'), true)
    assert.equal(mgmtSlApplicableToMarket(4100, 4129, 4129.2, 'sell'), false)
  })

  it('skips a buy basket when the channel SL is above its entry', async () => {
    const legs: ChannelStopLeg[] = [testLeg({ id: 'buy-1', direction: 'buy', entry_price: 4119, sl: 4097.35 })]
    const broker = testBroker()
    let modifyCalls = 0
    const api = {
      seedPlatformCache: () => {},
      openedOrders: async () => [{ ticket: 1001, stopLoss: 4097.35 }],
      quote: async () => ({ bid: 4070, ask: 4070.2 }),
      orderModify: async () => {
        modifyCalls += 1
        return {}
      },
    }

    const { supabase } = recordingSupabase()
    const result = await applyChannelStopsToBaskets({
      supabase: supabase as never,
      apiFor: () => api as never,
      userId: 'user-1',
      channelId: 'ch-1',
      signalId: 'sig-mod',
      brokersById: new Map([['b1', broker]]),
      rowsByBrokerSignal: new Map([['b1|anchor', legs]]),
      hasNewSl: true,
      hasNewTp: false,
      parsedSl: 4135,
      parsedTpLevels: [],
      verifyOnBroker: false,
    })

    assert.equal(modifyCalls, 0, 'invalid buy stop must not be sent')
    assert.equal(result.totalModified, 0)
    assert.equal(result.totalSkipped, 1)
    assert.equal(result.brokers[0]?.errors[0]?.skipReason, 'sl_wrong_side')
  })

  it('skips the whole basket when the quote read fails (fail-closed, no blind SL)', async () => {
    const legs: ChannelStopLeg[] = [testLeg({ id: 'buy-1', direction: 'buy', entry_price: 4119, sl: 4097.35 })]
    const broker = testBroker()
    let modifyCalls = 0
    const api = {
      seedPlatformCache: () => {},
      quote: async () => { throw new Error('bridge timeout') },
      openedOrders: async () => [{ ticket: 1001, stopLoss: 4097.35 }],
      orderModify: async () => {
        modifyCalls += 1
        return {}
      },
    }

    const { supabase } = recordingSupabase()
    const result = await applyChannelStopsToBaskets({
      supabase: supabase as never,
      apiFor: () => api as never,
      userId: 'user-1',
      channelId: 'ch-1',
      signalId: 'sig-mod',
      brokersById: new Map([['b1', broker]]),
      rowsByBrokerSignal: new Map([['b1|anchor', legs]]),
      hasNewSl: true,
      hasNewTp: false,
      parsedSl: 4135,
      parsedTpLevels: [],
      verifyOnBroker: false,
    })

    assert.equal(modifyCalls, 0, 'no blind SL apply when the market side is unverifiable')
    assert.equal(result.totalModified, 0)
    assert.equal(result.totalSkipped, 1)
    assert.equal(result.brokers[0]?.errors[0]?.skipReason, 'sl_quote_unavailable')
  })

  it('does not apply the live-market guard to a pending stop order', async () => {
    // Pending Buy Stop: entry 4100, live bid 4070, SL 4085 sits above the
    // current market but below entry — a valid pending-stop SL. Judging it
    // against the live market (4085 < 4070 is false) would wrongly skip it, so
    // pending legs must bypass the live-market guard.
    const legs: ChannelStopLeg[] = [testLeg({ id: 'pending-1', status: 'pending', entry_price: 4100, sl: null, tp: null })]
    const broker = testBroker()
    let modifyCalls = 0
    const api = {
      seedPlatformCache: () => {},
      quote: async () => ({ bid: 4070, ask: 4070.2 }),
      openedOrders: async () => [{ ticket: 1001 }],
      orderModify: async () => {
        modifyCalls += 1
        return {}
      },
    }

    const { supabase } = recordingSupabase()
    const result = await applyChannelStopsToBaskets({
      supabase: supabase as never,
      apiFor: () => api as never,
      userId: 'user-1',
      channelId: 'ch-1',
      signalId: 'sig-mod',
      brokersById: new Map([['b1', broker]]),
      rowsByBrokerSignal: new Map([['b1|anchor', legs]]),
      hasNewSl: true,
      hasNewTp: false,
      parsedSl: 4085,
      parsedTpLevels: [],
      verifyOnBroker: false,
    })

    assert.equal(modifyCalls, 1, 'pending leg SL must be applied (guard exempt)')
    assert.equal(result.totalModified, 1)
    assert.equal(result.totalSkipped, 0)
  })

  it('verifyLegStopOnBroker compares broker order SL to target', () => {
    const map = new Map<number, unknown>([[100, { stopLoss: 4104 }]])
    assert.equal(verifyLegStopOnBroker(map, 100, 4104), true)
    assert.equal(verifyLegStopOnBroker(map, 100, 4100), false)
    assert.equal(brokerOrderSlMatchesTarget(4104, 4104), true)
  })

  it('allChannelModifySymbolBuckets returns every open trade for channel-wide modify', () => {
    const trades: MgmtTradeRow[] = [
      {
        id: 'g',
        signal_id: 'sig-1',
        broker_account_id: 'b1',
        metaapi_order_id: '1',
        symbol: 'XAUUSD',
        direction: 'sell',
        lot_size: 0.1,
        status: 'open',
        sl: null,
        tp: null,
        entry_price: 1,
        opened_at: '2026-01-01T10:00:00Z',
      },
      {
        id: 'e',
        signal_id: 'sig-1',
        broker_account_id: 'b1',
        metaapi_order_id: '2',
        symbol: 'EURUSD',
        direction: 'buy',
        lot_size: 0.1,
        status: 'open',
        sl: null,
        tp: null,
        entry_price: 1,
        opened_at: '2026-01-01T11:00:00Z',
      },
    ]
    assert.equal(allChannelModifySymbolBuckets(trades).length, 2)
  })

  it('modifies legs in parallel (faster mgmt on big baskets)', async () => {
    const prevKey = process.env.FXSOCKET_API_KEY
    process.env.FXSOCKET_API_KEY = 'test-key'
    const legs: ChannelStopLeg[] = Array.from({ length: 16 }, (_, i) => ({
      id: `t${i}`,
      signal_id: 'sig-a',
      broker_account_id: 'b1',
      metaapi_order_id: String(1000 + i),
      symbol: 'XAUUSD',
      direction: 'sell',
      sl: 4200,
      tp: 4100,
      opened_at: `2026-06-20T10:00:${String(i).padStart(2, '0')}Z`,
      entry_price: 4150,
      telegram_channel_id: 'ch-1',
    }))
    const broker: ChannelStopBroker = {
      id: 'b1',
      platform: 'mt5',
      fxsocket_account_id: FX_UUID,
      manual_settings: { tp_lots: null },
    }

    let inFlight = 0
    let maxConcurrent = 0
    let openedOrdersCalls = 0
    const attempted = new Set<number>()
    const api = {
      seedPlatformCache: () => {},
      quote: async () => ({ bid: 4150, ask: 4150.2 }),
      openedOrders: async () => {
        openedOrdersCalls += 1
        return legs.map(l => ({ ticket: Number(l.metaapi_order_id) }))
      },
      orderModify: async (_uuid: string, modifyArgs: { ticket: number }) => {
        attempted.add(modifyArgs.ticket)
        inFlight += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise(r => setTimeout(r, 10))
        inFlight -= 1
        return { stopLoss: 4180 }
      },
    }

    const result = await applyChannelStopsToBaskets({
      supabase: chainableSupabase() as never,
      apiFor: () => api as never,
      userId: 'user-1',
      channelId: 'ch-1',
      signalId: 'sig-mod',
      brokersById: new Map([['b1', broker]]),
      rowsByBrokerSignal: new Map([['b1|sig-a', legs]]),
      hasNewSl: true,
      hasNewTp: false,
      parsedSl: 4180,
      parsedTpLevels: [],
      verifyOnBroker: false,
    })

    if (prevKey == null) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = prevKey

    assert.equal(attempted.size, 16, 'all legs attempted')
    assert.equal(result.totalModified, 16)
    assert.ok(maxConcurrent > 1, `expected parallel modifies, got max concurrency ${maxConcurrent}`)
    assert.equal(openedOrdersCalls, 1, 'single OpenedOrders snapshot (no duplicate fetch)')
  })

  it('does NOT repaint TP after a TP hit (freeze keeps existing leg TP)', async () => {
    const prevKey = process.env.FXSOCKET_API_KEY
    process.env.FXSOCKET_API_KEY = 'test-key'
    const legs: ChannelStopLeg[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      signal_id: 'anchor',
      broker_account_id: 'b1',
      metaapi_order_id: String(2000 + i),
      symbol: 'XAUUSD',
      direction: 'buy',
      sl: null,
      tp: 4200, // existing TP on each open leg
      opened_at: `2026-06-20T10:00:0${i}Z`,
      entry_price: 4150,
      telegram_channel_id: 'ch-1',
    }))
    const broker: ChannelStopBroker = { id: 'b1', platform: 'mt5', fxsocket_account_id: FX_UUID, manual_settings: { tp_lots: null } }

    const modifiedTps: number[] = []
    const api = {
      seedPlatformCache: () => {},
      quote: async () => ({ bid: 4250, ask: 4250.2 }),
      openedOrders: async () => legs.map(l => ({ ticket: Number(l.metaapi_order_id) })),
      orderModify: async (_uuid: string, a: { takeprofit?: number }) => {
        if (a.takeprofit != null) modifiedTps.push(a.takeprofit)
        return { stopLoss: 4180, takeProfit: a.takeprofit }
      },
    }

    // Supabase where hasClosedBasketLegs returns a closed leg -> basket frozen.
    function frozenSupabase() {
      function builder(table: string) {
        const b: Record<string, unknown> = {}
        const self = () => b
        b.insert = () => Promise.resolve({ data: null, error: null })
        b.update = self
        b.upsert = () => Promise.resolve({ data: { id: 'job' }, error: null })
        b.delete = self; b.select = self; b.eq = self; b.in = self
        b.lte = self; b.lt = self; b.gte = self; b.not = self; b.ilike = self; b.order = self
        b.limit = () => Promise.resolve({ data: table === 'trades' ? [{ id: 'closed-1' }] : [], error: null })
        b.maybeSingle = () => Promise.resolve({ data: null, error: null })
        b.single = () => Promise.resolve({ data: { id: 'job' }, error: null })
        b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res)
        return b
      }
      return { from: (t: string) => builder(t) }
    }

    await applyChannelStopsToBaskets({
      supabase: frozenSupabase() as never,
      apiFor: () => api as never,
      userId: 'u', channelId: 'ch-1', signalId: 'mod-1',
      brokersById: new Map([['b1', broker]]),
      rowsByBrokerSignal: new Map([['b1|anchor', legs]]),
      // Channel sends a NEW TP ladder after the TP hit — must be ignored on open legs.
      hasNewSl: true, hasNewTp: true, parsedSl: 4180, parsedTpLevels: [4300, 4310, 4320], verifyOnBroker: false,
    })

    if (prevKey == null) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = prevKey

    assert.ok(modifiedTps.length > 0, 'legs were modified')
    assert.ok(
      modifiedTps.every(tp => tp === 4200),
      `frozen basket must keep existing TP 4200, got ${JSON.stringify([...new Set(modifiedTps)])}`,
    )
  })

  it('logs summary success for all legs successfully modified', async () => {
    await withFxsocketConfigured(async () => {
      const { supabase, inserts } = recordingSupabase()
      const leg = testLeg({ sl: 4100, metaapi_order_id: '1001' })
      const api = {
        seedPlatformCache: () => {},
        quote: async () => ({ bid: 4250, ask: 4250.2 }),
        openedOrders: async () => [{ ticket: 1001, stopLoss: 4100 }],
        orderModify: async () => ({ stopLoss: 4180 }),
      }

      const result = await applyChannelStopsToBaskets({
        supabase: supabase as never,
        apiFor: () => api as never,
        userId: 'user-1',
        channelId: 'ch-1',
        signalId: 'sig-mod',
        brokersById: new Map([['b1', testBroker()]]),
        rowsByBrokerSignal: new Map([['b1|anchor', [leg]]]),
        hasNewSl: true,
        hasNewTp: false,
        parsedSl: 4180,
        parsedTpLevels: [],
        verifyOnBroker: false,
      })
      await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', result.brokers)

      const summary = tradeExecutionRows(inserts).find(row => row.action === 'mgmt_modify_broker_summary')
      assert.equal(summary?.status, 'success')
      const payload = summary?.request_payload as Record<string, unknown>
      assert.equal(payload.fully_synced, true)
      assert.equal(payload.modified, 1)
      assert.equal(payload.retry_expected, false)
      assert.equal(payload.retry_pending, false)
      assert.equal(payload.reconcile_requested, false)
      assert.equal(payload.reason_code, undefined)
    })
  })

  it('logs summary success for already-at-target broker-verified legs', async () => {
    await withFxsocketConfigured(async () => {
      const { supabase, inserts } = recordingSupabase()
      let orderModifyCalls = 0
      const leg = testLeg({ sl: 4180, metaapi_order_id: '1001' })
      const api = {
        seedPlatformCache: () => {},
        quote: async () => ({ bid: 4250, ask: 4250.2 }),
        openedOrders: async () => [{ ticket: 1001, stopLoss: 4180 }],
        orderModify: async () => {
          orderModifyCalls += 1
          return { stopLoss: 4180 }
        },
      }

      const result = await applyChannelStopsToBaskets({
        supabase: supabase as never,
        apiFor: () => api as never,
        userId: 'user-1',
        channelId: 'ch-1',
        signalId: 'sig-mod',
        brokersById: new Map([['b1', testBroker()]]),
        rowsByBrokerSignal: new Map([['b1|anchor', [leg]]]),
        hasNewSl: true,
        hasNewTp: false,
        parsedSl: 4180,
        parsedTpLevels: [],
        verifyOnBroker: true,
      })
      await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', result.brokers)

      assert.equal(orderModifyCalls, 0)
      const summary = tradeExecutionRows(inserts).find(row => row.action === 'mgmt_modify_broker_summary')
      assert.equal(summary?.status, 'success')
      const payload = summary?.request_payload as Record<string, unknown>
      assert.equal(payload.verified, 1)
      assert.equal(payload.fully_synced, true)
    })
  })

  it('persists safe structured reason for one failed invalid-stops leg without raw text in payload', async () => {
    await withFxsocketConfigured(async () => {
      const { supabase, inserts } = recordingSupabase()
      const raw = 'Invalid stops token=SECRET-123 session=abc'
      const leg = testLeg({ metaapi_order_id: '1001' })
      const api = {
        seedPlatformCache: () => {},
        quote: async () => ({ bid: 4250, ask: 4250.2 }),
        openedOrders: async () => [{ ticket: 1001, stopLoss: 4100 }],
        orderModify: async () => {
          throw new Error(raw)
        },
      }

      const result = await applyChannelStopsToBaskets({
        supabase: supabase as never,
        apiFor: () => api as never,
        userId: 'user-1',
        channelId: 'ch-1',
        signalId: 'sig-mod',
        brokersById: new Map([['b1', testBroker()]]),
        rowsByBrokerSignal: new Map([['b1|anchor', [leg]]]),
        hasNewSl: true,
        hasNewTp: false,
        parsedSl: 4180,
        parsedTpLevels: [],
        verifyOnBroker: false,
      })
      await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', result.brokers)

      const rows = tradeExecutionRows(inserts)
      const child = rows.find(row => row.action === 'mgmt_modify')
      assert.equal(child?.status, 'failed')
      assert.equal(child?.error_message, raw)
      const childPayload = child?.request_payload as Record<string, unknown>
      assert.equal(childPayload.reason_code, 'INVALID_STOPS')
      assert.equal(JSON.stringify(childPayload).includes('SECRET-123'), false)

      const summary = rows.find(row => row.action === 'mgmt_modify_broker_summary')
      assert.equal(summary?.status, 'failed')
      const payload = summary?.request_payload as Record<string, unknown>
      assert.equal(payload.reason_code, 'MANAGEMENT_MODIFY_PARTIAL')
      assert.equal(payload.primary_underlying_reason_code, 'INVALID_STOPS')
      assert.equal(payload.failed, 1)
      assert.equal(JSON.stringify(payload).includes('SECRET-123'), false)
    })
  })

  it('classifies no broker session as broker account unavailable', () => {
    const diagnostic = buildMgmtModifyFailureDiagnostic({
      message: 'no broker session',
      skipReason: 'no_session',
    })
    assert.equal(diagnostic.reason_code, 'BROKER_ACCOUNT_UNAVAILABLE')
    assert.equal(diagnostic.failure_reason, 'NO_BROKER_SESSION')
    assert.equal(diagnostic.failure_phase, 'broker_session')
  })

  it('logs safe no-session summary even when no ticketed open legs were counted', async () => {
    const { supabase, inserts } = recordingSupabase()
    await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', [
      summaryResult({
        openLegs: 0,
        attempted: 0,
        modified: 0,
        verified: 0,
        failed: 0,
        skipped: 2,
        fullySynced: false,
        errors: [{ tradeId: '', ticket: 0, message: 'no broker session', skipReason: 'no_session' }],
      }),
    ])

    const row = tradeExecutionRows(inserts)[0]!
    assert.equal(row.status, 'failed')
    const payload = row.request_payload as Record<string, unknown>
    assert.equal(payload.open_legs, 0)
    assert.equal(payload.skipped, 2)
    assert.equal(payload.reason_code, 'MANAGEMENT_MODIFY_PARTIAL')
    assert.equal(payload.primary_underlying_reason_code, 'BROKER_ACCOUNT_UNAVAILABLE')
    assert.equal(payload.failure_reason, 'NO_BROKER_SESSION')
    assert.equal(payload.retry_expected, false)
    assert.equal(payload.retry_pending, false)
    assert.equal(payload.reconcile_requested, false)
  })

  it('persists broker verification failure as safe structured metadata', async () => {
    await withFxsocketConfigured(async () => {
      const { supabase, inserts } = recordingSupabase()
      const leg = testLeg({ metaapi_order_id: '1001' })
      const api = {
        seedPlatformCache: () => {},
        quote: async () => ({ bid: 4250, ask: 4250.2 }),
        openedOrders: async () => [{ ticket: 1001, stopLoss: 4100 }],
        orderModify: async () => ({ stopLoss: 4180 }),
      }

      const result = await applyChannelStopsToBaskets({
        supabase: supabase as never,
        apiFor: () => api as never,
        userId: 'user-1',
        channelId: 'ch-1',
        signalId: 'sig-mod',
        brokersById: new Map([['b1', testBroker()]]),
        rowsByBrokerSignal: new Map([['b1|anchor', [leg]]]),
        hasNewSl: true,
        hasNewTp: false,
        parsedSl: 4180,
        parsedTpLevels: [],
        verifyOnBroker: true,
      })
      await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', result.brokers)

      const child = tradeExecutionRows(inserts).find(row => row.action === 'mgmt_modify')
      const payload = child?.request_payload as Record<string, unknown>
      assert.equal(payload.reason_code, 'BROKER_ORDER_REJECTED')
      assert.equal(payload.failure_reason, 'BROKER_VERIFY_FAILED')
      assert.equal(payload.skip_reason, 'broker_verify_failed')
    })
  })

  it('selects deterministic primary reason and bounded mixed-failure metadata', async () => {
    const { supabase, inserts } = recordingSupabase()
    await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', [
      summaryResult({
        openLegs: 12,
        attempted: 12,
        modified: 2,
        verified: 2,
        failed: 10,
        skipped: 0,
        fullySynced: false,
        errors: Array.from({ length: 12 }, (_, i) => ({
          tradeId: `t${i}`,
          ticket: 1000 + i,
          message: i === 0 ? 'TradingHelper.OrderModify timed out' : 'Invalid stops token=SECRET',
        })),
      }),
    ])

    const payload = tradeExecutionRows(inserts)[0]!.request_payload as Record<string, unknown>
    assert.equal(payload.reason_code, 'MANAGEMENT_MODIFY_PARTIAL')
    assert.equal(payload.primary_underlying_reason_code, 'INVALID_STOPS')
    assert.deepEqual(payload.underlying_reason_codes, ['INVALID_STOPS', 'BROKER_TIMEOUT'])
    assert.equal(payload.mixed_failure, true)
    assert.equal((payload.leg_failures as unknown[]).length, 10)
    assert.equal(payload.truncated_leg_failures, true)
    assert.equal(JSON.stringify(payload).includes('SECRET'), false)
  })

  it('keeps historical failed summary and later success identifiable for Admin recovery grouping', async () => {
    const { supabase, inserts } = recordingSupabase()
    await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', [
      summaryResult({
        modified: 0,
        verified: 0,
        failed: 1,
        fullySynced: false,
        errors: [{ tradeId: 't1', ticket: 1001, message: 'Invalid stops' }],
      }),
    ])
    await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', [
      summaryResult({ modified: 1, verified: 1, fullySynced: true }),
    ])

    const rows = tradeExecutionRows(inserts)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.status, 'failed')
    assert.equal(rows[1]!.status, 'success')
    for (const row of rows) {
      assert.equal(row.signal_id, 'sig-mod')
      assert.equal(row.broker_account_id, 'b1')
      const payload = row.request_payload as Record<string, unknown>
      assert.equal(payload.anchor_signal_id, 'anchor')
      assert.equal(payload.fully_synced, row.status === 'success')
    }
  })

  it('marks partial success summaries failed with correct counts and retry metadata', async () => {
    const { supabase, inserts } = recordingSupabase()
    await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', [
      summaryResult({
        openLegs: 2,
        attempted: 2,
        modified: 1,
        verified: 1,
        failed: 1,
        skipped: 0,
        fullySynced: false,
        errors: [{ tradeId: 't2', ticket: 1002, message: 'Invalid stops' }],
      }),
    ])

    const row = tradeExecutionRows(inserts)[0]!
    assert.equal(row.status, 'failed')
    const payload = row.request_payload as Record<string, unknown>
    assert.equal(payload.open_legs, 2)
    assert.equal(payload.modified, 1)
    assert.equal(payload.verified, 1)
    assert.equal(payload.failed, 1)
    assert.equal(payload.partial_failure, true)
    assert.equal(payload.retry_expected, true)
    assert.equal(payload.retry_pending, true)
    assert.equal(payload.reconcile_requested, true)
  })

  it('uses neutral unknown classification when a failed summary has no leg errors', async () => {
    const { supabase, inserts } = recordingSupabase()
    await logMgmtModifyBrokerSummaries(supabase as never, 'user-1', 'sig-mod', [
      summaryResult({
        openLegs: 2,
        attempted: 2,
        modified: 1,
        verified: 0,
        failed: 0,
        skipped: 1,
        fullySynced: false,
        errors: [],
      }),
    ])

    const payload = tradeExecutionRows(inserts)[0]!.request_payload as Record<string, unknown>
    assert.equal(payload.reason_code, 'MANAGEMENT_MODIFY_PARTIAL')
    assert.equal(payload.primary_underlying_reason_code, 'UNKNOWN')
    assert.deepEqual(payload.underlying_reason_codes, ['UNKNOWN'])
    assert.deepEqual(payload.leg_failures, [])
  })
})
