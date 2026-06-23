import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { replaySignalsAfterListenerRecovery } from './listenerSignalReplay'
import { invalidateCopierPauseCache, setUserCopierPausedCached } from './copierPause'
import type { TradeExecutorContext } from './tradeExecutor/context'
import type { QueuedSignal, SignalRow } from './tradeExecutor/types'

const userId = 'user-1'
const chA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function mockExecutor(signals: SignalRow[]): TradeExecutorContext {
  const highPriorityQueue: QueuedSignal[] = []
  const normalPriorityQueue: QueuedSignal[] = []
  const queuedIds = new Set<string>()

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
        if (table === 'signal_range_entry_waits') {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ count: 0, error: null }),
              }),
            }),
          }
        }
        if (table === 'signals') {
          return {
            update: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    gte: async () => ({ error: null }),
                  }),
                }),
              }),
            }),
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
        }
        throw new Error(`unexpected table ${table}`)
      },
    },
    brokersByUser: new Map([[userId, []]]),
    inflight: new Set<string>(),
    queuedIds,
    highPriorityQueue,
    normalPriorityQueue,
    queueDrainScheduled: false,
    scheduleQueueDrain: () => {},
    signalAlreadyHandled: async () => false,
    markSignalExecuted: async () => {},
  } as unknown as TradeExecutorContext

  return ctx
}

describe('listenerSignalReplay', () => {
  it('replays parsed signals for user after listener lease recovery', async () => {
    invalidateCopierPauseCache()
    setUserCopierPausedCached(userId, false)
    const signals = [
      {
        id: 'sig-1',
        user_id: userId,
        channel_id: chA,
        status: 'parsed',
        parsed_data: { action: 'sell', symbol: 'XAUUSD' },
        created_at: new Date().toISOString(),
      },
    ] as SignalRow[]
    const ctx = mockExecutor(signals)
    const enqueued = await replaySignalsAfterListenerRecovery(ctx, userId)
    assert.equal(enqueued, 1)
    assert.equal(ctx.queuedIds.has('sig-1'), true)
  })
})
