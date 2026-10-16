import type { SupabaseClient } from '@supabase/supabase-js'

export type SocialTradeHistoryAccess = { sharingEnabled: boolean; canView: boolean }

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

export async function fetchSocialTradeHistory(client: SupabaseClient, traderUserId: string): Promise<SocialTradeHistoryItem[]> {
  const { data, error } = await client.rpc('get_social_trade_history', { p_trader_user_id: traderUserId, p_limit: 100 })
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
