import type { SupabaseClient } from '@supabase/supabase-js'

export type SocialTradeHistoryAccess = { sharingEnabled: boolean; canView: boolean }

export type SocialPerformanceStatus =
  | 'no_history'
  | 'pending'
  | 'unavailable'
  | 'stale'
  | 'failed'
  | 'incomplete'
  | 'available'

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
