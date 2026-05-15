import type { SupabaseClient } from '@supabase/supabase-js'
import type { Signal } from '../types/database'

export const MANAGEMENT_COPIER_ACTIONS = new Set([
  'close',
  'breakeven',
  'partial_profit',
  'partial_breakeven',
  'modify',
])

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

export function symbolForCopierLog(
  signal: Pick<Signal, 'parsed_data' | 'raw_message' | 'parent_signal_id' | 'is_modification'>,
  lookup: Map<string, SignalSymbolLookupRow>,
): string {
  const parsed = signal.parsed_data as Record<string, unknown> | null
  const action = String(parsed?.action ?? '').toLowerCase()
  const isManagement =
    signal.is_modification === true || MANAGEMENT_COPIER_ACTIONS.has(action)

  const fromSelfParsed = symbolFromParsedData(signal.parsed_data)
  const fromTelegram = instrumentGuessFromRawTelegram(signal.raw_message)
  const fromParent = resolveSymbolFromLookup(signal.parent_signal_id, lookup, 0)

  if (isManagement) {
    return fromParent ?? fromTelegram ?? fromSelfParsed ?? '—'
  }

  return fromSelfParsed ?? fromTelegram ?? fromParent ?? '—'
}

/** Walk parent_signal_id chains so management rows inherit entry symbols. */
export async function buildSignalSymbolLookup(
  supabase: SupabaseClient,
  userId: string,
  signals: Array<{ parent_signal_id: string | null }>,
): Promise<Map<string, SignalSymbolLookupRow>> {
  const lookup = new Map<string, SignalSymbolLookupRow>()
  const pending = new Set<string>()

  for (const s of signals) {
    if (s.parent_signal_id) pending.add(s.parent_signal_id)
  }

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

  return lookup
}

export function buildCopierLogSymbolLabels(
  signals: Signal[],
  lookup: Map<string, SignalSymbolLookupRow>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of signals) {
    out[s.id] = symbolForCopierLog(s, lookup)
  }
  return out
}
