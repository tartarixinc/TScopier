import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applySignalOverride } from './applySignalOverride'

function chainQuery<T>(data: T, error: { message: string } | null = null) {
  const result = Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null })
  const chain = {
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    order: () => chain,
    in: () => chain,
    maybeSingle: () => result,
    then: result.then.bind(result),
    catch: result.catch.bind(result),
  }
  return chain
}

describe('applySignalOverride dry-run', () => {
  test('targets open legs for signal_id', async () => {
    const signalId = 'sig-1'
    const userId = 'user-1'
    const supabase = {
      from(table: string) {
        if (table === 'signals') {
          return chainQuery({
            id: signalId,
            user_id: userId,
            channel_id: 'ch-1',
            parsed_data: { action: 'sell', symbol: 'XAUUSD', sl: 4165, tp: [4155] },
            user_override: { sl: 4159, tp: [4150, 4148] },
          })
        }
        if (table === 'trades') {
          return chainQuery([
            {
              id: 't1',
              signal_id: signalId,
              broker_account_id: 'b1',
              metaapi_order_id: '1001',
              symbol: 'XAUUSD',
              direction: 'sell',
              sl: 4165,
              tp: 4155,
              opened_at: '2026-06-17T10:00:00.000Z',
              entry_price: 4160,
            },
          ])
        }
        if (table === 'broker_accounts') {
          return chainQuery([{
            id: 'b1',
            label: 'Demo',
            platform: 'MT5',
            fxsocket_account_id: '00000000-0000-4000-8000-000000000001',
            metaapi_account_id: null,
            manual_settings: null,
          }])
        }
        throw new Error(`unexpected table ${table}`)
      },
    }

    const result = await applySignalOverride(supabase as never, {
      userId,
      signalId,
      dryRun: true,
    })
    assert.equal(result.applied_legs, 1)
    assert.equal(result.failed_legs, 0)
  })

  test('returns zero when no open legs', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'signals') {
          return chainQuery({
            id: 'sig-1',
            user_id: 'user-1',
            channel_id: 'ch-1',
            parsed_data: { action: 'buy', sl: 100, tp: [110] },
            user_override: { sl: 99, tp: [111] },
          })
        }
        if (table === 'trades') return chainQuery([])
        throw new Error(`unexpected table ${table}`)
      },
    }

    const result = await applySignalOverride(supabase as never, {
      userId: 'user-1',
      signalId: 'sig-1',
      dryRun: true,
    })
    assert.equal(result.applied_legs, 0)
  })
})
