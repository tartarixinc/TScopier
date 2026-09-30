import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { forceCloseSignalById, forceCloseSignalTrades } from './forceCloseSignalTrades'

function chainQuery<T>(data: T, error: { message: string } | null = null) {
  const result = Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null })
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => result,
    insert: () => Promise.resolve({ data: null, error: null }),
    update: () => chain,
    then: result.then.bind(result),
    catch: result.catch.bind(result),
  }
  return chain
}

describe('forceCloseSignalTrades', () => {
  const originalKey = process.env.FXSOCKET_API_KEY

  test('returns broker_not_found when broker missing', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const supabase = {
      from(table: string) {
        if (table === 'broker_accounts') return chainQuery(null)
        throw new Error(`unexpected table ${table}`)
      },
    }
    const result = await forceCloseSignalTrades(supabase as never, {
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      channelId: 'ch-1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'broker_not_found')
    if (originalKey === undefined) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = originalKey
  })

  test('returns channel_not_linked when channel not on broker', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    const supabase = {
      from(table: string) {
        if (table === 'broker_accounts') {
          return chainQuery({
            id: 'broker-1',
            user_id: 'user-1',
            fxsocket_account_id: '00000000-0000-4000-8000-000000000001',
            signal_channel_ids: ['other-ch'],
          })
        }
        throw new Error(`unexpected table ${table}`)
      },
    }
    const result = await forceCloseSignalTrades(supabase as never, {
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      channelId: 'ch-1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'channel_not_linked')
    if (originalKey === undefined) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = originalKey
  })

  test('returns no_open_channels when close-all finds nothing', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      const supabase = {
        from(table: string) {
          if (table === 'broker_accounts') {
            return chainQuery({
              id: 'broker-1',
              user_id: 'user-1',
              fxsocket_account_id: '00000000-0000-4000-8000-000000000001',
              signal_channel_ids: ['ch-1'],
            })
          }
          if (table === 'trades') return chainQuery([])
          if (table === 'trade_channel_attributions') return chainQuery([])
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalTrades(supabase as never, {
        userId: 'user-1',
        brokerAccountId: 'broker-1',
      })
      assert.equal(result.ok, true)
      assert.equal(result.reason, 'no_open_channels')
      assert.equal(result.channels_processed, 0)
    } finally {
      if (originalKey === undefined) delete process.env.FXSOCKET_API_KEY
      else process.env.FXSOCKET_API_KEY = originalKey
    }
  })
})

describe('forceCloseSignalById', () => {
  const originalKey = process.env.FXSOCKET_API_KEY

  function restoreKey() {
    if (originalKey === undefined) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = originalKey
  }

  test('returns broker_api_not_configured when FXSOCKET_API_KEY missing', async () => {
    delete process.env.FXSOCKET_API_KEY
    try {
      const supabase = { from() { throw new Error('should not query') } }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'broker_api_not_configured')
    } finally {
      restoreKey()
    }
  })

  test('returns signal_not_found when signal missing', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      const supabase = {
        from(table: string) {
          if (table === 'signals') return chainQuery(null)
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'signal_not_found')
    } finally {
      restoreKey()
    }
  })

  test('returns no_open_trades when signal has no open legs', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      const supabase = {
        from(table: string) {
          if (table === 'signals') {
            return chainQuery({ id: 'sig-1', user_id: 'user-1', channel_id: 'ch-1' })
          }
          if (table === 'trades') return chainQuery([])
          if (table === 'range_pending_legs') return chainQuery([])
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, true)
      assert.equal(result.reason, 'no_open_trades')
      assert.equal(result.closed, 0)
      assert.equal(result.channels_processed, 0)
    } finally {
      restoreKey()
    }
  })

  test('signal lookup DB error returns close_failed, not signal_not_found', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      const supabase = {
        from(table: string) {
          if (table === 'signals') return chainQuery(null, { message: 'connection reset' })
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'close_failed')
      assert.equal(result.error, 'connection reset')
    } finally {
      restoreKey()
    }
  })

  test('broker discovery DB error returns close_failed, not no_open_trades', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      const supabase = {
        from(table: string) {
          if (table === 'signals') {
            return chainQuery({ id: 'sig-1', user_id: 'user-1', channel_id: 'ch-1' })
          }
          if (table === 'trades') return chainQuery(null, { message: 'db timeout' })
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'close_failed')
      assert.equal(result.error, 'db timeout')
    } finally {
      restoreKey()
    }
  })

  test('leg-load DB error returns close_failed, not no_open_trades', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      let tradesCalls = 0
      const supabase = {
        from(table: string) {
          if (table === 'signals') {
            return chainQuery({ id: 'sig-1', user_id: 'user-1', channel_id: 'ch-1' })
          }
          if (table === 'trades') {
            // call 1 = broker discovery (OK), call 2 = leg load (fails).
            tradesCalls += 1
            const data = tradesCalls === 1 ? [{ broker_account_id: 'b-1' }] : null
            const error = tradesCalls === 1 ? null : { message: 'leg load failed' }
            return chainQuery(data, error)
          }
          if (table === 'range_pending_legs') return chainQuery([])
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'close_failed')
      assert.equal(result.error, 'leg load failed')
      assert.equal(tradesCalls >= 2, true, `expected discovery + leg load, saw ${tradesCalls}`)
    } finally {
      restoreKey()
    }
  })
})

describe('forceCloseSignalById ownership + session guards', () => {
  const originalKey = process.env.FXSOCKET_API_KEY

  function restoreKey() {
    if (originalKey === undefined) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = originalKey
  }

  function recordingChain<T>(data: T, eqCalls: string[][]) {
    const result = Promise.resolve({ data, error: null, count: Array.isArray(data) ? data.length : null })
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => { eqCalls.push([col, String(val)]); return chain },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => result,
      insert: () => Promise.resolve({ data: null, error: null }),
      update: () => chain,
      then: result.then.bind(result),
      catch: result.catch.bind(result),
    }
    return chain
  }

  test('signal lookup is filtered by user_id (ownership)', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      const eqCalls: string[][] = []
      const supabase = {
        from(table: string) {
          if (table === 'signals') return recordingChain(null, eqCalls)
          throw new Error(`unexpected table ${table}`)
        },
      }
      await forceCloseSignalById(supabase as never, { userId: 'user-1', signalId: 'sig-1' })
      assert.ok(
        eqCalls.some(([col, val]) => col === 'user_id' && val === 'user-1'),
        `expected user_id filter, saw: ${JSON.stringify(eqCalls)}`,
      )
    } finally {
      restoreKey()
    }
  })

  test('returns broker_not_connected when broker holds legs but has no session', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      let tradesCalls = 0
      const tradeLeg = {
        id: 't-1',
        signal_id: 'sig-1',
        broker_account_id: 'b-1',
        metaapi_order_id: '12345',
        symbol: 'XAUUSD',
        direction: 'buy',
        lot_size: 0.01,
        status: 'open',
        sl: null,
        tp: null,
        entry_price: 1000,
        opened_at: '2026-09-24T00:00:00Z',
        cwe_close_price: null,
      }
      const supabase = {
        from(table: string) {
          if (table === 'signals') {
            const result = Promise.resolve({
              data: { id: 'sig-1', user_id: 'user-1', channel_id: 'ch-1' },
              error: null,
            })
            return {
              select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => result }) }) }),
            }
          }
          if (table === 'trades') {
            tradesCalls += 1
            const data = tradesCalls === 1
              ? [{ broker_account_id: 'b-1' }]
              : [tradeLeg]
            const result = Promise.resolve({ data, error: null, count: data.length })
            const chain = {
              select: () => chain,
              eq: () => chain,
              in: () => chain,
              order: () => chain,
              limit: () => chain,
              maybeSingle: () => result,
              insert: () => Promise.resolve({ data: null, error: null }),
              update: () => chain,
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
            return chain
          }
          if (table === 'range_pending_legs') {
            const result = Promise.resolve({ data: [], error: null, count: 0 })
            const chain = {
              select: () => chain,
              eq: () => chain,
              in: () => chain,
              delete: () => chain,
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
            return chain
          }
          if (table === 'trade_execution_logs') {
            return { insert: () => Promise.resolve({ data: null, error: null }) }
          }
          if (table === 'broker_accounts') {
            const result = Promise.resolve({
              data: [{
                id: 'b-1',
                user_id: 'user-1',
                provider: 'mtapi',
                platform: 'mt5',
                mtapi_session_id: null,
                fxsocket_account_id: null,
                metaapi_account_id: null,
              }],
              error: null,
              count: 1,
            })
            const chain = {
              select: () => chain,
              eq: () => chain,
              in: () => chain,
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
            return chain
          }
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'broker_not_connected')
      assert.equal(result.failed, 1)
      assert.equal(result.channels_processed, 0)
    } finally {
      restoreKey()
    }
  })

  test('skipped broker still has queued legs swept (DB-level)', async () => {
    process.env.FXSOCKET_API_KEY = 'test-key'
    try {
      let legCalls = 0
      const eqCalls: string[][] = []
      const supabase = {
        from(table: string) {
          if (table === 'signals') {
            const result = Promise.resolve({
              data: { id: 'sig-1', user_id: 'user-1', channel_id: 'ch-1' },
              error: null,
            })
            return {
              select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => result }) }) }),
            }
          }
          if (table === 'trades') {
            const result = Promise.resolve({ data: [], error: null, count: 0 })
            const chain = {
              select: () => chain,
              eq: (col: string, val: unknown) => { eqCalls.push([`trades.${col}`, String(val)]); return chain },
              in: () => chain,
              order: () => chain,
              limit: () => chain,
              maybeSingle: () => result,
              insert: () => Promise.resolve({ data: null, error: null }),
              update: () => chain,
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
            return chain
          }
          if (table === 'range_pending_legs') {
            // call 1 = broker-union discovery, call 2 = broker-side cancel
            // (empty: status broker_pending only), call 3 = DB delete sweep.
            legCalls += 1
            const data = legCalls === 1
              ? [{ broker_account_id: 'b-1' }]
              : legCalls === 2
                ? []
                : [{ id: 'leg-1' }]
            const result = Promise.resolve({ data, error: null, count: data.length })
            const chain = {
              select: () => chain,
              eq: (col: string, val: unknown) => { eqCalls.push([`legs.${col}`, String(val)]); return chain },
              in: () => chain,
              delete: () => chain,
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
            return chain
          }
          if (table === 'broker_accounts') {
            const result = Promise.resolve({
              data: [{
                id: 'b-1',
                user_id: 'user-1',
                provider: 'mtapi',
                platform: 'mt5',
                mtapi_session_id: null,
                fxsocket_account_id: null,
                metaapi_account_id: null,
              }],
              error: null,
              count: 1,
            })
            const chain = {
              select: () => chain,
              eq: (col: string, val: unknown) => { eqCalls.push([`brokers.${col}`, String(val)]); return chain },
              in: () => chain,
              then: result.then.bind(result),
              catch: result.catch.bind(result),
            }
            return chain
          }
          if (table === 'trade_execution_logs') {
            return { insert: () => Promise.resolve({ data: null, error: null }) }
          }
          throw new Error(`unexpected table ${table}`)
        },
      }
      const result = await forceCloseSignalById(supabase as never, {
        userId: 'user-1',
        signalId: 'sig-1',
      })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'broker_not_connected')
      assert.equal(result.failed, 0)
      assert.equal(result.virtual_legs_deleted, 1)
      assert.equal(result.channels_processed, 0)
      assert.equal(legCalls >= 3, true, `expected union+cancel+delete, saw ${legCalls} calls`)
      for (const prefix of ['trades.', 'legs.', 'brokers.']) {
        assert.ok(
          eqCalls.some(([col, val]) => col === `${prefix}user_id` && val === 'user-1'),
          `expected ${prefix}user_id filter, saw: ${JSON.stringify(eqCalls)}`,
        )
      }
    } finally {
      restoreKey()
    }
  })
})
