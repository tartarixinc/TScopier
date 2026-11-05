import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeEligibilityDiagnostics, type SocialEligibilityDiagnostic } from './socialEligibility'

export type SocialCopySource = {
  sourceId: string
  label: string
  provider: string
  platform: string
  accountHint: string
  accountMode: 'demo' | 'live' | 'unknown'
  connectionHealthy: boolean
  isCopyEligible: boolean
  eligibilityReason: string
  eligibilityDiagnostics: SocialEligibilityDiagnostic[]
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
  sourceAccountMode: 'demo' | 'live' | 'unknown'
  destinationAccountMode: 'demo' | 'live' | 'unknown'
  executionPath: 'broker' | 'synthetic_simulation'
  status: SocialCopySubscriptionStatus
  desiredStatus: 'active' | 'paused' | 'stopped'
  errorCode: string | null
  errorDetail: string | null
  workerAcknowledgedAt: string | null
  updatedAt: string
}

/** Current user's copy subscription, including the provider they copy. */
export type MySocialCopySubscription = SocialCopySubscription & {
  sourceTraderUserId: string
}

export function isCurrentSocialCopySubscription(subscription: Pick<SocialCopySubscription, 'status' | 'desiredStatus'>): boolean {
  if (subscription.desiredStatus === 'stopped') return false
  return subscription.status !== 'stopped' && subscription.status !== 'emergency_stopped'
}

type SourceRow = {
  source_id: string
  label: string
  provider: string
  platform: string
  account_hint: string
  account_mode: 'demo' | 'live' | 'unknown'
  connection_healthy: boolean
  is_copy_eligible: boolean
  eligibility_reason: string
  eligibility_diagnostics?: unknown
  is_synthetic: boolean
}

export type OwnSocialCopySource = {
  sourceId: string
  brokerAccountId: string
  status: 'published' | 'paused' | 'retired'
  label: string | null
}

type SubscriptionRow = {
  id: string
  source_id: string
  source_trader_user_id?: string
  destination_broker_account_id: string
  sizing_mode: SocialCopySubscription['sizingMode']
  fixed_lot: number | string | null
  lot_multiplier: number | string
  max_lot: number | string
  requested_account_mode: 'demo' | 'live'
  source_account_mode: 'demo' | 'live' | 'unknown'
  destination_account_mode: 'demo' | 'live' | 'unknown'
  execution_path: 'broker' | 'synthetic_simulation'
  status: SocialCopySubscriptionStatus
  desired_status: SocialCopySubscription['desiredStatus']
  error_code: string | null
  error_detail: string | null
  worker_acknowledged_at: string | null
  updated_at: string
}

const SUBSCRIPTION_SELECT = 'id,source_id,destination_broker_account_id,sizing_mode,fixed_lot,lot_multiplier,max_lot,requested_account_mode,source_account_mode,destination_account_mode,execution_path,status,desired_status,error_code,error_detail,worker_acknowledged_at,updated_at'

function mapSubscriptionRow(row: SubscriptionRow): SocialCopySubscription {
  return {
    id: row.id,
    sourceId: row.source_id,
    destinationBrokerAccountId: row.destination_broker_account_id,
    sizingMode: row.sizing_mode,
    fixedLot: row.fixed_lot == null ? null : Number(row.fixed_lot),
    lotMultiplier: Number(row.lot_multiplier),
    maxLot: Number(row.max_lot),
    requestedAccountMode: row.requested_account_mode,
    sourceAccountMode: row.source_account_mode,
    destinationAccountMode: row.destination_account_mode,
    executionPath: row.execution_path,
    status: row.status,
    desiredStatus: row.desired_status,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    workerAcknowledgedAt: row.worker_acknowledged_at,
    updatedAt: row.updated_at,
  }
}

function failure(error: unknown): Error {
  const candidate = error as { message?: unknown } | null
  return new Error(typeof candidate?.message === 'string' ? candidate.message : 'Social copy request failed', { cause: error })
}

export async function fetchSocialTraderLiveCopierCount(client: SupabaseClient, traderUserId: string): Promise<number> {
  const { data, error } = await client.rpc('get_social_trader_live_copier_count', { p_trader_user_id: traderUserId })
  if (error) throw failure(error)
  if (data == null || (typeof data === 'string' && data.trim() === '')) throw new Error('Invalid live copier count returned by server')
  const count = Number(data)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid live copier count returned by server')
  return count
}

export async function fetchSocialCopySources(client: SupabaseClient, traderUserId: string): Promise<SocialCopySource[]> {
  const { data, error } = await client.rpc('get_social_copy_sources', { p_trader_user_id: traderUserId })
  if (error) throw failure(error)
  return ((data ?? []) as SourceRow[]).map(row => ({
    sourceId: row.source_id,
    label: row.label,
    provider: row.provider,
    platform: row.platform,
    accountHint: row.account_hint,
    accountMode: row.account_mode,
    connectionHealthy: row.connection_healthy,
    isCopyEligible: row.is_copy_eligible === true,
    eligibilityReason: row.eligibility_reason,
    eligibilityDiagnostics: normalizeEligibilityDiagnostics(row.eligibility_diagnostics, row.eligibility_reason),
    isSynthetic: row.is_synthetic === true,
  }))
}

export async function fetchOwnSocialCopySources(client: SupabaseClient, userId: string): Promise<OwnSocialCopySource[]> {
  const { data, error } = await client.from('social_copy_sources')
    .select('id,broker_account_id,status,label')
    .eq('trader_user_id', userId)
  if (error) throw failure(error)
  return ((data ?? []) as Array<{ id: string; broker_account_id: string; status: OwnSocialCopySource['status']; label: string | null }>).map(row => ({
    sourceId: row.id,
    brokerAccountId: row.broker_account_id,
    status: row.status,
    label: row.label,
  }))
}

export async function fetchSocialCopySubscriptions(client: SupabaseClient, traderUserId: string): Promise<SocialCopySubscription[]> {
  const { data, error } = await client.from('social_copy_subscriptions')
    .select(SUBSCRIPTION_SELECT)
    .eq('source_trader_user_id', traderUserId).order('created_at', { ascending: false })
  if (error) throw failure(error)
  return ((data ?? []) as SubscriptionRow[]).map(mapSubscriptionRow)
}

/** Current user's copy subscriptions (RLS scopes to subscriber_user_id = auth.uid()). */
export async function fetchMySocialCopySubscriptions(client: SupabaseClient): Promise<MySocialCopySubscription[]> {
  const { data, error } = await client.from('social_copy_subscriptions')
    .select(`${SUBSCRIPTION_SELECT},source_trader_user_id`)
    .order('created_at', { ascending: false })
  if (error) throw failure(error)
  return ((data ?? []) as SubscriptionRow[]).map(row => ({
    ...mapSubscriptionRow(row),
    sourceTraderUserId: String(row.source_trader_user_id),
  }))
}

export async function publishSocialCopySource(client: SupabaseClient, brokerAccountId: string, label?: string): Promise<string> {
  const { data, error } = await client.rpc('publish_social_copy_source', { p_broker_account_id: brokerAccountId, p_label: label ?? null })
  if (error) throw failure(error)
  return String(data)
}

export async function setSocialCopySourceStatus(
  client: SupabaseClient,
  sourceId: string,
  status: OwnSocialCopySource['status'],
): Promise<void> {
  const { error } = await client.rpc('set_social_copy_source_status', {
    p_source_id: sourceId,
    p_status: status,
  })
  if (error) throw failure(error)
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

/** Records a pending wallet ledger row for a paid provider copy (UI paywall). No charge yet. */
export async function subscribeSocialCopyIntent(client: SupabaseClient, providerUserId: string): Promise<string> {
  const { data, error } = await client.rpc('subscribe_social_copy_intent', {
    p_provider_user_id: providerUserId,
  })
  if (error) throw failure(error)
  return String(data)
}

export async function changeSocialCopySubscription(client: SupabaseClient, id: string, action: 'pause' | 'resume' | 'stop' | 'emergency_stop'): Promise<void> {
  const { error } = await client.rpc('set_social_copy_subscription_status', { p_subscription_id: id, p_action: action })
  if (error) throw failure(error)
}

export type ProviderCopier = {
  subscriptionId: string
  subscriberUserId: string
  displayName: string
  username: string
  status: string
  desiredStatus: string
  createdAt: string
}

export async function fetchMyProviderCopiers(client: SupabaseClient): Promise<ProviderCopier[]> {
  const { data, error } = await client.rpc('get_my_provider_copiers')
  if (error) throw failure(error)
  return ((data ?? []) as Array<{
    subscription_id: string
    subscriber_user_id: string
    display_name: string
    username: string
    status: string
    desired_status: string
    created_at: string
  }>).map(row => ({
    subscriptionId: String(row.subscription_id),
    subscriberUserId: String(row.subscriber_user_id),
    displayName: row.display_name,
    username: row.username,
    status: row.status,
    desiredStatus: row.desired_status,
    createdAt: row.created_at,
  }))
}

export type ProviderPaymentRow = {
  id: string
  payerUserId: string
  amountCents: number
  status: 'pending' | 'paid' | 'reversed'
  description: string | null
  createdAt: string
}

/** Ledger rows where the caller is the provider (earnings / pending intents). */
export async function fetchProviderPaymentLedger(client: SupabaseClient, providerUserId: string): Promise<ProviderPaymentRow[]> {
  const { data, error } = await client
    .from('wallet_ledger')
    .select('id, payer_user_id, amount_cents, status, description, created_at')
    .eq('provider_user_id', providerUserId)
    .order('created_at', { ascending: false })
  if (error) throw failure(error)
  return ((data ?? []) as Array<{
    id: string
    payer_user_id: string
    amount_cents: number
    status: 'pending' | 'paid' | 'reversed'
    description: string | null
    created_at: string
  }>).map(row => ({
    id: row.id,
    payerUserId: row.payer_user_id,
    amountCents: row.amount_cents,
    status: row.status,
    description: row.description,
    createdAt: row.created_at,
  }))
}
