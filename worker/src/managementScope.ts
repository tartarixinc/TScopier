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

export function mgmtHasPriceLevels(parsed: MgmtParsedLike): boolean {
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
    .select(
      'id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price,opened_at,cwe_close_price',
    )
    .eq('user_id', userId)
    .in('broker_account_id', brokerAccountIds)
    .eq('status', 'open')
    .eq('telegram_channel_id', channelId)
    .order('opened_at', { ascending: true })
    .limit(500)

  const { data: bySignalId } = signalIds.length
    ? await supabase
      .from('trades')
      .select(
        'id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price,opened_at,cwe_close_price',
      )
      .eq('user_id', userId)
      .in('broker_account_id', brokerAccountIds)
      .eq('status', 'open')
      .in('signal_id', signalIds)
      .order('opened_at', { ascending: true })
      .limit(500)
    : { data: [] as MgmtTradeRow[] }

  const merged = new Map<string, MgmtTradeRow>()
  for (const row of [...(byChannelCol ?? []), ...(bySignalId ?? [])] as MgmtTradeRow[]) {
    merged.set(row.id, row)
  }

  let rows = [...merged.values()]
  rows = filterTradesBySymbolFilter(rows, args.symbolFilter)
  return rows
}

/** Channel-wide modify without explicit symbol: plausibility first, then newest symbol. */
export function resolveChannelModifyTargets(
  trades: MgmtTradeRow[],
  parsed: MgmtParsedLike,
): MgmtTradeRow[] {
  const plausible = filterTradesByPlausibleMgmtLevels(trades, parsed)
  if (plausible.length) return plausible
  return resolveNewestOpenSymbolTrades(trades)
}
