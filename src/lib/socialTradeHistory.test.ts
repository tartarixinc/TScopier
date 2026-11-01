import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { canLoadSocialTradeHistory, fetchSocialProviderPerformance, fetchSocialTradeHistory, fetchSocialTradeHistoryAccess, setSocialTradeHistorySharing, socialCopyEligibilityChecks, socialDirectoryPerformancePresentation, socialPerformanceStatusMessage } from './socialTradeHistory'

test('presents copy eligibility from the current server reason without assuming later checks pass', () => {
  assert.deepEqual(socialCopyEligibilityChecks(true, 'eligible').map(check => check.status), Array(9).fill('passed'))
  assert.equal(socialCopyEligibilityChecks(false, 'account_mode_unknown')[2]?.label, 'Account mode is verified')
  assert.deepEqual(socialCopyEligibilityChecks(false, 'minimum_trades_not_met').map(check => check.status), [
    'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'blocked', 'pending', 'pending',
  ])
  assert.deepEqual(socialCopyEligibilityChecks(false, 'synthetic_demo').map(check => check.status), [
    'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'blocked',
  ])
})

test('keeps the owner history controls available even if a stale access response denies viewing', () => {
  assert.equal(canLoadSocialTradeHistory({ sharingEnabled: false, canView: false }, true), true)
  assert.equal(canLoadSocialTradeHistory({ sharingEnabled: true, canView: false }, false), false)
})

test('explains each SQL performance state with its concrete reason', () => {
  assert.equal(socialPerformanceStatusMessage('available', 'current'), null)
  assert.equal(socialPerformanceStatusMessage('pending', 'sync_pending'), 'The source account has not completed its first history synchronization.')
  assert.equal(socialPerformanceStatusMessage('unavailable', 'source_disconnected'), 'The source account is disconnected. Reconnect it to refresh performance.')
  assert.equal(socialPerformanceStatusMessage('unavailable', 'source_inactive'), 'The source account is inactive.')
  assert.equal(socialPerformanceStatusMessage('failed', 'sync_failed'), 'History synchronization failed. Reconnect the source account and try again.')
  assert.equal(socialPerformanceStatusMessage('stale', 'history_stale'), 'History is stale. The figures shown are from the last successful synchronization.')
  assert.equal(socialPerformanceStatusMessage('incomplete', 'history_incomplete'), 'Some source trades remain unverified or have missing realized results. Known metrics are partial until synchronization resolves them.')
  assert.equal(socialPerformanceStatusMessage('no_history', 'no_history'), 'No verified source trading history exists yet.')
})

test('distinguishes disabled history sharing from unavailable performance', () => {
  assert.deepEqual(socialDirectoryPerformancePresentation({ sharingEnabled: false, canView: false }, null, false), {
    statusLabel: 'Not shared',
    message: 'This trader has not enabled history sharing.',
  })
  assert.deepEqual(socialDirectoryPerformancePresentation({ sharingEnabled: true, canView: true }, {
    performanceStatus: 'unavailable',
    statusReason: 'source_disconnected',
  }, false), {
    statusLabel: 'Unavailable',
    message: 'The source account is disconnected. Reconnect it to refresh performance.',
  })
})

test('shows the reason when directory performance is incomplete', () => {
  assert.deepEqual(socialDirectoryPerformancePresentation({ sharingEnabled: true, canView: true }, {
    performanceStatus: 'incomplete',
    statusReason: 'history_incomplete',
  }, false), {
    statusLabel: 'Incomplete',
    message: 'Some source trades remain unverified or have missing realized results. Known metrics are partial until synchronization resolves them.',
  })
})

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
  assert.equal(rows[0]?.isSynthetic, false)
})

test('persists the explicit history-sharing choice', async () => {
  const calls: unknown[] = []
  const client = { rpc: async (...args: unknown[]) => { calls.push(args); return { data: null, error: null } } } as unknown as SupabaseClient
  await setSocialTradeHistorySharing(client, true)
  assert.deepEqual(calls, [['set_social_trade_history_sharing', { p_enabled: true }]])
})
