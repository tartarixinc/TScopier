import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchSocialProviderPerformance, fetchSocialTradeHistory, fetchSocialTradeHistoryAccess, setSocialTradeHistorySharing } from './socialTradeHistory'

test('maps genuine source-scoped trade fields without account identifiers', async () => {
  const calls: unknown[] = []
  const client = { rpc: async (name: string, args: unknown) => {
    calls.push([name, args])
    return name === 'get_social_trade_history_access'
    ? { data: [{ sharing_enabled: true, can_view: true }], error: null }
    : { data: [{ trade_id: 'one', symbol: 'EURUSD', direction: 'sell', trade_status: 'closed', opened_at: 'open', closed_at: 'close', realized_profit: '12.50' }], error: null }
  } } as unknown as SupabaseClient
  assert.deepEqual(await fetchSocialTradeHistoryAccess(client, 'trader'), { sharingEnabled: true, canView: true })
  assert.deepEqual(await fetchSocialTradeHistory(client, 'source'), [{ tradeId: 'one', symbol: 'EURUSD', direction: 'sell', status: 'closed', openedAt: 'open', closedAt: 'close', realizedProfit: 12.5 }])
  assert.deepEqual(calls[1], ['get_social_source_trade_history', { p_source_id: 'source', p_limit: 100 }])
})

test('maps explicit integrity, freshness and unavailable metric states', async () => {
  const client = { rpc: async () => ({ data: [{
    source_id: 'source', source_label: 'Demo source', source_status: 'published',
    performance_status: 'stale', status_reason: 'history_stale', account_mode: 'demo', currency: 'USD',
    period_started_at: '2026-10-01', period_ended_at: '2026-10-12', last_sync_succeeded_at: '2026-10-12',
    calculated_at: '2026-10-19', history_complete: true, open_trade_count: '1', closed_trade_count: '12',
    realized_profit: '42.50', win_rate: '75', profit_factor: '2.5', return_percentage: null,
    maximum_drawdown: null, equity_curve_available: false, is_copy_eligible: false, eligibility_reason: 'history_stale',
  }], error: null }) } as unknown as SupabaseClient
  const rows = await fetchSocialProviderPerformance(client, 'trader')
  assert.equal(rows[0]?.performanceStatus, 'stale')
  assert.equal(rows[0]?.realizedProfit, 42.5)
  assert.equal(rows[0]?.returnPercentage, null)
  assert.equal(rows[0]?.maximumDrawdown, null)
  assert.equal(rows[0]?.isCopyEligible, false)
})

test('persists the explicit history-sharing choice', async () => {
  const calls: unknown[] = []
  const client = { rpc: async (...args: unknown[]) => { calls.push(args); return { data: null, error: null } } } as unknown as SupabaseClient
  await setSocialTradeHistorySharing(client, true)
  assert.deepEqual(calls, [['set_social_trade_history_sharing', { p_enabled: true }]])
})
