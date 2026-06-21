import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { forceCloseSignalTrades } from './forceCloseSignalTrades'

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
