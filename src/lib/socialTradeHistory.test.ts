import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchSocialTradeHistory, fetchSocialTradeHistoryAccess, setSocialTradeHistorySharing } from './socialTradeHistory'

test('maps genuine persisted open and closed trade fields without account identifiers', async () => {
  const client = { rpc: async (name: string) => name === 'get_social_trade_history_access'
    ? { data: [{ sharing_enabled: true, can_view: true }], error: null }
    : { data: [{ trade_id: 'one', symbol: 'EURUSD', direction: 'sell', trade_status: 'closed', opened_at: 'open', closed_at: 'close', realized_profit: '12.50' }], error: null }
  } as unknown as SupabaseClient
  assert.deepEqual(await fetchSocialTradeHistoryAccess(client, 'trader'), { sharingEnabled: true, canView: true })
  assert.deepEqual(await fetchSocialTradeHistory(client, 'trader'), [{ tradeId: 'one', symbol: 'EURUSD', direction: 'sell', status: 'closed', openedAt: 'open', closedAt: 'close', realizedProfit: 12.5 }])
})

test('persists the explicit history-sharing choice', async () => {
  const calls: unknown[] = []
  const client = { rpc: async (...args: unknown[]) => { calls.push(args); return { data: null, error: null } } } as unknown as SupabaseClient
  await setSocialTradeHistorySharing(client, true)
  assert.deepEqual(calls, [['set_social_trade_history_sharing', { p_enabled: true }]])
})
