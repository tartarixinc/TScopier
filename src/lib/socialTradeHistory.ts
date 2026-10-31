import type { SupabaseClient } from '@supabase/supabase-js'

export type SocialTradeHistoryAccess = { sharingEnabled: boolean; canView: boolean }

/** Owners may always load their own history; viewer consent remains enforced
 * by the RPCs for everyone else. Keeping this explicit prevents a stale
 * access response from hiding the owner's sharing control. */
export function canLoadSocialTradeHistory(access: SocialTradeHistoryAccess, isSelf: boolean): boolean {
  return isSelf || access.canView
}

export type SocialPerformanceStatus =
  | 'no_history'
  | 'pending'
  | 'unavailable'
  | 'stale'
  | 'failed'
  | 'incomplete'
  | 'available'

export type SocialCopyEligibilityCheck = {
  label: string
  status: 'passed' | 'blocked' | 'pending'
}

const socialCopyEligibilityRules = [
  { label: 'Source is published', reasons: ['source_missing', 'source_not_published'] },
  { label: 'Platform is supported (MT4/MT5)', reasons: ['source_unsupported'] },
  { label: 'Account mode is verified', reasons: ['account_mode_unknown', 'demo_only'] },
  { label: 'Account is active and connected', reasons: ['source_inactive', 'sync_failed', 'source_disconnected'] },
  { label: 'Synchronized within 15 minutes', reasons: ['sync_pending', 'history_stale'] },
  { label: 'Trade history is complete and verified', reasons: ['history_incomplete'] },
  { label: 'At least 10 closed trades', reasons: ['minimum_trades_not_met'] },
  { label: 'Trade history spans at least 7 days', reasons: ['minimum_period_not_met'] },
  { label: 'Profile is eligible for copying', reasons: ['synthetic_demo'] },
] as const

export function socialCopyEligibilityChecks(isEligible: boolean, reason: string): SocialCopyEligibilityCheck[] {
  if (isEligible) return socialCopyEligibilityRules.map(({ label }) => ({ label, status: 'passed' }))

  const blockedIndex = socialCopyEligibilityRules.findIndex(rule => rule.reasons.some(candidate => candidate === reason))
  const maskedReason = reason === 'synthetic_demo'
  return socialCopyEligibilityRules.map(({ label }, index) => ({
    label,
    status: maskedReason
      ? index === blockedIndex ? 'blocked' : 'pending'
      : blockedIndex < 0 || index > blockedIndex ? 'pending' : index === blockedIndex ? 'blocked' : 'passed',
  }))
}

export function socialPerformanceStatusMessage(status: SocialPerformanceStatus, reason: string): string | null {
  if (status === 'available') return null
  if (reason === 'source_account_missing') return 'The source account is no longer available.'
  if (reason === 'source_unsupported') return 'This source platform is not supported for performance history.'
  if (reason === 'source_inactive') return 'The source account is inactive.'
  if (reason === 'source_disconnected') return 'The source account is disconnected. Reconnect it to refresh performance.'
  if (reason === 'sync_failed') return 'History synchronization failed. Reconnect the source account and try again.'
  if (reason === 'sync_pending') return 'The source account has not completed its first history synchronization.'
  if (reason === 'history_stale') return 'History is stale. The figures shown are from the last successful synchronization.'
  if (reason === 'history_incomplete') return 'Some source trades remain unverified or have missing realized results. Known metrics are partial until synchronization resolves them.'
  if (reason === 'no_history') return 'No verified source trading history exists yet.'
  return 'Performance is unavailable for this source.'
}

export function socialDirectoryPerformancePresentation(
  access: SocialTradeHistoryAccess | null,
  performance: Pick<SocialProviderPerformance, 'performanceStatus' | 'statusReason'> | null,
  loading: boolean,
): { statusLabel: string; message: string | null } {
  if (loading) return { statusLabel: 'Loading', message: null }
  if (access && !access.canView) {
    return access.sharingEnabled
      ? { statusLabel: 'Restricted', message: 'This trader\'s history is not available to your account.' }
      : { statusLabel: 'Not shared', message: 'This trader has not enabled history sharing.' }
  }
  if (!performance) return { statusLabel: 'Unavailable', message: 'No published source performance is available.' }

  const labels: Record<SocialPerformanceStatus, string> = {
    available: 'Current',
    stale: 'Stale',
    incomplete: 'Incomplete',
    pending: 'Pending',
    no_history: 'No history',
    failed: 'Failed',
    unavailable: 'Unavailable',
  }
  return {
    statusLabel: labels[performance.performanceStatus],
    message: socialPerformanceStatusMessage(performance.performanceStatus, performance.statusReason),
  }
}

export type SocialProviderPerformance = {
  sourceId: string
  sourceLabel: string
  sourceStatus: 'published' | 'paused' | 'retired'
  performanceStatus: SocialPerformanceStatus
  statusReason: string
  accountMode: 'demo' | 'live' | 'unknown'
  currency: string | null
  periodStartedAt: string | null
  periodEndedAt: string | null
  lastSyncSucceededAt: string | null
  calculatedAt: string
  historyComplete: boolean
  openTradeCount: number
  closedTradeCount: number
  realizedProfit: number | null
  winRate: number | null
  profitFactor: number | null
  returnPercentage: null
  maximumDrawdown: null
  equityCurveAvailable: false
  isCopyEligible: boolean
  eligibilityReason: string
  isSynthetic: boolean
}

export type SocialTradeHistoryItem = {
  tradeId: string
  symbol: string
  direction: 'buy' | 'sell'
  status: 'open' | 'closed'
  openedAt: string
  closedAt: string | null
  realizedProfit: number | null
}

type AccessRow = { sharing_enabled: boolean; can_view: boolean }
type TradeRow = {
  trade_id: string
  symbol: string
  direction: string
  trade_status: string
  opened_at: string
  closed_at: string | null
  realized_profit: number | string | null
}

type PerformanceRow = {
  source_id: string
  source_label: string
  source_status: SocialProviderPerformance['sourceStatus']
  performance_status: SocialPerformanceStatus
  status_reason: string
  account_mode: SocialProviderPerformance['accountMode']
  currency: string | null
  period_started_at: string | null
  period_ended_at: string | null
  last_sync_succeeded_at: string | null
  calculated_at: string
  history_complete: boolean
  open_trade_count: number | string
  closed_trade_count: number | string
  realized_profit: number | string | null
  win_rate: number | string | null
  profit_factor: number | string | null
  return_percentage: null
  maximum_drawdown: null
  equity_curve_available: boolean
  is_copy_eligible: boolean
  eligibility_reason: string
}

function failure(error: unknown): Error {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : 'Trade history request failed'
  return new Error(message, { cause: error })
}

export async function fetchSocialTradeHistoryAccess(client: SupabaseClient, traderUserId: string): Promise<SocialTradeHistoryAccess> {
  const { data, error } = await client.rpc('get_social_trade_history_access', { p_trader_user_id: traderUserId })
  if (error) throw failure(error)
  const row = ((data ?? []) as AccessRow[])[0]
  return { sharingEnabled: row?.sharing_enabled === true, canView: row?.can_view === true }
}

export async function fetchSocialProviderPerformance(client: SupabaseClient, traderUserId: string): Promise<SocialProviderPerformance[]> {
  const { data, error } = await client.rpc('get_social_provider_performance', { p_trader_user_id: traderUserId })
  if (error) throw failure(error)
  return ((data ?? []) as PerformanceRow[]).map(row => ({
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    sourceStatus: row.source_status,
    performanceStatus: row.performance_status,
    statusReason: row.status_reason,
    accountMode: row.account_mode,
    currency: row.currency,
    periodStartedAt: row.period_started_at,
    periodEndedAt: row.period_ended_at,
    lastSyncSucceededAt: row.last_sync_succeeded_at,
    calculatedAt: row.calculated_at,
    historyComplete: row.history_complete === true,
    openTradeCount: Number(row.open_trade_count),
    closedTradeCount: Number(row.closed_trade_count),
    realizedProfit: row.realized_profit == null ? null : Number(row.realized_profit),
    winRate: row.win_rate == null ? null : Number(row.win_rate),
    profitFactor: row.profit_factor == null ? null : Number(row.profit_factor),
    returnPercentage: null,
    maximumDrawdown: null,
    equityCurveAvailable: false,
    isCopyEligible: row.is_copy_eligible === true,
    eligibilityReason: row.eligibility_reason,
    isSynthetic: row.eligibility_reason === 'synthetic_demo',
  }))
}

export async function fetchSocialTradeHistory(client: SupabaseClient, sourceId: string): Promise<SocialTradeHistoryItem[]> {
  const { data, error } = await client.rpc('get_social_source_trade_history', { p_source_id: sourceId, p_limit: 100 })
  if (error) throw failure(error)
  return ((data ?? []) as TradeRow[]).map(row => ({
    tradeId: row.trade_id,
    symbol: row.symbol,
    direction: row.direction.toLowerCase() === 'sell' ? 'sell' : 'buy',
    status: row.trade_status === 'closed' ? 'closed' : 'open',
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    realizedProfit: row.realized_profit == null ? null : Number(row.realized_profit),
  }))
}

export async function setSocialTradeHistorySharing(client: SupabaseClient, enabled: boolean): Promise<void> {
  const { error } = await client.rpc('set_social_trade_history_sharing', { p_enabled: enabled })
  if (error) throw failure(error)
}
