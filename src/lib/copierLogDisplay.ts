import type { SupabaseClient } from '@supabase/supabase-js'
import type { Signal } from '../types/database'

export const MANAGEMENT_COPIER_ACTIONS = new Set([
  'close',
  'close_worse_entries',
  'breakeven',
  'partial_profit',
  'partial_breakeven',
  'modify',
])

const ENTRY_COPIER_ACTIONS = new Set(['buy', 'sell'])

/** Six-letter tokens parsers sometimes misread from management text (e.g. CHANGE). */
const BOGUS_SYMBOL_TOKENS = new Set([
  'CLOSED',
  'CLOSES',
  'SIGNAL',
  'MARKET',
  'SILVER',
  'GOLDEN',
  'MASTER',
  'PUBLIC',
  'TRADER',
  'BROKER',
  'MARGIN',
  'POSITION',
  'TRADES',
  'ORDERS',
  'ADJUST',
  'UPDATE',
  'MODIFY',
  'CHANGE',
  'TARGET',
  'STOPLO',
])

export type SignalSymbolLookupRow = {
  id: string
  parsed_data: unknown
  raw_message: string | null
  parent_signal_id: string | null
}

export type CopierSymbolContext = {
  lookup: Map<string, SignalSymbolLookupRow>
  /** When DB parent_signal_id is null but reply_to_message_id resolves a parent row. */
  replyParentBySignalId: Map<string, string>
}

type SymbolLookupSignal = Pick<
  Signal,
  | 'id'
  | 'channel_id'
  | 'created_at'
  | 'parsed_data'
  | 'raw_message'
  | 'parent_signal_id'
  | 'reply_to_message_id'
  | 'is_modification'
>

function cleanSymbolLabel(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || s === 'null' || s === 'undefined' || s === 'trade') return null
  return s
}

export function isPlausibleCopierSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false
  const u = symbol.toUpperCase().replace(/\s+/g, '')
  if (!u) return false
  return !BOGUS_SYMBOL_TOKENS.has(u)
}

/** Parse instrument tokens from Telegram when parsed_data has no symbol (management replies). */
export function instrumentGuessFromRawTelegram(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const u = raw.toUpperCase().replace(/\s+/g, ' ')
  const explicit = u.match(
    /\b(BTCUSD|BTCUSDT|ETHUSD|ETHUSDT|EURUSD|GBPUSD|USDJPY|AUDUSD|XAUUSD|XAGUSD|US30|NAS100|GER40)\b/,
  )
  if (explicit) return explicit[1]
  if (/\bBITCOIN\b|\bBTC\b/.test(u)) return /\bUSDT\b/.test(u) ? 'BTCUSDT' : 'BTCUSD'
  if (/\bETHER(EUM)?\b|\bETH\b/.test(u)) return /\bUSDT\b/.test(u) ? 'ETHUSDT' : 'ETHUSD'
  if (/\b(XAUUSD|XAU\b|GOLD)\b/.test(u)) return 'XAUUSD'
  if (/\bSILVER\b|\bXAG\b/.test(u)) return 'XAGUSD'
  return null
}

function symbolFromParsedData(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raw = cleanSymbolLabel((parsed as Record<string, unknown>).symbol)
  if (!raw || !isPlausibleCopierSymbol(raw)) return null
  return raw.toUpperCase().replace(/\s+/g, '')
}

function entrySymbolFromSignal(
  signal: Pick<Signal, 'parsed_data' | 'raw_message'>,
): string | null {
  return symbolFromParsedData(signal.parsed_data) ?? instrumentGuessFromRawTelegram(signal.raw_message)
}

function resolveSymbolFromLookup(
  signalId: string | null | undefined,
  lookup: Map<string, SignalSymbolLookupRow>,
  depth: number,
): string | null {
  if (!signalId || depth > 8) return null
  const row = lookup.get(signalId)
  if (!row) return null
  const fromParsed = symbolFromParsedData(row.parsed_data)
  if (fromParsed) return fromParsed
  const fromRaw = instrumentGuessFromRawTelegram(row.raw_message)
  if (fromRaw) return fromRaw
  return resolveSymbolFromLookup(row.parent_signal_id, lookup, depth + 1)
}

/** Most recent buy/sell in the same channel from the loaded batch (non-reply management updates). */
export function resolveRecentChannelEntrySymbol(
  signal: Pick<Signal, 'id' | 'channel_id' | 'created_at' | 'parsed_data' | 'raw_message'>,
  batchSignals: Array<Pick<Signal, 'id' | 'channel_id' | 'created_at' | 'parsed_data' | 'raw_message'>>,
): string | null {
  const channelId = signal.channel_id
  if (!channelId) return null
  const signalMs = Date.parse(signal.created_at)
  let best: { ms: number; symbol: string } | null = null

  for (const row of batchSignals) {
    if (row.id === signal.id || row.channel_id !== channelId) continue
    const rowMs = Date.parse(row.created_at)
    if (Number.isFinite(signalMs) && Number.isFinite(rowMs) && rowMs > signalMs) continue

    const action = String((row.parsed_data as Record<string, unknown> | null)?.action ?? '').toLowerCase()
    if (!ENTRY_COPIER_ACTIONS.has(action)) continue

    const symbol = entrySymbolFromSignal(row)
    if (!symbol) continue
    if (!best || rowMs > best.ms) best = { ms: rowMs, symbol }
  }

  return best?.symbol ?? null
}

function normalizeSymbolContext(
  context: CopierSymbolContext | Map<string, SignalSymbolLookupRow>,
): CopierSymbolContext {
  if (context instanceof Map) {
    return { lookup: context, replyParentBySignalId: new Map() }
  }
  return context
}

export function symbolForCopierLog(
  signal: SymbolLookupSignal,
  context: CopierSymbolContext | Map<string, SignalSymbolLookupRow>,
  batchSignals?: SymbolLookupSignal[],
): string {
  const { lookup, replyParentBySignalId } = normalizeSymbolContext(context)
  const parsed = signal.parsed_data as Record<string, unknown> | null
  const action = String(parsed?.action ?? '').toLowerCase()
  const isManagement =
    signal.is_modification === true || MANAGEMENT_COPIER_ACTIONS.has(action)

  const fromSelfParsed = symbolFromParsedData(signal.parsed_data)
  const fromTelegram = instrumentGuessFromRawTelegram(signal.raw_message)
  const parentId = signal.parent_signal_id ?? replyParentBySignalId.get(signal.id) ?? null
  const fromParent = resolveSymbolFromLookup(parentId, lookup, 0)
  const fromChannel =
    batchSignals && isManagement
      ? resolveRecentChannelEntrySymbol(signal, batchSignals)
      : null

  if (isManagement) {
    return fromParent ?? fromTelegram ?? fromSelfParsed ?? fromChannel ?? '—'
  }

  return fromSelfParsed ?? fromTelegram ?? fromParent ?? fromChannel ?? '—'
}

function seedLookupFromSignals(
  lookup: Map<string, SignalSymbolLookupRow>,
  pending: Set<string>,
  signals: SymbolLookupSignal[],
): void {
  for (const s of signals) {
    lookup.set(s.id, {
      id: s.id,
      parsed_data: s.parsed_data,
      raw_message: s.raw_message,
      parent_signal_id: s.parent_signal_id,
    })
    if (s.parent_signal_id && !lookup.has(s.parent_signal_id)) {
      pending.add(s.parent_signal_id)
    }
  }
}

async function resolveReplyParents(
  supabase: SupabaseClient,
  userId: string,
  signals: SymbolLookupSignal[],
  lookup: Map<string, SignalSymbolLookupRow>,
  pending: Set<string>,
): Promise<Map<string, string>> {
  const replyParentBySignalId = new Map<string, string>()
  const byChannel = new Map<string, Set<string>>()

  for (const s of signals) {
    if (s.parent_signal_id || !s.reply_to_message_id || !s.channel_id) continue
    const ids = byChannel.get(s.channel_id) ?? new Set<string>()
    ids.add(s.reply_to_message_id)
    byChannel.set(s.channel_id, ids)
  }

  for (const [channelId, replyIds] of byChannel) {
    const { data } = await supabase
      .from('signals')
      .select('id,parsed_data,raw_message,parent_signal_id,telegram_message_id')
      .eq('user_id', userId)
      .eq('channel_id', channelId)
      .in('telegram_message_id', [...replyIds])

    const byTelegramId = new Map<string, SignalSymbolLookupRow>()
    for (const row of (data ?? []) as Array<SignalSymbolLookupRow & { telegram_message_id?: string | null }>) {
      if (row.telegram_message_id) byTelegramId.set(row.telegram_message_id, row)
    }

    for (const s of signals) {
      if (s.channel_id !== channelId || s.parent_signal_id || !s.reply_to_message_id) continue
      const parent = byTelegramId.get(s.reply_to_message_id)
      if (!parent) continue
      lookup.set(parent.id, parent)
      replyParentBySignalId.set(s.id, parent.id)
      if (parent.parent_signal_id && !lookup.has(parent.parent_signal_id)) {
        pending.add(parent.parent_signal_id)
      }
    }
  }

  return replyParentBySignalId
}

/** Walk parent_signal_id chains so management rows inherit entry symbols. */
export async function buildSignalSymbolLookup(
  supabase: SupabaseClient,
  userId: string,
  signals: SymbolLookupSignal[],
): Promise<CopierSymbolContext> {
  const lookup = new Map<string, SignalSymbolLookupRow>()
  const pending = new Set<string>()

  seedLookupFromSignals(lookup, pending, signals)
  const replyParentBySignalId = await resolveReplyParents(supabase, userId, signals, lookup, pending)

  let guard = 0
  while (pending.size > 0 && guard < 8) {
    guard++
    const batch = [...pending].filter(id => !lookup.has(id))
    pending.clear()
    if (!batch.length) break

    const { data } = await supabase
      .from('signals')
      .select('id,parsed_data,raw_message,parent_signal_id')
      .eq('user_id', userId)
      .in('id', batch)

    for (const row of (data ?? []) as SignalSymbolLookupRow[]) {
      lookup.set(row.id, row)
      if (row.parent_signal_id && !lookup.has(row.parent_signal_id)) {
        pending.add(row.parent_signal_id)
      }
    }
  }

  return { lookup, replyParentBySignalId }
}

export function buildCopierLogSymbolLabels(
  signals: Signal[],
  context: CopierSymbolContext | Map<string, SignalSymbolLookupRow>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of signals) {
    out[s.id] = symbolForCopierLog(s, context, signals)
  }
  return out
}
