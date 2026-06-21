import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRangeLayerTillCloseEnabled,
  stopRangeLayeringUnlessEnabled,
} from './rangeLayerTillClose'

describe('isRangeLayerTillCloseEnabled', () => {
  it('returns false when unset or false', () => {
    assert.equal(isRangeLayerTillCloseEnabled(null), false)
    assert.equal(isRangeLayerTillCloseEnabled({}), false)
    assert.equal(isRangeLayerTillCloseEnabled({ range_layer_till_close: false }), false)
  })

  it('returns true only when explicitly enabled', () => {
    assert.equal(isRangeLayerTillCloseEnabled({ range_layer_till_close: true }), true)
  })
})

describe('stopRangeLayeringUnlessEnabled', () => {
  it('no-ops when layer till close is enabled', async () => {
    let deleted = false
    const supabase = {
      from(table: string) {
        if (table === 'signals') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { channel_id: 'ch-1' },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'broker_accounts') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    manual_settings: { range_layer_till_close: true },
                    channel_trading_configs: {},
                  },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'range_pending_legs') {
          deleted = true
        }
        return {}
      },
    }
    const out = await stopRangeLayeringUnlessEnabled(
      supabase as never,
      { signalId: 'sig-1', brokerAccountId: 'broker-1', symbol: 'XAUUSD', userId: 'user-1' },
      'test',
    )
    assert.equal(out.stopped, false)
    assert.equal(deleted, false)
  })

  it('deletes pendings and sets lock when disabled and basket still open', async () => {
    const calls: string[] = []
    const supabase = {
      from(table: string) {
        if (table === 'signals') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { channel_id: 'ch-1' },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'broker_accounts') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    manual_settings: { range_layer_till_close: false },
                    channel_trading_configs: {},
                    copier_mode: 'manual',
                    ai_settings: {},
                    signal_channel_ids: [],
                  },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'trades') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: async () => ({ count: 2, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'range_pending_legs') {
          calls.push('delete')
          return {
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    select: async () => ({ data: [{ id: 'leg-1' }], error: null }),
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'range_pending_tp_locks') {
          calls.push('lock')
          return {
            upsert: async () => ({ error: null }),
          }
        }
        return {}
      },
    }
    const out = await stopRangeLayeringUnlessEnabled(
      supabase as never,
      { signalId: 'sig-1', brokerAccountId: 'broker-1', symbol: 'XAUUSD', userId: 'user-1' },
      'partial_tp_close',
    )
    assert.equal(out.stopped, true)
    assert.equal(out.deleted, 1)
    assert.deepEqual(calls, ['delete', 'lock'])
  })
})
