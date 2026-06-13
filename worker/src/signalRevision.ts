/**
 * Same-telegram-message revision (duplicate message_id + changed text).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParseChannelMessageResult } from './parseSignal'
import type { PipelineTimestamps } from './pipelineTimestamps'
import type { SignalRow } from './tradeExecutor'

export const MESSAGE_REVISION_DISPATCH_SOURCE = 'message_revision'

export type ExistingSignalRow = {
  id: string
  user_id: string
  channel_id: string | null
  raw_message: string
  parsed_data: SignalRow['parsed_data']
  status: string
  parent_signal_id: string | null
  is_modification: boolean
  telegram_message_id: string | null
  reply_to_message_id: string | null
  created_at: string
  telegram_edit_date_seen: number | null
}

export function messageTextChanged(stored: string, fetched: string): boolean {
  return stored.trim() !== fetched.trim()
}

/** True when incoming Telegram edit_date is strictly older than what we already stored. */
export function isIncomingRevisionStale(
  storedEditDateSeen: number | null | undefined,
  incomingEditDateSeen: number | null | undefined,
): boolean {
  const stored =
    storedEditDateSeen != null && Number(storedEditDateSeen) > 0
      ? Math.floor(Number(storedEditDateSeen))
      : null
  const incoming =
    incomingEditDateSeen != null && Number(incomingEditDateSeen) > 0
      ? Math.floor(Number(incomingEditDateSeen))
      : null
  if (stored == null || incoming == null) return false
  return incoming < stored
}

export async function loadSignalByTelegramMessage(
  supabase: SupabaseClient,
  args: { userId: string; channelRowId: string; telegramMessageId: string },
): Promise<ExistingSignalRow | null> {
  const { data, error } = await supabase
    .from('signals')
    .select(
      'id,user_id,channel_id,raw_message,parsed_data,status,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at,telegram_edit_date_seen',
    )
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelRowId)
    .eq('telegram_message_id', args.telegramMessageId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as ExistingSignalRow
  row.telegram_edit_date_seen =
    row.telegram_edit_date_seen != null && Number.isFinite(Number(row.telegram_edit_date_seen))
      ? Number(row.telegram_edit_date_seen)
      : null
  return row
}

export async function loadSignalById(
  supabase: SupabaseClient,
  signalId: string,
): Promise<ExistingSignalRow | null> {
  const { data, error } = await supabase
    .from('signals')
    .select(
      'id,user_id,channel_id,raw_message,parsed_data,status,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at,telegram_edit_date_seen',
    )
    .eq('id', signalId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as ExistingSignalRow
  row.telegram_edit_date_seen =
    row.telegram_edit_date_seen != null && Number.isFinite(Number(row.telegram_edit_date_seen))
      ? Number(row.telegram_edit_date_seen)
      : null
  return row
}

export function buildRevisionDispatchRow(
  existing: ExistingSignalRow,
  parseResult: ParseChannelMessageResult,
  pipelineTs?: PipelineTimestamps,
): SignalRow {
  return {
    id: existing.id,
    user_id: existing.user_id,
    channel_id: existing.channel_id,
    parsed_data: parseResult.parsed as SignalRow['parsed_data'],
    status: 'parsed',
    parent_signal_id: existing.parent_signal_id,
    is_modification: existing.is_modification,
    telegram_message_id: existing.telegram_message_id,
    reply_to_message_id: existing.reply_to_message_id,
    created_at: existing.created_at,
    pipeline_ts: pipelineTs,
  }
}

export async function updateSignalAfterRevision(
  supabase: SupabaseClient,
  args: {
    signalId: string
    rawMessage: string
    parseResult: ParseChannelMessageResult
    telegramEditDateSeen?: number | null
  },
): Promise<boolean> {
  const patch: Record<string, unknown> = {
    raw_message: args.rawMessage,
    parsed_data: args.parseResult.parsed,
    status: 'parsed',
    skip_reason: null,
    telegram_reconciled_at: new Date().toISOString(),
  }
  if (args.telegramEditDateSeen != null && args.telegramEditDateSeen > 0) {
    patch.telegram_edit_date_seen = Math.floor(args.telegramEditDateSeen)
  }
  let query = supabase
    .from('signals')
    .update(patch)
    .eq('id', args.signalId)
  if (args.telegramEditDateSeen != null && args.telegramEditDateSeen > 0) {
    const newEdit = Math.floor(args.telegramEditDateSeen)
    query = query.or(`telegram_edit_date_seen.is.null,telegram_edit_date_seen.lte.${newEdit}`)
  }
  const { data, error } = await query.select('id').maybeSingle()
  return !error && data != null
}

export function normalizedTradeAction(action: unknown): 'buy' | 'sell' | null {
  const a = String(action ?? '').toLowerCase()
  if (a === 'buy' || a === 'sell') return a
  return null
}

export function revisionDirectionFlippedFromActions(
  priorAction: unknown,
  nextAction: unknown,
): boolean {
  const oldA = normalizedTradeAction(priorAction)
  const newA = normalizedTradeAction(nextAction)
  if (!oldA || !newA) return false
  return oldA !== newA
}

export function storedMessageDiffersFromTelegram(stored: string, fetched: string): boolean {
  return messageTextChanged(stored, fetched)
}

/** Bare market teaser (e.g. "Gold buy now") that channels often edit seconds later with SL/TP. */
export function entryDispatchLooksSettleable(parsed: {
  action?: unknown
  sl?: unknown
  tp?: unknown
  entry_price?: unknown
  entry_zone_low?: unknown
  entry_zone_high?: unknown
} | null | undefined): boolean {
  const action = String(parsed?.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell') return false
  if (parsed?.sl != null && Number(parsed.sl) > 0) return false
  const tps = Array.isArray(parsed?.tp) ? parsed!.tp : []
  if (tps.some(t => Number(t) > 0)) return false
  if (parsed?.entry_price != null && Number(parsed.entry_price) > 0) return false
  if (parsed?.entry_zone_low != null && Number(parsed.entry_zone_low) > 0) return false
  if (parsed?.entry_zone_high != null && Number(parsed.entry_zone_high) > 0) return false
  return true
}
