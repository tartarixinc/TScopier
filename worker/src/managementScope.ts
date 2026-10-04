/**
 * Scope resolution for channel management instructions (close half, modify SL, etc.).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { mgmtBasketConcurrency, parallelMap } from './parallelPool'
import { classifySymbol } from './pipMath'
import { signalPipPrice } from './signalPip'
import { sanitizeParsedSymbol } from './tradableSymbol'
import { extractProviderSignalNumber } from './forexBroSignalPatterns'

export type MgmtParsedLike = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
  provider_signal_number?: number | null
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
/** Legacy gold mgmt used 500 × $0.10 = $50; keep the same price ceiling. */
const METAL_MAX_MGMT_PRICE_DIST = 50

function maxMgmtPriceDistance(symbol: string, pip: number): number {
  if (classifySymbol(symbol) === 'metal') return METAL_MAX_MGMT_PRICE_DIST
  return MAX_PLAUSIBLE_PIPS * pip
}

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
  const maxDist = maxMgmtPriceDistance(sample?.symbol ?? parsed.symbol ?? 'EURUSD', pip)

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

/** Per-broker row cap. Applied per broker (not shared) so a busy channel with
 *  many accounts never truncates coverage for later brokers. */
const MGMT_PER_BROKER_LIMIT = 500
/** Run per-broker scoped queries in parallel once the account count crosses this. */
const MGMT_PER_BROKER_SCOPE_THRESHOLD = 4

export async function loadOpenTradesForManagement(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    brokerAccountIds: string[]
    symbolFilter?: string | null
  },
): Promise<MgmtTradeRow[]> {
  const { userId, channelId } = args
  const brokerAccountIds = [...new Set(args.brokerAccountIds)]
  if (!channelId || !brokerAccountIds.length) return []

  const { data: channelSignals } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .limit(5000)

  const signalIds = (channelSignals ?? []).map((r: { id: string }) => r.id)

  // The three discovery queries (by telegram_channel_id, by channel signal_ids,
  // by attribution) for a given broker subset. Each query is scoped to the
  // subset so its row cap belongs to that subset alone.
  const loadForBrokers = async (brokerIds: string[]): Promise<MgmtTradeRow[]> => {
    const { data: byChannelCol } = await supabase
      .from('trades')
      .select(MGMT_TRADE_SELECT)
      .eq('user_id', userId)
      .in('broker_account_id', brokerIds)
      .in('status', ['open', 'pending'])
      .eq('telegram_channel_id', channelId)
      .order('opened_at', { ascending: true })
      .limit(MGMT_PER_BROKER_LIMIT)

    const { data: bySignalId } = signalIds.length
      ? await supabase
        .from('trades')
        .select(MGMT_TRADE_SELECT)
        .eq('user_id', userId)
        .in('broker_account_id', brokerIds)
        .in('status', ['open', 'pending'])
        .in('signal_id', signalIds)
        .order('opened_at', { ascending: true })
        .limit(MGMT_PER_BROKER_LIMIT)
      : { data: [] as MgmtTradeRow[] }

    const { data: attribRows } = await supabase
      .from('trade_channel_attributions')
      .select('trade_id')
      .eq('user_id', userId)
      .eq('channel_id', channelId)
      .in('broker_account_id', brokerIds)
      .limit(MGMT_PER_BROKER_LIMIT)

    const attribTradeIds = (attribRows ?? []).map((r: { trade_id: string }) => r.trade_id).filter(Boolean)
    const { data: byAttribution } = attribTradeIds.length
      ? await supabase
        .from('trades')
        .select(MGMT_TRADE_SELECT)
        .eq('user_id', userId)
        .in('broker_account_id', brokerIds)
        .in('status', ['open', 'pending'])
        .in('id', attribTradeIds)
        .order('opened_at', { ascending: true })
        .limit(MGMT_PER_BROKER_LIMIT)
      : { data: [] as MgmtTradeRow[] }

    return [
      ...(byChannelCol ?? []),
      ...(bySignalId ?? []),
      ...(byAttribution ?? []),
    ] as MgmtTradeRow[]
  }

  // For many accounts, scope each broker independently in parallel so a single
  // shared row cap can't starve later brokers (the multi-broker partial-apply bug).
  const collected: MgmtTradeRow[] = brokerAccountIds.length >= MGMT_PER_BROKER_SCOPE_THRESHOLD
    ? (await parallelMap(brokerAccountIds, mgmtBasketConcurrency(), id => loadForBrokers([id]))).flat()
    : await loadForBrokers(brokerAccountIds)

  const merged = new Map<string, MgmtTradeRow>()
  for (const row of collected) {
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

export async function loadTradesForBasketAnchorChecked(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountIds: string[]
    anchorSignalId: string
  },
): Promise<{ rows: MgmtTradeRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('trades')
    .select(MGMT_TRADE_SELECT)
    .eq('user_id', args.userId)
    .eq('signal_id', args.anchorSignalId)
    .in('broker_account_id', args.brokerAccountIds)
    .in('status', ['open', 'pending'])
    .order('opened_at', { ascending: true })
    .limit(500)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as MgmtTradeRow[], error: null }
}

export async function loadTradesForBasketAnchor(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountIds: string[]
    anchorSignalId: string
  },
): Promise<MgmtTradeRow[]> {
  const { rows } = await loadTradesForBasketAnchorChecked(supabase, args)
  return rows
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

export type SignalScopedTrades = {
  rows: MgmtTradeRow[]
  brokersFound: string[]
  brokersMissing: string[]
}

/**
 * Load every open/pending leg for a single signal across all linked brokers.
 *
 * Unlike the channel-wide loader, this is anchored to one `signal_id`, so it can
 * never truncate broker coverage on busy channels (a single entry basket across
 * 12 brokers is far below any row cap). Returns explicit found/missing broker
 * lists so callers can heal (reconcile) brokers that have no legs in scope.
 */
export async function loadOpenTradesForSignalAcrossBrokers(
  supabase: SupabaseClient,
  args: {
    userId: string
    signalId: string
    brokerAccountIds: string[]
  },
): Promise<SignalScopedTrades> {
  const uniqueBrokers = [...new Set(args.brokerAccountIds)]
  if (!args.signalId || !uniqueBrokers.length) {
    return { rows: [], brokersFound: [], brokersMissing: uniqueBrokers }
  }

  // Anchoring on signal_id returns all legs for this signal across every broker
  // in one query (range/layer legs share the anchor signal_id).
  const rows = await loadTradesForBasketAnchor(supabase, {
    userId: args.userId,
    brokerAccountIds: uniqueBrokers,
    anchorSignalId: args.signalId,
  })

  const found = new Set<string>()
  for (const r of rows) found.add(r.broker_account_id)
  const brokersMissing = uniqueBrokers.filter(id => !found.has(id))
  return { rows, brokersFound: [...found], brokersMissing }
}

/** Find the entry signal row for a provider trade number (ForexBro Signal #NNN). */
export async function resolveEntrySignalIdByProviderNumber(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    providerSignalNumber: number
  },
): Promise<string | null> {
  const n = args.providerSignalNumber
  if (!Number.isFinite(n) || n <= 0) return null
  const { data } = await supabase
    .from('signals')
    .select('id, parsed_data, raw_message')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
    .order('created_at', { ascending: false })
    .limit(300)
  const ref = new RegExp(`(?:new\\s+signal|signal)\\s*#\\s*${n}\\b`, 'i')
  for (const row of data ?? []) {
    const pd = row.parsed_data as { action?: string; raw_instruction?: string } | null
    const action = String(pd?.action ?? '').toLowerCase()
    if (action !== 'buy' && action !== 'sell') continue
    const text = String(row.raw_message ?? pd?.raw_instruction ?? '')
    if (ref.test(text)) return String(row.id)
  }
  return null
}

export const PROVIDER_ENTRY_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000

function providerNumberFromSignalRow(row: {
  parsed_data?: unknown
  raw_message?: string | null
}): number | null {
  const pd = row.parsed_data as { provider_signal_number?: number | null } | null
  if (typeof pd?.provider_signal_number === 'number' && pd.provider_signal_number > 0) {
    return pd.provider_signal_number
  }
  return extractProviderSignalNumber(String(row.raw_message ?? ''))
}

/** Block duplicate entry dispatch when the same provider Signal #NNN was already ingested. */
export async function findRecentEntrySignalByProviderNumber(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    providerSignalNumber: number
    symbol: string | null
    excludeSignalId?: string | null
    excludeTelegramMessageId?: string | null
    windowMs?: number
  },
): Promise<{ id: string; telegram_message_id: string | null } | null> {
  const n = args.providerSignalNumber
  if (!Number.isFinite(n) || n <= 0) return null

  const windowMs = args.windowMs ?? PROVIDER_ENTRY_DEDUP_WINDOW_MS
  const since = new Date(Date.now() - windowMs).toISOString()
  const sym = String(args.symbol ?? '').toUpperCase()

  const { data } = await supabase
    .from('signals')
    .select('id, telegram_message_id, parsed_data, raw_message, status, created_at')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100)

  for (const row of data ?? []) {
    if (args.excludeSignalId && String(row.id) === args.excludeSignalId) continue
    if (
      args.excludeTelegramMessageId
      && String(row.telegram_message_id ?? '') === String(args.excludeTelegramMessageId)
    ) {
      continue
    }

    const pd = row.parsed_data as { action?: string; symbol?: string } | null
    const action = String(pd?.action ?? '').toLowerCase()
    if (action !== 'buy' && action !== 'sell') continue

    if (providerNumberFromSignalRow(row) !== n) continue

    if (sym && String(pd?.symbol ?? '').toUpperCase() !== sym) continue

    const status = String(row.status ?? '').toLowerCase()
    if (status === 'skipped' || status === 'error') continue

    return {
      id: String(row.id),
      telegram_message_id: row.telegram_message_id != null
        ? String(row.telegram_message_id)
        : null,
    }
  }

  return null
}
