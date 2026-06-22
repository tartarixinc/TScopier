/**
 * Scope resolution for channel management instructions (close half, modify SL, etc.).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { signalPipPrice } from './signalPip'
import { sanitizeParsedSymbol } from './tradableSymbol'

export type MgmtParsedLike = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
}

export type MgmtSignalLike = {
  reply_to_message_id?: string | null
}

export type MgmtTradeRow = {
  id: string
  signal_id: string
  broker_account_id: string
  metaapi_order_id: string | null
  symbol: string
  direction: string
  lot_size: number
  status: string
  sl: number | null
  tp: number | null
  entry_price: number | null
  opened_at: string | null
  cwe_close_price?: number | null
}

const MAX_PLAUSIBLE_PIPS = 500

export function isReplyScopedManagement(signal: MgmtSignalLike): boolean {
  return Boolean(String(signal.reply_to_message_id ?? '').trim())
}

/** Symbol from instruction text only — never inherit from a parent signal. */
export function explicitMgmtSymbol(parsed: MgmtParsedLike): string | null {
  return sanitizeParsedSymbol(parsed.symbol)
}

function mgmtHasPriceLevels(parsed: MgmtParsedLike): boolean {
  const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
  const hasTp = (parsed.tp ?? []).some(
    t => typeof t === 'number' && Number.isFinite(t) && (t as number) > 0,
  )
  return hasSl || hasTp
}

function tradeMatchesSymbolFilter(trade: MgmtTradeRow, symbolFilter: string): boolean {
  return symbolsCompatibleForBasket(symbolFilter, trade.symbol)
}

export function filterTradesBySymbolFilter(
  trades: MgmtTradeRow[],
  symbolFilter: string | null | undefined,
): MgmtTradeRow[] {
  const sym = symbolFilter?.trim()
  if (!sym) return trades
  return trades.filter(t => tradeMatchesSymbolFilter(t, sym))
}

function normSymbolKey(sym: string): string {
  return String(sym ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Bucket open legs by compatible broker symbol. */
function groupTradesBySymbolBucket(trades: MgmtTradeRow[]): Map<string, MgmtTradeRow[]> {
  const buckets = new Map<string, MgmtTradeRow[]>()
  for (const tr of trades) {
    const key = normSymbolKey(tr.symbol)
    let hit: string | null = null
    for (const existing of buckets.keys()) {
      if (symbolsCompatibleForBasket(existing, tr.symbol)) {
        hit = existing
        break
      }
    }
    const k = hit ?? key
    const list = buckets.get(k) ?? []
    list.push(tr)
    buckets.set(k, list)
  }
  return buckets
}

function referencePriceForBucket(rows: MgmtTradeRow[]): number | null {
  for (const r of rows) {
    const ep = r.entry_price
    if (typeof ep === 'number' && Number.isFinite(ep) && ep > 0) return ep
  }
  return null
}

function levelPlausibleForBucket(
  rows: MgmtTradeRow[],
  parsed: MgmtParsedLike,
): boolean {
  const ref = referencePriceForBucket(rows)
  if (ref == null) return false

  const sample = rows[0]
  const pip = signalPipPrice(sample?.symbol ?? parsed.symbol ?? 'EURUSD')
  if (!(pip > 0)) return false
  const maxDist = MAX_PLAUSIBLE_PIPS * pip

  const isBuy = rows.every(r => String(r.direction).toLowerCase() === 'buy')
  const isSell = rows.every(r => String(r.direction).toLowerCase() === 'sell')
  if (!isBuy && !isSell) return false

  const sl = typeof parsed.sl === 'number' && parsed.sl > 0 ? parsed.sl : null
  const tp0 = (parsed.tp ?? []).find(t => typeof t === 'number' && t > 0) as number | undefined

  const levelOk = (level: number, kind: 'sl' | 'tp'): boolean => {
    if (Math.abs(level - ref) > maxDist) return false
    if (isBuy) {
      if (kind === 'sl') return level < ref
      return level > ref
    }
    if (kind === 'sl') return level > ref
    return level < ref
  }

  if (sl != null && !levelOk(sl, 'sl')) return false
  if (tp0 != null && !levelOk(tp0, 'tp')) return false
  return sl != null || tp0 != null
}

/**
 * Keep trades whose symbol bucket can accept the parsed SL/TP levels.
 * Returns empty when no bucket matches.
 */
export function filterTradesByPlausibleMgmtLevels(
  trades: MgmtTradeRow[],
  parsed: MgmtParsedLike,
): MgmtTradeRow[] {
  if (!trades.length || !mgmtHasPriceLevels(parsed)) return []
  const buckets = groupTradesBySymbolBucket(trades)
  const matched: MgmtTradeRow[] = []
  for (const [, rows] of buckets) {
    if (levelPlausibleForBucket(rows, parsed)) {
      matched.push(...rows)
    }
  }
  return matched
}

/** When plausibility fails, apply to the symbol of the most recently opened leg. */
export function resolveNewestOpenSymbolTrades(trades: MgmtTradeRow[]): MgmtTradeRow[] {
  if (!trades.length) return []
  let newest: MgmtTradeRow | null = null
  let newestTs = 0
  for (const tr of trades) {
    const ts = tr.opened_at ? new Date(tr.opened_at).getTime() : 0
    if (!newest || ts >= newestTs) {
      newest = tr
      newestTs = ts
    }
  }
  if (!newest) return []
  const anchorSym = newest.symbol
  return trades.filter(t => symbolsCompatibleForBasket(anchorSym, t.symbol))
}

const MGMT_TRADE_SELECT =
  'id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price,opened_at,cwe_close_price'

/** Active legs eligible for management (open + broker-pending strict entries). */
export function isMgmtEligibleTradeStatus(status: string): boolean {
  const s = String(status ?? '').toLowerCase()
  return s === 'open' || s === 'pending'
}

export async function loadOpenTradesForManagement(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    brokerAccountIds: string[]
    symbolFilter?: string | null
  },
): Promise<MgmtTradeRow[]> {
  const { userId, channelId, brokerAccountIds } = args
  if (!channelId || !brokerAccountIds.length) return []

  const { data: channelSignals } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .limit(5000)

  const signalIds = (channelSignals ?? []).map((r: { id: string }) => r.id)

  const { data: byChannelCol } = await supabase
    .from('trades')
    .select(MGMT_TRADE_SELECT)
    .eq('user_id', userId)
    .in('broker_account_id', brokerAccountIds)
    .in('status', ['open', 'pending'])
    .eq('telegram_channel_id', channelId)
    .order('opened_at', { ascending: true })
    .limit(500)

  const { data: bySignalId } = signalIds.length
    ? await supabase
      .from('trades')
      .select(MGMT_TRADE_SELECT)
      .eq('user_id', userId)
      .in('broker_account_id', brokerAccountIds)
      .in('status', ['open', 'pending'])
      .in('signal_id', signalIds)
      .order('opened_at', { ascending: true })
      .limit(500)
    : { data: [] as MgmtTradeRow[] }

  const { data: attribRows } = await supabase
    .from('trade_channel_attributions')
    .select('trade_id')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .in('broker_account_id', brokerAccountIds)
    .limit(500)

  const attribTradeIds = (attribRows ?? []).map((r: { trade_id: string }) => r.trade_id).filter(Boolean)
  const { data: byAttribution } = attribTradeIds.length
    ? await supabase
      .from('trades')
      .select(MGMT_TRADE_SELECT)
      .eq('user_id', userId)
      .in('broker_account_id', brokerAccountIds)
      .in('status', ['open', 'pending'])
      .in('id', attribTradeIds)
      .order('opened_at', { ascending: true })
      .limit(500)
    : { data: [] as MgmtTradeRow[] }

  const merged = new Map<string, MgmtTradeRow>()
  for (const row of [
    ...(byChannelCol ?? []),
    ...(bySignalId ?? []),
    ...(byAttribution ?? []),
  ] as MgmtTradeRow[]) {
    if (row.status === 'pending') {
      const ticket = Number(row.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) continue
    }
    merged.set(row.id, row)
  }

  let rows = [...merged.values()]
  rows = filterTradesBySymbolFilter(rows, args.symbolFilter)
  return rows
}

/** Channel-wide CWE without explicit symbol: active basket = newest open symbol bucket. */
export function resolveChannelCweTargets(
  trades: MgmtTradeRow[],
  symbolFilter: string | null | undefined,
): MgmtTradeRow[] {
  const filtered = filterTradesBySymbolFilter(trades, symbolFilter)
  if (symbolFilter?.trim()) return filtered
  return resolveNewestOpenSymbolTrades(filtered)
}

export async function loadTradesForBasketAnchor(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountIds: string[]
    anchorSignalId: string
  },
): Promise<MgmtTradeRow[]> {
  const { data } = await supabase
    .from('trades')
    .select(MGMT_TRADE_SELECT)
    .eq('user_id', args.userId)
    .eq('signal_id', args.anchorSignalId)
    .in('broker_account_id', args.brokerAccountIds)
    .in('status', ['open', 'pending'])
    .order('opened_at', { ascending: true })
    .limit(500)
  return (data ?? []) as MgmtTradeRow[]
}

/**
 * Channel-wide close-worse-entries: load open legs for the active basket on the channel.
 * Uses the standard channel trade loader first, then falls back to newest basket anchor
 * by signal_id (same resolution reply-scoped CWE uses, without requiring a parent signal).
 */
export async function loadOpenTradesForChannelWideCwe(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    brokerAccountIds: string[]
    symbolFilter?: string | null
  },
): Promise<MgmtTradeRow[]> {
  const scoped = resolveChannelCweTargets(
    await loadOpenTradesForManagement(supabase, args),
    args.symbolFilter,
  )
  if (scoped.length) return scoped

  const { data: openRows } = await supabase
    .from('trades')
    .select(`${MGMT_TRADE_SELECT},telegram_channel_id`)
    .eq('user_id', args.userId)
    .in('broker_account_id', args.brokerAccountIds)
    .in('status', ['open', 'pending'])
    .order('opened_at', { ascending: false })
    .limit(300)

  const candidates = (openRows ?? []) as (MgmtTradeRow & { telegram_channel_id?: string | null })[]
  if (!candidates.length) return []

  const signalIds = [...new Set(candidates.map(t => t.signal_id).filter(Boolean))]
  const channelSignalIds = new Set<string>()
  if (signalIds.length) {
    const { data: sigRows } = await supabase
      .from('signals')
      .select('id, channel_id')
      .in('id', signalIds)
    for (const s of sigRows ?? []) {
      if ((s as { channel_id?: string | null }).channel_id === args.channelId) {
        channelSignalIds.add((s as { id: string }).id)
      }
    }
  }

  const { data: attribRows } = await supabase
    .from('trade_channel_attributions')
    .select('trade_id')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
    .in('broker_account_id', args.brokerAccountIds)
    .limit(500)
  const attribTradeIds = new Set(
    (attribRows ?? []).map((r: { trade_id: string }) => r.trade_id).filter(Boolean),
  )

  const onChannel = candidates.filter(t =>
    t.telegram_channel_id === args.channelId
    || channelSignalIds.has(t.signal_id)
    || attribTradeIds.has(t.id),
  )
  if (!onChannel.length) return []

  const symFilter = args.symbolFilter?.trim()
  const filtered = symFilter
    ? onChannel.filter(t => tradeMatchesSymbolFilter(t, symFilter))
    : onChannel
  if (!filtered.length) return []

  const anchorSignalId = filtered[0]!.signal_id
  const basketRows = await loadTradesForBasketAnchor(supabase, {
    userId: args.userId,
    brokerAccountIds: args.brokerAccountIds,
    anchorSignalId,
  })
  return resolveChannelCweTargets(basketRows, args.symbolFilter)
}

/**
 * Channel-wide modify without explicit symbol: apply to every open symbol bucket
 * whose legs accept the parsed SL/TP levels (all matching accounts/baskets).
 * Falls back to the newest open symbol when levels are ambiguous.
 */
export function resolveChannelModifyTargets(
  trades: MgmtTradeRow[],
  parsed: MgmtParsedLike,
): MgmtTradeRow[] {
  if (!trades.length) return []
  if (!mgmtHasPriceLevels(parsed)) {
    return resolveNewestOpenSymbolTrades(trades)
  }

  const plausibleAll = filterTradesByPlausibleMgmtLevels(trades, parsed)
  if (plausibleAll.length) return plausibleAll

  const scoped = resolveNewestOpenSymbolTrades(trades)
  return scoped
}

/**
 * Ensure every open leg on each touched basket anchor is included — channel-wide
 * loaders can return a subset when symbol filters or attribution lag behind fills.
 */
export async function expandMgmtRowsToFullBaskets(
  supabase: SupabaseClient,
  args: {
    userId: string
    rows: MgmtTradeRow[]
  },
): Promise<MgmtTradeRow[]> {
  if (!args.rows.length) return []
  const merged = new Map<string, MgmtTradeRow>()
  for (const tr of args.rows) merged.set(tr.id, tr)

  const anchors = new Map<string, { brokerAccountId: string; anchorSignalId: string }>()
  for (const tr of args.rows) {
    anchors.set(`${tr.broker_account_id}|${tr.signal_id}`, {
      brokerAccountId: tr.broker_account_id,
      anchorSignalId: tr.signal_id,
    })
  }

  await Promise.all([...anchors.values()].map(async ({ brokerAccountId, anchorSignalId }) => {
    const basketRows = await loadTradesForBasketAnchor(supabase, {
      userId: args.userId,
      brokerAccountIds: [brokerAccountId],
      anchorSignalId,
    })
    for (const tr of basketRows) merged.set(tr.id, tr)
  }))

  return [...merged.values()].sort((a, b) => {
    const ta = a.opened_at ? new Date(a.opened_at).getTime() : 0
    const tb = b.opened_at ? new Date(b.opened_at).getTime() : 0
    return ta - tb
  })
}
