import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clearBrokerSessionBlock, replayParsedSignalsForBroker } from './brokerSignalReplay'
import { invalidateCopierPauseCache, setUserCopierPausedCached } from './copierPause'
import type { TradeExecutorContext } from './tradeExecutor/context'
import type { BrokerRow, QueuedSignal, SignalRow } from './tradeExecutor/types'

const chA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function mockExecutor(overrides?: Partial<TradeExecutorContext>): TradeExecutorContext {
  const highPriorityQueue: QueuedSignal[] = []
  const normalPriorityQueue: QueuedSignal[] = []
  const queuedIds = new Set<string>()
  const sessionOrderBlocked = new Set<string>()
  const brokerActivatedAt = new Map<string, number>()
  const inflight = new Set<string>()

  const broker = {
    id: 'broker-1',
    user_id: 'user-1',
    is_active: true,
    metaapi_account_id: 'uuid-1',
    platform: 'mt5',
    connection_status: 'connected',
    enforce_signal_channel_filter: true,
    signal_channel_ids: [chA],
  } as BrokerRow

  const signals = [
    {
      id: 'sig-1',
      user_id: 'user-1',
      channel_id: chA,
      status: 'parsed',
      parsed_data: { action: 'buy', symbol: 'XAUUSD' },
      created_at: new Date().toISOString(),
    },
    {
      id: 'sig-2',
      user_id: 'user-1',
      channel_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      status: 'parsed',
      parsed_data: { action: 'sell', symbol: 'XAUUSD' },
      created_at: new Date().toISOString(),
    },
  ] as SignalRow[]

  const ctx = {
    supabase: {
      from: (table: string) => {
        if (table === 'user_profiles') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { copier_paused: false }, error: null }),
              }),
            }),
          }
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  order: () => ({
                    limit: async () => ({ data: signals, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }
      },
    },
    brokersById: new Map([[broker.id, broker]]),
    brokersByUser: new Map([[broker.user_id, [broker]]]),
    brokerActivatedAt,
    sessionOrderBlocked,
    inflight,
    queuedIds,
    highPriorityQueue,
    normalPriorityQueue,
    queueDrainScheduled: false,
    scheduleQueueDrain: () => {},
    ...overrides,
  } as unknown as TradeExecutorContext

  return ctx
}

describe('brokerSignalReplay', () => {
  it('clearBrokerSessionBlock removes in-memory block flag', () => {
    const ctx = mockExecutor()
    ctx.sessionOrderBlocked.add('broker-1')
    assert.equal(clearBrokerSessionBlock(ctx, { id: 'broker-1' } as BrokerRow), true)
    assert.equal(ctx.sessionOrderBlocked.has('broker-1'), false)
  })

  it('replays parsed signals for linked channels only', async () => {
    invalidateCopierPauseCache()
    setUserCopierPausedCached('user-1', false)
    const ctx = mockExecutor()
    const enqueued = await replayParsedSignalsForBroker(ctx, {
      id: 'broker-1',
      user_id: 'user-1',
      is_active: true,
      enforce_signal_channel_filter: true,
      signal_channel_ids: [chA],
    } as BrokerRow)
    assert.equal(enqueued, 1)
    assert.equal(ctx.queuedIds.has('sig-1'), true)
    assert.equal(ctx.queuedIds.has('sig-2'), false)
  })

  it('skips replay for paused brokers', async () => {
    const ctx = mockExecutor()
    const enqueued = await replayParsedSignalsForBroker(ctx, {
      id: 'broker-1',
      user_id: 'user-1',
      is_active: false,
      signal_channel_ids: [chA],
    } as BrokerRow)
    assert.equal(enqueued, 0)
    assert.equal(ctx.queuedIds.size, 0)
  })
})
