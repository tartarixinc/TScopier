import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { applySignalOverride, clearOverrideAutoBeStamps } from './applySignalOverride'

function chainQuery<T>(data: T, error: { message: string } | null = null) {
  const result = Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null })
  const chain = {
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    order: () => chain,
    in: () => chain,
    limit: () => result,
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

  test('applies to all 12 brokers via channel signal scope', async () => {
    const signalId = 'sig-1'
    const userId = 'user-1'
    const brokers = Array.from({ length: 12 }, (_, i) => `b${i + 1}`)
    const legs = brokers.map((b, i) => ({
      id: `${b}-leg`,
      signal_id: signalId,
      broker_account_id: b,
      metaapi_order_id: String(2000 + i),
      symbol: 'XAUUSD',
      direction: 'sell',
      sl: 4165,
      tp: 4155,
      opened_at: '2026-06-17T10:00:00.000Z',
      entry_price: 4160,
      lot_size: 0.1,
      status: 'open',
    }))
    const brokerAccounts = brokers.map((b, i) => ({
      id: b,
      label: `Demo ${i + 1}`,
      platform: 'MT5',
      signal_channel_ids: ['ch-1'],
      is_active: true,
      fxsocket_account_id: `00000000-0000-4000-8000-0000000000${String(i + 10)}`,
      metaapi_account_id: null,
      manual_settings: null,
    }))

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
        if (table === 'trades') return chainQuery(legs)
        if (table === 'broker_accounts') return chainQuery(brokerAccounts)
        throw new Error(`unexpected table ${table}`)
      },
    }

    const result = await applySignalOverride(supabase as never, {
      userId,
      signalId,
      dryRun: true,
    })
    assert.equal(result.applied_legs, 12)
    assert.equal(result.brokers?.length, 12)
    assert.ok(result.brokers?.every(b => b.applied === 1))
    assert.equal(result.brokers_missing, undefined)
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
        if (table === 'broker_accounts') return chainQuery([])
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

  test('forceApply still targets legs when DB already matches override', async () => {
    const signalId = 'sig-1'
    const userId = 'user-1'
    const supabase = {
      from(table: string) {
        if (table === 'signals') {
          return chainQuery({
            id: signalId,
            user_id: userId,
            channel_id: 'ch-1',
            parsed_data: { action: 'buy', symbol: 'BTCUSD', sl: 66800, tp: [67900] },
            user_override: { sl: 66800, tp: [67900] },
          })
        }
        if (table === 'trades') {
          return chainQuery([
            {
              id: 't1',
              signal_id: signalId,
              broker_account_id: 'b1',
              metaapi_order_id: '1001',
              symbol: 'BTCUSD',
              direction: 'buy',
              sl: 66800,
              tp: 67900,
              opened_at: '2026-06-17T10:00:00.000Z',
              entry_price: 67000,
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

    const skipped = await applySignalOverride(supabase as never, {
      userId,
      signalId,
      dryRun: true,
    })
    assert.equal(skipped.applied_legs, 0)

    const forced = await applySignalOverride(supabase as never, {
      userId,
      signalId,
      dryRun: true,
      forceApply: true,
    })
    assert.equal(forced.applied_legs, 1)
  })

  test('clearOverrideAutoBeStamps nulls auto_be_applied_at on open legs', async () => {
    const updates: Array<{ patch: unknown; ids: unknown }> = []
    const supabase = {
      from(table: string) {
        if (table !== 'trades') throw new Error(`unexpected table ${table}`)
        return {
          update(patch: unknown) {
            return {
              in(_col: string, ids: unknown) {
                updates.push({ patch, ids })
                return Promise.resolve({ data: null, error: null })
              },
            }
          },
        }
      },
    }
    await clearOverrideAutoBeStamps(supabase as never, ['t1', 't2'])
    assert.deepEqual(updates, [{ patch: { auto_be_applied_at: null }, ids: ['t1', 't2'] }])
  })
})
