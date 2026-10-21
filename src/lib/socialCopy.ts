import type { SupabaseClient } from '@supabase/supabase-js'

export type SocialCopySource = {
  sourceId: string
  traderUserId: string
  label: string
  provider: string
  platform: string
  accountMode: 'demo' | 'live' | 'unknown'
  connectionHealthy: boolean
  isCopyEligible: boolean
  eligibilityReason: string
  isSynthetic: boolean
}

export type SocialCopySubscriptionStatus = 'pending' | 'active' | 'paused' | 'stopped' | 'error' | 'emergency_stopped'

export type SocialCopySubscription = {
  id: string
  sourceId: string
  destinationBrokerAccountId: string
  sizingMode: 'fixed_lot' | 'lot_multiplier' | 'equity_ratio'
  fixedLot: number | null
  lotMultiplier: number
  maxLot: number
  requestedAccountMode: 'demo' | 'live'
  status: SocialCopySubscriptionStatus
  desiredStatus: 'active' | 'paused' | 'stopped'
  errorCode: string | null
  errorDetail: string | null
  workerAcknowledgedAt: string | null
  updatedAt: string
}

type SourceRow = {
  source_id: string
  trader_user_id: string
  label: string
  provider: string
  platform: string
  account_mode: 'demo' | 'live' | 'unknown'
  connection_healthy: boolean
  is_copy_eligible: boolean
  eligibility_reason: string
}

type SubscriptionRow = {
  id: string
  source_id: string
  destination_broker_account_id: string
  sizing_mode: SocialCopySubscription['sizingMode']
  fixed_lot: number | string | null
  lot_multiplier: number | string
  max_lot: number | string
  requested_account_mode: 'demo' | 'live'
  status: SocialCopySubscriptionStatus
  desired_status: SocialCopySubscription['desiredStatus']
  error_code: string | null
  error_detail: string | null
  worker_acknowledged_at: string | null
  updated_at: string
}

function failure(error: unknown): Error {
  const candidate = error as { message?: unknown } | null
  return new Error(typeof candidate?.message === 'string' ? candidate.message : 'Social copy request failed', { cause: error })
}

export async function fetchSocialCopySources(client: SupabaseClient, traderUserId: string): Promise<SocialCopySource[]> {
  const { data, error } = await client.rpc('get_social_copy_sources', { p_trader_user_id: traderUserId })
  if (error) throw failure(error)
  return ((data ?? []) as SourceRow[]).map(row => ({
    sourceId: row.source_id,
    traderUserId: row.trader_user_id,
    label: row.label,
    provider: row.provider,
    platform: row.platform,
    accountMode: row.account_mode,
    connectionHealthy: row.connection_healthy,
    isCopyEligible: row.is_copy_eligible === true,
    eligibilityReason: row.eligibility_reason,
    isSynthetic: row.eligibility_reason === 'synthetic_demo',
  }))
}

export async function fetchSocialCopySubscriptions(client: SupabaseClient, traderUserId: string): Promise<SocialCopySubscription[]> {
  const { data, error } = await client.from('social_copy_subscriptions')
    .select('id,source_id,destination_broker_account_id,sizing_mode,fixed_lot,lot_multiplier,max_lot,requested_account_mode,status,desired_status,error_code,error_detail,worker_acknowledged_at,updated_at')
    .eq('source_trader_user_id', traderUserId).order('created_at', { ascending: false })
  if (error) throw failure(error)
  return ((data ?? []) as SubscriptionRow[]).map(row => ({
    id: row.id,
    sourceId: row.source_id,
    destinationBrokerAccountId: row.destination_broker_account_id,
    sizingMode: row.sizing_mode,
    fixedLot: row.fixed_lot == null ? null : Number(row.fixed_lot),
    lotMultiplier: Number(row.lot_multiplier),
    maxLot: Number(row.max_lot),
    requestedAccountMode: row.requested_account_mode,
    status: row.status,
    desiredStatus: row.desired_status,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    workerAcknowledgedAt: row.worker_acknowledged_at,
    updatedAt: row.updated_at,
  }))
}

export async function publishSocialCopySource(client: SupabaseClient, brokerAccountId: string, label?: string): Promise<string> {
  const { data, error } = await client.rpc('publish_social_copy_source', { p_broker_account_id: brokerAccountId, p_label: label ?? null })
  if (error) throw failure(error)
  return String(data)
}

export async function createSocialCopySubscription(client: SupabaseClient, input: {
  sourceId: string
  destinationBrokerAccountId: string
  sizingMode: SocialCopySubscription['sizingMode']
  fixedLot: number | null
  lotMultiplier: number
  maxLot: number
  accountMode: 'demo' | 'live'
}): Promise<string> {
  const { data, error } = await client.rpc('create_social_copy_subscription', {
    p_source_id: input.sourceId,
    p_destination_broker_account_id: input.destinationBrokerAccountId,
    p_sizing_mode: input.sizingMode,
    p_fixed_lot: input.sizingMode === 'fixed_lot' ? input.fixedLot : null,
    p_lot_multiplier: input.lotMultiplier,
    p_max_lot: input.maxLot,
    p_max_daily_loss: null,
    p_requested_account_mode: input.accountMode,
    p_symbol_map: {},
  })
  if (error) throw failure(error)
  return String(data)
}

export async function changeSocialCopySubscription(client: SupabaseClient, id: string, action: 'pause' | 'resume' | 'stop' | 'emergency_stop'): Promise<void> {
  const { error } = await client.rpc('set_social_copy_subscription_status', { p_subscription_id: id, p_action: action })
  if (error) throw failure(error)
}
