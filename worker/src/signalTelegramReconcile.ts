/**
 * Poll-based reconciliation: compare stored signals with live Telegram message text.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isIncomingRevisionStale, messageTextChanged } from './signalRevision'
import { normalizeTelegramMessageText } from './normalizeTelegramMessageText'

export const RECONCILE_SWEEP_WINDOW_MS = Math.max(
  60_000,
  Math.min(24 * 60 * 60_000, Number(process.env.SIGNAL_RECONCILE_WINDOW_MS ?? 6 * 60 * 60_000)),
)
export const RECONCILE_SWEEP_INTERVAL_MS = Math.max(
  15_000,
  Math.min(300_000, Number(process.env.SIGNAL_RECONCILE_SWEEP_MS ?? 60_000)),
)
export const RECONCILE_SWEEP_MAX_SIGNALS = Math.max(
  10,
  Math.min(300, Number(process.env.SIGNAL_RECONCILE_MAX_SIGNALS ?? 100)),
)
export const RECONCILE_POLL_HOOK_WINDOW_MS = Math.max(
  30_000,
  Math.min(6 * 60 * 60_000, Number(process.env.SIGNAL_RECONCILE_POLL_HOOK_WINDOW_MS ?? 2 * 60 * 60_000)),
)
export const RECONCILE_POLL_HOOK_MAX_SIGNALS = Math.max(
  5,
  Math.min(80, Number(process.env.SIGNAL_RECONCILE_POLL_HOOK_MAX_SIGNALS ?? 30)),
)
export const TELEGRAM_MESSAGE_ID_BATCH_SIZE = 100

const RECONCILE_STATUSES = ['parsed', 'executed'] as const

export type ReconcileSignalRow = {
  id: string
  channel_id: string
  telegram_message_id: string
  raw_message: string
  telegram_edit_date_seen: number | null
  created_at: string
  parsed_data?: Record<string, unknown> | null
}

/** Executed teaser entries (open legs, no SL in parsed_data) need reconcile most. */
export function signalLooksLikeTeaserBasket(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false
  const action = String(parsed.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell') return false
  const sl = parsed.sl
  if (sl != null && Number(sl) > 0) return false
  const tps = Array.isArray(parsed.tp) ? parsed.tp : []
  if (tps.some(t => Number(t) > 0)) return false
  return true
}

export type TelegramMessageSnapshot = {
  text: string
  editDateSec: number | null
}

export type ReconcileCandidate = {
  signal: ReconcileSignalRow
  rawMessage: string
  editDateSec: number | null
}

/** Read gramjs/Telethon edit timestamp (unix seconds) when present. */
export function telegramEditDateSec(message: unknown): number | null {
  if (message == null || typeof message !== 'object') return null
  const m = message as { editDate?: unknown; edit_date?: unknown }
  const raw = m.editDate ?? m.edit_date
  if (raw == null) return null
  if (raw instanceof Date) {
    const sec = Math.floor(raw.getTime() / 1000)
    return Number.isFinite(sec) && sec > 0 ? sec : null
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export function telegramMessageText(message: unknown): string {
  if (message == null || typeof message !== 'object') return ''
  const m = message as { text?: unknown; message?: unknown }
  return normalizeTelegramMessageText(String(m.text ?? m.message ?? ''))
}

export function shouldReconcileSignal(
  stored: Pick<ReconcileSignalRow, 'raw_message' | 'telegram_edit_date_seen'>,
  fetched: TelegramMessageSnapshot,
): boolean {
  const storedEdit = stored.telegram_edit_date_seen
  const fetchedEdit = fetched.editDateSec
  if (isIncomingRevisionStale(storedEdit, fetchedEdit)) {
    return false
  }
  if (
    storedEdit != null
    && storedEdit > 0
    && fetchedEdit != null
    && fetchedEdit > 0
    && fetchedEdit <= storedEdit
    && !messageTextChanged(stored.raw_message, fetched.text)
  ) {
    return false
  }
  return messageTextChanged(stored.raw_message, fetched.text)
}

export function findSignalsNeedingReconcile(
  signals: ReconcileSignalRow[],
  telegramByMessageId: Map<string, TelegramMessageSnapshot>,
): ReconcileCandidate[] {
  const out: ReconcileCandidate[] = []
  for (const signal of signals) {
    const mid = signal.telegram_message_id?.trim()
    if (!mid) continue
    const snap = telegramByMessageId.get(mid)
    if (!snap) continue
    if (!shouldReconcileSignal(signal, snap)) continue
    out.push({
      signal,
      rawMessage: snap.text,
      editDateSec: snap.editDateSec,
    })
  }
  return out
}

export function groupSignalsByChannel(
  signals: ReconcileSignalRow[],
): Map<string, ReconcileSignalRow[]> {
  const grouped = new Map<string, ReconcileSignalRow[]>()
  for (const row of signals) {
    const channelId = row.channel_id?.trim()
    if (!channelId) continue
    const list = grouped.get(channelId) ?? []
    list.push(row)
    grouped.set(channelId, list)
  }
  return grouped
}

export function chunkTelegramMessageIds(ids: string[]): string[][] {
  const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))]
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += TELEGRAM_MESSAGE_ID_BATCH_SIZE) {
    chunks.push(unique.slice(i, i + TELEGRAM_MESSAGE_ID_BATCH_SIZE))
  }
  return chunks
}

export function snapshotsFromTelegramMessages(
  messages: unknown[],
): Map<string, TelegramMessageSnapshot> {
  const out = new Map<string, TelegramMessageSnapshot>()
  for (const message of messages) {
    if (message == null || typeof message !== 'object') continue
    const idRaw = (message as { id?: unknown }).id
    if (idRaw == null) continue
    const id = String(idRaw).trim()
    if (!id) continue
    out.set(id, {
      text: telegramMessageText(message),
      editDateSec: telegramEditDateSec(message),
    })
  }
  return out
}

export async function loadSignalsForReconcile(
  supabase: SupabaseClient,
  args: {
    userId: string
    windowMs?: number
    maxSignals?: number
    channelRowId?: string
    openTradesOnly?: boolean
  },
): Promise<ReconcileSignalRow[]> {
  const windowMs = args.windowMs ?? RECONCILE_SWEEP_WINDOW_MS
  const maxSignals = args.maxSignals ?? RECONCILE_SWEEP_MAX_SIGNALS
  const since = new Date(Date.now() - windowMs).toISOString()

  let openSignalIds: Set<string> | null = null
  if (args.openTradesOnly !== false) {
    const { data: openTrades } = await supabase
      .from('trades')
      .select('signal_id')
      .eq('user_id', args.userId)
      .eq('status', 'open')
      .gte('opened_at', since)
      .limit(500)
    openSignalIds = new Set(
      (openTrades ?? [])
        .map(r => r.signal_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
  }

  let query = supabase
    .from('signals')
    .select('id,channel_id,telegram_message_id,raw_message,telegram_edit_date_seen,created_at,parsed_data')
    .eq('user_id', args.userId)
    .not('telegram_message_id', 'is', null)
    .in('status', [...RECONCILE_STATUSES])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(Math.min(maxSignals * 3, 300))

  if (args.channelRowId) {
    query = query.eq('channel_id', args.channelRowId)
  }

  const { data, error } = await query
  if (error || !data?.length) return []

  const rows = data.filter(
    r => r.channel_id && r.telegram_message_id,
  ) as ReconcileSignalRow[]

  const prioritized = openSignalIds
    ? [
        ...rows.filter(r =>
          openSignalIds!.has(r.id)
          && signalLooksLikeTeaserBasket((r as { parsed_data?: Record<string, unknown> }).parsed_data),
        ),
        ...rows.filter(r =>
          openSignalIds!.has(r.id)
          && !signalLooksLikeTeaserBasket((r as { parsed_data?: Record<string, unknown> }).parsed_data),
        ),
        ...rows.filter(r => !openSignalIds!.has(r.id)),
      ]
    : rows

  const seen = new Set<string>()
  const out: ReconcileSignalRow[] = []
  for (const row of prioritized) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push({
      id: row.id,
      channel_id: String(row.channel_id),
      telegram_message_id: String(row.telegram_message_id),
      raw_message: row.raw_message ?? '',
      telegram_edit_date_seen:
        row.telegram_edit_date_seen != null && Number.isFinite(Number(row.telegram_edit_date_seen))
          ? Number(row.telegram_edit_date_seen)
          : null,
      created_at: String(row.created_at ?? ''),
      parsed_data: (row as { parsed_data?: Record<string, unknown> }).parsed_data ?? null,
    })
    if (out.length >= maxSignals) break
  }
  return out
}

export async function markSignalsReconciled(
  supabase: SupabaseClient,
  args: {
    signalIds: string[]
    editDateBySignalId?: Map<string, number | null>
  },
): Promise<void> {
  if (!args.signalIds.length) return
  const now = new Date().toISOString()
  for (const signalId of args.signalIds) {
    const editDate = args.editDateBySignalId?.get(signalId)
    const patch: Record<string, unknown> = { telegram_reconciled_at: now }
    if (editDate != null && editDate > 0) {
      patch.telegram_edit_date_seen = Math.floor(editDate)
    }
    await supabase.from('signals').update(patch).eq('id', signalId)
  }
}
