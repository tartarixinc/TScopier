import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  allChannelModifySymbolBuckets,
  applyChannelStopsToBaskets,
  brokerOrderSlMatchesTarget,
  groupLegsByBrokerSignal,
  mgmtUseChannelStopApply,
  verifyLegStopOnBroker,
} from './channelStopApply'
import type { ChannelStopBroker, ChannelStopLeg } from './channelStopApply'
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
})
