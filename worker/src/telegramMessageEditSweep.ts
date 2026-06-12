/**
 * Poll-based detection for silent Telegram message edits (no EditedMessage event).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const EDIT_SWEEP_WINDOW_MS = Math.max(
  60_000,
  Math.min(24 * 60 * 60_000, Number(process.env.TELEGRAM_EDIT_SWEEP_WINDOW_MS ?? 4 * 60 * 60_000)),
)
export const EDIT_SWEEP_INTERVAL_MS = Math.max(
  10_000,
  Math.min(120_000, Number(process.env.TELEGRAM_EDIT_SWEEP_MS ?? 30_000)),
)
export const EDIT_SWEEP_MAX_SIGNALS = Math.max(
  10,
  Math.min(200, Number(process.env.TELEGRAM_EDIT_SWEEP_MAX_SIGNALS ?? 80)),
)
export const EDIT_POLL_HOOK_WINDOW_MS = Math.max(
  30_000,
  Math.min(6 * 60 * 60_000, Number(process.env.TELEGRAM_EDIT_POLL_HOOK_WINDOW_MS ?? 2 * 60 * 60_000)),
)
export const EDIT_POLL_HOOK_MAX_SIGNALS = Math.max(
  5,
  Math.min(50, Number(process.env.TELEGRAM_EDIT_POLL_HOOK_MAX_SIGNALS ?? 20)),
)
export const TELEGRAM_MESSAGE_ID_BATCH_SIZE = 100

export type EditSweepSignalRow = {
  id: string
  channel_id: string
  telegram_message_id: string
  raw_message: string
  telegram_message_edit_date: number | null
}

export type TelegramMessageSnapshot = {
  text: string
  editDateSec: number | null
}

export type EditSweepCandidate = {
  signal: EditSweepSignalRow
  rawMessage: string
  editDateSec: number | null
}

export function messageTextChanged(stored: string, fetched: string): boolean {
  return stored.trim() !== fetched.trim()
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
  return String(m.text ?? m.message ?? '').trim()
}

export function shouldCheckMessageForEdit(
  stored: Pick<EditSweepSignalRow, 'raw_message' | 'telegram_message_edit_date'>,
  fetched: TelegramMessageSnapshot,
): boolean {
  const storedEdit = stored.telegram_message_edit_date
  const fetchedEdit = fetched.editDateSec
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

export function findEditedSignals(
  signals: EditSweepSignalRow[],
  telegramByMessageId: Map<string, TelegramMessageSnapshot>,
): EditSweepCandidate[] {
  const out: EditSweepCandidate[] = []
  for (const signal of signals) {
    const mid = signal.telegram_message_id?.trim()
    if (!mid) continue
    const snap = telegramByMessageId.get(mid)
    if (!snap) continue
    if (!shouldCheckMessageForEdit(signal, snap)) continue
    out.push({
      signal,
      rawMessage: snap.text,
      editDateSec: snap.editDateSec,
    })
  }
  return out
}

export function groupSignalsByChannel(
  signals: EditSweepSignalRow[],
): Map<string, EditSweepSignalRow[]> {
  const grouped = new Map<string, EditSweepSignalRow[]>()
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

const EDIT_SWEEP_STATUSES = ['parsed', 'executed'] as const

export async function loadSignalsForEditSweep(
  supabase: SupabaseClient,
  args: {
    userId: string
    windowMs?: number
    maxSignals?: number
    channelRowId?: string
    openTradesOnly?: boolean
  },
): Promise<EditSweepSignalRow[]> {
  const windowMs = args.windowMs ?? EDIT_SWEEP_WINDOW_MS
  const maxSignals = args.maxSignals ?? EDIT_SWEEP_MAX_SIGNALS
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
      ((openTrades ?? []) as Array<{ signal_id?: string }>)
        .map(r => r.signal_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
  }

  const selectWithEditDate =
    'id,channel_id,telegram_message_id,raw_message,telegram_message_edit_date,created_at'
  const selectWithoutEditDate =
    'id,channel_id,telegram_message_id,raw_message,created_at'

  const runQuery = async (select: string) => {
    let query = supabase
      .from('signals')
      .select(select)
      .eq('user_id', args.userId)
      .not('telegram_message_id', 'is', null)
      .in('status', [...EDIT_SWEEP_STATUSES])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(Math.min(maxSignals * 3, 240))
    if (args.channelRowId) {
      query = query.eq('channel_id', args.channelRowId)
    }
    return query
  }

  let { data, error } = await runQuery(selectWithEditDate)
  if (error && /telegram_message_edit_date/i.test(String(error.message ?? ''))) {
    ;({ data, error } = await runQuery(selectWithoutEditDate))
  }
  if (error || !data?.length) return []

  const rows = (data as unknown as Array<EditSweepSignalRow & { created_at?: string }>)
    .filter(r => r.channel_id && r.telegram_message_id)

  const prioritized = openSignalIds
    ? [
        ...rows.filter(r => openSignalIds!.has(r.id)),
        ...rows.filter(r => !openSignalIds!.has(r.id)),
      ]
    : rows

  const seen = new Set<string>()
  const out: EditSweepSignalRow[] = []
  for (const row of prioritized) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push({
      id: row.id,
      channel_id: row.channel_id,
      telegram_message_id: String(row.telegram_message_id),
      raw_message: row.raw_message ?? '',
      telegram_message_edit_date:
        row.telegram_message_edit_date != null && Number.isFinite(Number(row.telegram_message_edit_date))
          ? Number(row.telegram_message_edit_date)
          : null,
    })
    if (out.length >= maxSignals) break
  }
  return out
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
