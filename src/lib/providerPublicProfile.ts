import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeSocialProfileLinks, type SocialProfileLinks } from './socialProfileLinks'

export type ProviderPublicProfile = {
  profileUserId: string
  slug: string
  displayName: string
  username: string
  country: string
  bio: string | null
  access: 'open' | 'private'
  followerCount: number
  averageRating: number | null
  reviewCount: number
  monthlyCopyPriceCents: number | null
  socialLinks: SocialProfileLinks
  accountKind: 'demo' | 'live' | 'prop' | 'unknown'
  platform: string | null
  balance: number | null
  equity: number | null
  currency: string | null
  snapshotAt: string | null
  joinedAt: string | null
}

type Row = {
  profile_user_id: string
  slug: string
  display_name: string
  username: string
  country: string
  bio: string | null
  access_mode: 'open' | 'private'
  follower_count: number | string
  average_rating: number | string | null
  review_count: number | string
  monthly_copy_price_cents: number | string | null
  social_links: unknown
  account_kind: string | null
  platform: string | null
  balance: number | string | null
  equity: number | string | null
  currency: string | null
  snapshot_at: string | null
  joined_at: string | null
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

export function isValidProviderSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

const num = (value: number | string | null): number | null => value == null ? null : Number(value)

export function mapProviderPublicProfile(row: Row): ProviderPublicProfile {
  const kind = row.account_kind
  return {
    profileUserId: row.profile_user_id,
    slug: row.slug,
    displayName: row.display_name,
    username: row.username,
    country: row.country,
    bio: row.bio,
    access: row.access_mode,
    followerCount: Number(row.follower_count),
    averageRating: num(row.average_rating),
    reviewCount: Number(row.review_count),
    monthlyCopyPriceCents: num(row.monthly_copy_price_cents),
    socialLinks: normalizeSocialProfileLinks(row.social_links),
    accountKind: kind === 'demo' || kind === 'live' || kind === 'prop' ? kind : 'unknown',
    platform: row.platform,
    balance: num(row.balance),
    equity: num(row.equity),
    currency: row.currency,
    snapshotAt: row.snapshot_at,
    joinedAt: row.joined_at,
  }
}

/** Returns null when the slug is unknown, unlisted or not an approved provider. */
export async function fetchProviderPublicProfile(client: SupabaseClient, slug: string): Promise<ProviderPublicProfile | null> {
  const normalized = slug.trim().toLowerCase()
  if (!isValidProviderSlug(normalized)) return null
  const { data, error } = await client.rpc('get_provider_public_profile', { p_slug: normalized })
  if (error) throw new Error(error.message || 'Unable to load this provider.')
  const row = ((data ?? []) as Row[])[0]
  return row ? mapProviderPublicProfile(row) : null
}

// ---------------------------------------------------------------------------
// Public performance + trade history (anon-readable, gated by share_trade_history)
// ---------------------------------------------------------------------------

export type ProviderPublicMonth = { month: string; profit: number; trades: number }

export type ProviderPublicPerformance = {
  /** false when the provider has not made their trading history public. */
  shared: boolean
  currency: string | null
  lastSyncedAt: string | null
  historyComplete: boolean
  openCount: number | null
  closedCount: number | null
  wins: number | null
  winRate: number | null
  profitFactor: number | null
  realizedProfit: number | null
  grossProfit: number | null
  grossLoss: number | null
  bestProfit: number | null
  bestAt: string | null
  worstProfit: number | null
  worstAt: string | null
  periodStart: string | null
  periodEnd: string | null
  monthly: ProviderPublicMonth[]
  deposits: number | null
  withdrawals: number | null
  /** 'broker_history' = summed from the broker; 'starting_balance' = the balance saved when the account was linked. */
  depositSource: 'broker_history' | 'starting_balance' | null
  cashflowSyncedAt: string | null
}

export type ProviderPublicTrade = {
  tradeId: string
  symbol: string
  direction: 'buy' | 'sell'
  status: 'open' | 'closed'
  openedAt: string
  closedAt: string | null
  realizedProfit: number | null
}

type PerformanceRow = {
  shared: boolean
  currency: string | null
  last_synced_at: string | null
  history_complete: boolean | null
  open_count: number | string | null
  closed_count: number | string | null
  wins: number | string | null
  win_rate: number | string | null
  profit_factor: number | string | null
  realized_profit: number | string | null
  gross_profit: number | string | null
  gross_loss: number | string | null
  best_profit: number | string | null
  best_at: string | null
  worst_profit: number | string | null
  worst_at: string | null
  period_start: string | null
  period_end: string | null
  monthly: unknown
  deposits: number | string | null
  withdrawals: number | string | null
  deposit_source: string | null
  cashflow_synced_at: string | null
}

type TradeRow = {
  trade_id: string
  symbol: string
  direction: string
  trade_status: string
  opened_at: string
  closed_at: string | null
  realized_profit: number | string | null
}

function parseMonthly(value: unknown): ProviderPublicMonth[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const month = typeof row.month === 'string' ? row.month : ''
    const profit = Number(row.profit)
    const trades = Number(row.trades)
    return month && Number.isFinite(profit) ? [{ month, profit, trades: Number.isFinite(trades) ? trades : 0 }] : []
  })
}

export function mapProviderPublicPerformance(row: PerformanceRow): ProviderPublicPerformance {
  return {
    shared: row.shared === true,
    currency: row.currency,
    lastSyncedAt: row.last_synced_at,
    historyComplete: row.history_complete === true,
    openCount: num(row.open_count),
    closedCount: num(row.closed_count),
    wins: num(row.wins),
    winRate: num(row.win_rate),
    profitFactor: num(row.profit_factor),
    realizedProfit: num(row.realized_profit),
    grossProfit: num(row.gross_profit),
    grossLoss: num(row.gross_loss),
    bestProfit: num(row.best_profit),
    bestAt: row.best_at,
    worstProfit: num(row.worst_profit),
    worstAt: row.worst_at,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    monthly: parseMonthly(row.monthly),
    deposits: num(row.deposits),
    withdrawals: num(row.withdrawals),
    depositSource: row.deposit_source === 'broker_history' || row.deposit_source === 'starting_balance' ? row.deposit_source : null,
    cashflowSyncedAt: row.cashflow_synced_at,
  }
}

export function mapProviderPublicTrade(row: TradeRow): ProviderPublicTrade {
  return {
    tradeId: row.trade_id,
    symbol: row.symbol,
    direction: row.direction === 'sell' ? 'sell' : 'buy',
    status: row.trade_status === 'closed' ? 'closed' : 'open',
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    realizedProfit: num(row.realized_profit),
  }
}

export async function fetchProviderPublicPerformance(client: SupabaseClient, slug: string): Promise<ProviderPublicPerformance | null> {
  const normalized = slug.trim().toLowerCase()
  if (!isValidProviderSlug(normalized)) return null
  const { data, error } = await client.rpc('get_provider_public_performance', { p_slug: normalized })
  if (error) throw new Error(error.message || 'Unable to load this provider’s performance.')
  const row = ((data ?? []) as PerformanceRow[])[0]
  return row ? mapProviderPublicPerformance(row) : null
}

export async function fetchProviderPublicTrades(client: SupabaseClient, slug: string, limit = 100): Promise<ProviderPublicTrade[]> {
  const normalized = slug.trim().toLowerCase()
  if (!isValidProviderSlug(normalized)) return []
  const { data, error } = await client.rpc('get_provider_public_trade_history', { p_slug: normalized, p_limit: limit })
  if (error) throw new Error(error.message || 'Unable to load this provider’s trade history.')
  return ((data ?? []) as TradeRow[]).map(mapProviderPublicTrade)
}
