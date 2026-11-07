import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  changeSocialCopySubscription,
  createSocialCopySubscription,
  fetchMySocialCopySubscriptions,
  fetchOwnSocialCopySources,
  fetchSocialCopySources,
  fetchSocialCopySubscriptions,
  fetchSocialTraderLiveCopierCount,
  isCurrentSocialCopySubscription,
  publishSocialCopySource,
  setSocialCopySourceStatus,
  subscribeSocialCopyIntent,
} from './socialCopy'
import { eligibilityDiagnosticForReason } from './socialEligibility'

const expectDiagnostic = eligibilityDiagnosticForReason

test('maps only persisted source availability and subscription lifecycle state', async () => {
  const rpc = async () => ({ data: [{
    source_id: 'source', trader_user_id: 'trader', label: 'Demo source', provider: 'fxsocket',
    platform: 'MT5', account_hint: '•••1234', account_mode: 'demo', connection_healthy: true,
    is_copy_eligible: false, eligibility_reason: 'history_stale', is_synthetic: false,
  }], error: null })
  const query = {
    select() { return this }, eq() { return this }, order: async () => ({ data: [{
      id: 'sub', source_id: 'source', destination_broker_account_id: 'destination', sizing_mode: 'fixed_lot',
      fixed_lot: '0.01', lot_multiplier: '1', max_lot: '0.1', requested_account_mode: 'demo',
      status: 'pending', desired_status: 'active', error_code: null, error_detail: null,
      source_account_mode: 'demo', destination_account_mode: 'demo', execution_path: 'broker',
      manual_settings: { symbol_to_trade: 'XAUUSD', news_trading_enabled: false },
      worker_acknowledged_at: null, updated_at: '2026-10-14T00:00:00Z',
    }], error: null }),
  }
  const client = { rpc, from: () => query } as unknown as SupabaseClient
  assert.deepEqual(await fetchSocialCopySources(client, 'trader'), [{
    sourceId: 'source', label: 'Demo source', provider: 'fxsocket',
    platform: 'MT5', accountHint: '•••1234', accountMode: 'demo', connectionHealthy: true,
    isCopyEligible: false, eligibilityReason: 'history_stale',
    eligibilityDiagnostics: [expectDiagnostic('history_stale')], isSynthetic: false,
  }])
  const subscriptions = await fetchSocialCopySubscriptions(client, 'trader')
  assert.equal(subscriptions[0]?.status, 'pending')
  assert.equal(subscriptions[0]?.sourceAccountMode, 'demo')
  assert.equal(subscriptions[0]?.destinationAccountMode, 'demo')
  assert.equal(subscriptions[0]?.executionPath, 'broker')
  assert.equal(subscriptions[0]?.workerAcknowledgedAt, null)
  assert.equal(subscriptions[0]?.manualSettings.symbol_to_trade, 'XAUUSD')
  assert.equal(subscriptions[0]?.manualSettings.news_trading_enabled, false)
})

test('maps only a non-negative safe live copier count', async () => {
  const client = { rpc: async () => ({ data: 0, error: null }) } as unknown as SupabaseClient
  assert.equal(await fetchSocialTraderLiveCopierCount(client, 'trader'), 0)

  const invalid = { rpc: async () => ({ data: '-1', error: null }) } as unknown as SupabaseClient
  await assert.rejects(fetchSocialTraderLiveCopierCount(invalid, 'trader'), /Invalid live copier count/)
  const unavailable = { rpc: async () => ({ data: null, error: null }) } as unknown as SupabaseClient
  await assert.rejects(fetchSocialTraderLiveCopierCount(unavailable, 'trader'), /Invalid live copier count/)
})

test('scopes owned source reads and sharing mutations to backend authorization functions', async () => {
  const calls: Array<[string, unknown]> = []
  const query = {
    select(value: string) { calls.push(['select', value]); return this },
    async eq(field: string, value: string) {
      calls.push([field, value])
      return { data: [{ id: 'source', broker_account_id: 'broker', status: 'published', label: 'Primary' }], error: null }
    },
  }
  const client = {
    from(table: string) { calls.push(['from', table]); return query },
    async rpc(name: string, args: unknown) { calls.push([name, args]); return { data: name === 'publish_social_copy_source' ? 'source' : null, error: null } },
  } as unknown as SupabaseClient

  assert.deepEqual(await fetchOwnSocialCopySources(client, 'owner'), [{
    sourceId: 'source', brokerAccountId: 'broker', status: 'published', label: 'Primary',
  }])
  await publishSocialCopySource(client, 'broker', 'Primary')
  await setSocialCopySourceStatus(client, 'source', 'paused')
  assert.ok(calls.some(([name, args]) => name === 'trader_user_id' && args === 'owner'))
  assert.ok(calls.some(([name]) => name === 'publish_social_copy_source'))
  assert.ok(calls.some(([name, args]) => name === 'set_social_copy_source_status' && (args as { p_status: string }).p_status === 'paused'))
})

test('persists risk settings and never reports local-only activation', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: name === 'create_social_copy_subscription' ? 'subscription-id' : null, error: null }
    },
  } as unknown as SupabaseClient
  const id = await createSocialCopySubscription(client, {
    sourceId: 'source', destinationBrokerAccountId: 'destination', sizingMode: 'equity_ratio',
    fixedLot: null, lotMultiplier: 0.5, maxLot: 0.2, accountMode: 'demo',
    manualSettings: { symbol_to_trade: 'XAUUSD', symbols_exclude: ['BTCUSD'], news_trading_enabled: false },
  })
  assert.equal(id, 'subscription-id')
  assert.equal(calls[0]?.name, 'create_social_copy_subscription')
  assert.equal(calls[0]?.args.p_fixed_lot, null)
  assert.equal(calls[0]?.args.p_requested_account_mode, 'demo')
  assert.equal((calls[0]?.args.p_manual_settings as { symbol_to_trade?: string }).symbol_to_trade, 'XAUUSD')
  assert.deepEqual((calls[0]?.args.p_manual_settings as { symbols_exclude?: string[] }).symbols_exclude, ['BTCUSD'])
  assert.equal((calls[0]?.args.p_manual_settings as { news_trading_enabled?: boolean }).news_trading_enabled, false)
  await changeSocialCopySubscription(client, id, 'pause')
  assert.deepEqual(calls[1], { name: 'set_social_copy_subscription_status', args: { p_subscription_id: id, p_action: 'pause' } })
})

test('surfaces backend failures instead of swallowing them', async () => {
  const client = { rpc: async () => ({ data: null, error: { message: 'private follow required' } }) } as unknown as SupabaseClient
  await assert.rejects(
    createSocialCopySubscription(client, {
      sourceId: 'source', destinationBrokerAccountId: 'destination', sizingMode: 'fixed_lot',
      fixedLot: 0.01, lotMultiplier: 1, maxLot: 0.1, accountMode: 'demo',
    }),
    /private follow required/,
  )
})

test('loads the current user copy subscriptions for Your Providers', async () => {
  const calls: Array<[string, unknown]> = []
  const query = {
    select(value: string) { calls.push(['select', value]); return this },
    order: async () => ({
      data: [{
        id: 'sub', source_id: 'source', source_trader_user_id: 'provider',
        destination_broker_account_id: 'destination', sizing_mode: 'fixed_lot',
        fixed_lot: '0.01', lot_multiplier: '1', max_lot: '0.1', requested_account_mode: 'demo',
        status: 'pending', desired_status: 'active', error_code: null, error_detail: null,
        source_account_mode: 'demo', destination_account_mode: 'demo', execution_path: 'broker',
        manual_settings: {},
        worker_acknowledged_at: null, updated_at: '2026-10-14T00:00:00Z',
      }],
      error: null,
    }),
  }
  const client = { from(table: string) { calls.push(['from', table]); return query } } as unknown as SupabaseClient
  const rows = await fetchMySocialCopySubscriptions(client)
  assert.equal(rows[0]?.sourceTraderUserId, 'provider')
  assert.equal(isCurrentSocialCopySubscription(rows[0]!), true)
  assert.ok(calls.some(([name, value]) => name === 'from' && value === 'social_copy_subscriptions'))
  assert.ok(calls.some(([name, value]) => name === 'select' && String(value).includes('source_trader_user_id')))
})

test('records paid-provider copy intent through subscribe_social_copy_intent', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return { data: 'ledger-id', error: null }
    },
  } as unknown as SupabaseClient
  assert.equal(await subscribeSocialCopyIntent(client, 'provider-user'), 'ledger-id')
  assert.deepEqual(calls[0], {
    name: 'subscribe_social_copy_intent',
    args: { p_provider_user_id: 'provider-user' },
  })
})

test('surfaces subscribe intent failures instead of unlocking locally', async () => {
  const client = { rpc: async () => ({ data: null, error: { message: 'This provider is free to copy' } }) } as unknown as SupabaseClient
  await assert.rejects(subscribeSocialCopyIntent(client, 'provider-user'), /This provider is free to copy/)
})
