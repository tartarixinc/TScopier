import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  changeSocialCopySubscription,
  createSocialCopySubscription,
  fetchSocialCopySources,
  fetchSocialCopySubscriptions,
} from './socialCopy'

test('maps only persisted source availability and subscription lifecycle state', async () => {
  const rpc = async () => ({ data: [{
    source_id: 'source', trader_user_id: 'trader', label: 'Demo source', provider: 'fxsocket',
    platform: 'MT5', account_mode: 'demo', connection_healthy: true,
  }], error: null })
  const query = {
    select() { return this }, eq() { return this }, order: async () => ({ data: [{
      id: 'sub', source_id: 'source', destination_broker_account_id: 'destination', sizing_mode: 'fixed_lot',
      fixed_lot: '0.01', lot_multiplier: '1', max_lot: '0.1', requested_account_mode: 'demo',
      status: 'pending', desired_status: 'active', error_code: null, error_detail: null,
      worker_acknowledged_at: null, updated_at: '2026-10-14T00:00:00Z',
    }], error: null }),
  }
  const client = { rpc, from: () => query } as unknown as SupabaseClient
  assert.deepEqual(await fetchSocialCopySources(client, 'trader'), [{
    sourceId: 'source', traderUserId: 'trader', label: 'Demo source', provider: 'fxsocket',
    platform: 'MT5', accountMode: 'demo', connectionHealthy: true,
  }])
  const subscriptions = await fetchSocialCopySubscriptions(client, 'trader')
  assert.equal(subscriptions[0]?.status, 'pending')
  assert.equal(subscriptions[0]?.workerAcknowledgedAt, null)
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
  })
  assert.equal(id, 'subscription-id')
  assert.equal(calls[0]?.name, 'create_social_copy_subscription')
  assert.equal(calls[0]?.args.p_fixed_lot, null)
  assert.equal(calls[0]?.args.p_requested_account_mode, 'demo')
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
