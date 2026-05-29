import { supabase } from './supabase'
import type { MtTrade } from './metatraderapi'
import type { Signal, TelegramChannel } from '../types/database'

export type TradeSignalLinkMethod = 'db_ticket' | 'comment_prefix'

export interface ParsedTscopierComment {
  channelSlug: string | null
  signalIdPrefix: string
}

export interface SignalInstructionLine {
  label: string
  value: string
}

export interface TradeSignalContext {
  signal: Signal
  channel: TelegramChannel | null
  linkMethod: TradeSignalLinkMethod
}

const TSCOPIER_PREFIX = 'TSCopier:'

/** Parse `TSCopier:ChannelSlug:abc12345` or `TSCopier:abc12345` from MT order comment. */
export function parseTscopierComment(comment: string | null | undefined): ParsedTscopierComment | null {
  if (!comment?.trim()) return null
  const trimmed = comment.trim()
  if (!trimmed.startsWith(TSCOPIER_PREFIX)) return null

  const body = trimmed.slice(TSCOPIER_PREFIX.length)
  const segments = body.split(':').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return null

  const id8From = (s: string): string | null => {
    const m = s.match(/^([a-f0-9]{8})/i)
    return m ? m[1]!.toLowerCase() : null
  }

  if (segments.length === 1) {
    const prefix = id8From(segments[0]!)
    return prefix ? { channelSlug: null, signalIdPrefix: prefix } : null
  }

  const firstPrefix = id8From(segments[0]!)
  if (firstPrefix) {
    return { channelSlug: null, signalIdPrefix: firstPrefix }
  }

  const secondPrefix = id8From(segments[1] ?? '')
  if (secondPrefix) {
    return { channelSlug: segments[0]!, signalIdPrefix: secondPrefix }
  }

  return null
}

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

async function loadSignalByIdPrefix(userId: string, prefix: string): Promise<Signal | null> {
  const { data, error } = await supabase
    .from('signals')
    .select('*')
    .eq('user_id', userId)
    .ilike('id', `${prefix}%`)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Signal[]
  if (rows.length === 0) return null
  if (rows.length === 1) return rows[0]!
  // Prefer signal referenced by a trades row
  const ids = rows.map(r => r.id)
  const { data: tradeRefs } = await supabase
    .from('trades')
    .select('signal_id')
    .in('signal_id', ids)
    .limit(1)
  const refId = tradeRefs?.[0]?.signal_id as string | undefined
  if (refId) {
    const hit = rows.find(r => r.id === refId)
    if (hit) return hit
  }
  return rows[0]!
}

export async function resolveTradeSignalContext(
  userId: string,
  trade: MtTrade,
): Promise<TradeSignalContext | null> {
  // Primary: DB trades row by broker + ticket
  const { data: dbTrade, error: dbErr } = await supabase
    .from('trades')
    .select('signal_id')
    .eq('user_id', userId)
    .eq('broker_account_id', trade.broker_id)
    .eq('metaapi_order_id', String(trade.ticket))
    .maybeSingle()
  if (dbErr) throw new Error(dbErr.message)

  if (dbTrade?.signal_id) {
    const signal = await loadSignalById(dbTrade.signal_id as string)
    if (signal) {
      const channel = await loadChannel(signal.channel_id)
      return { signal, channel, linkMethod: 'db_ticket' }
    }
  }

  // Fallback: parse TSCopier comment
  const parsed = parseTscopierComment(trade.comment)
  if (!parsed) return null

  const signal = await loadSignalByIdPrefix(userId, parsed.signalIdPrefix)
  if (!signal) return null

  const channel = await loadChannel(signal.channel_id)
  return { signal, channel, linkMethod: 'comment_prefix' }
}
