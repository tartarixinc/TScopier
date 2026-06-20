import { supabase } from './supabase'
import type { MtTrade } from './fxsocketBroker'
import type { Signal, TelegramChannel } from '../types/database'
import { parseTscopierComment, signalIdMatchesPrefix } from './tscopierComment'

export type { ParsedTscopierComment } from './tscopierComment'
export { parseTscopierComment, sanitizeChannelCommentSlug, CHANNEL_COMMENT_SLUG_MAX } from './tscopierComment'

export type TradeSignalLinkMethod = 'db_ticket' | 'comment_prefix' | 'attribution'

export interface SignalInstructionLine {
  label: string
  value: string
}

export interface TradeSignalContext {
  signal: Signal
  channel: TelegramChannel | null
  linkMethod: TradeSignalLinkMethod
}

const SIGNAL_PREFIX_SCAN_LIMIT = 400

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function formatPrice(v: unknown): string {
  const n = num(v)
  if (n == null || n === 0) return '—'
  return String(n)
}

/** Human-readable instruction lines from parsed signal JSON. */
export function formatSignalInstructions(
  parsedData: unknown,
  rawMessage: string,
  labels: {
    action: string
    symbol: string
    entry: string
    entryZone: string
    sl: string
    tp: string
    lotSize: string
    message: string
  },
): SignalInstructionLine[] {
  const lines: SignalInstructionLine[] = []
  const parsed = parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)
    ? (parsedData as Record<string, unknown>)
    : null

  if (parsed) {
    const action = String(parsed.action ?? '').trim()
    if (action) {
      lines.push({ label: labels.action, value: action.replace(/_/g, ' ').toUpperCase() })
    }
    const symbol = String(parsed.symbol ?? '').trim()
    if (symbol) lines.push({ label: labels.symbol, value: symbol.toUpperCase() })

    const entry = num(parsed.entry_price)
    const zoneLow = num(parsed.entry_zone_low)
    const zoneHigh = num(parsed.entry_zone_high)
    if (entry != null && entry > 0) {
      lines.push({ label: labels.entry, value: formatPrice(entry) })
    } else if (zoneLow != null || zoneHigh != null) {
      lines.push({
        label: labels.entryZone,
        value: `${formatPrice(zoneLow)} – ${formatPrice(zoneHigh)}`,
      })
    }

    const sl = num(parsed.sl)
    if (sl != null && sl > 0) lines.push({ label: labels.sl, value: formatPrice(sl) })

    const tps = Array.isArray(parsed.tp)
      ? parsed.tp.map(v => num(v)).filter((n): n is number => n != null && n > 0)
      : []
    if (tps.length > 0) {
      lines.push({ label: labels.tp, value: tps.map(formatPrice).join(', ') })
    }

    const lot = num(parsed.lot_size)
    if (lot != null && lot > 0) lines.push({ label: labels.lotSize, value: String(lot) })

    const rawInstruction = String(parsed.raw_instruction ?? '').trim()
    if (rawInstruction && rawInstruction !== rawMessage.trim()) {
      lines.push({ label: labels.message, value: rawInstruction })
    }
  }

  return lines
}

async function loadChannel(channelId: string | null): Promise<TelegramChannel | null> {
  if (!channelId) return null
  const { data } = await supabase
    .from('telegram_channels')
    .select('*')
    .eq('id', channelId)
    .maybeSingle()
  return (data as TelegramChannel | null) ?? null
}

async function loadSignalById(signalId: string): Promise<Signal | null> {
  const { data, error } = await supabase.from('signals').select('*').eq('id', signalId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Signal | null) ?? null
}

/** Pure: pick best signal row matching an 8-char UUID prefix (for tests + in-memory scan). */
export function pickSignalByIdPrefix(
  candidates: Signal[],
  prefix: string,
  preferredSignalId?: string | null,
): Signal | null {
  const norm = prefix.toLowerCase()
  if (!/^[a-f0-9]{8}$/.test(norm)) return null
  const rows = candidates.filter(row => signalIdMatchesPrefix(row.id, norm))
  if (rows.length === 0) return null
  if (preferredSignalId) {
    const hit = rows.find(r => r.id === preferredSignalId)
    if (hit) return hit
  }
  if (rows.length === 1) return rows[0]!
  return rows[0]!
}

async function loadSignalByIdPrefix(userId: string, prefix: string): Promise<Signal | null> {
  const norm = prefix.toLowerCase()
  if (!/^[a-f0-9]{8}$/.test(norm)) return null

  // Never use ILIKE on UUID columns — PostgREST/Postgres rejects uuid ~~* unknown.
  const { data, error } = await supabase
    .from('signals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(SIGNAL_PREFIX_SCAN_LIMIT)
  if (error) throw new Error(error.message)

  const candidates = (data ?? []) as Signal[]
  const rows = candidates.filter(row => signalIdMatchesPrefix(row.id, norm))
  if (rows.length === 0) return null
  if (rows.length === 1) return rows[0]!

  const ids = rows.map(r => r.id)
  const { data: tradeRefs } = await supabase
    .from('trades')
    .select('signal_id')
    .in('signal_id', ids)
    .limit(1)
  const refId = tradeRefs?.[0]?.signal_id as string | undefined
  return pickSignalByIdPrefix(rows, norm, refId)
}

async function loadSignalFromAttribution(
  userId: string,
  brokerAccountId: string,
  ticket: number,
): Promise<{ signal: Signal; channelId: string | null } | null> {
  const { data, error } = await supabase
    .from('trade_channel_attributions')
    .select('signal_id, channel_id')
    .eq('user_id', userId)
    .eq('broker_account_id', brokerAccountId)
    .eq('metaapi_order_id', String(ticket))
    .maybeSingle()
  if (error || !data?.signal_id) return null

  const signal = await loadSignalById(data.signal_id as string)
  if (!signal) return null
  return {
    signal,
    channelId: (data.channel_id as string | null) ?? signal.channel_id,
  }
}

export async function resolveTradeSignalContext(
  userId: string,
  trade: MtTrade,
): Promise<TradeSignalContext | null> {
  const ticket = trade.ticket

  // Primary: DB trades row by broker + ticket
  const { data: dbTrade, error: dbErr } = await supabase
    .from('trades')
    .select('signal_id')
    .eq('user_id', userId)
    .eq('broker_account_id', trade.broker_id)
    .eq('metaapi_order_id', String(ticket))
    .maybeSingle()
  if (dbErr) throw new Error(dbErr.message)

  if (dbTrade?.signal_id) {
    const signal = await loadSignalById(dbTrade.signal_id as string)
    if (signal) {
      const channel = await loadChannel(signal.channel_id)
      return { signal, channel, linkMethod: 'db_ticket' }
    }
  }

  // Secondary: durable attribution row (survives config changes)
  const attributed = await loadSignalFromAttribution(userId, trade.broker_id, ticket)
  if (attributed) {
    const channel = await loadChannel(attributed.channelId)
    return { signal: attributed.signal, channel, linkMethod: 'attribution' }
  }

  // Fallback: parse TScopier comment prefix
  const parsed = parseTscopierComment(trade.comment)
  if (!parsed) return null

  const signal = await loadSignalByIdPrefix(userId, parsed.signalIdPrefix)
  if (!signal) return null

  const channel = await loadChannel(signal.channel_id)
  return { signal, channel, linkMethod: 'comment_prefix' }
}
