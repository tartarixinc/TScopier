/**
 * Same-telegram-message revision (duplicate message_id + changed text).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParseChannelMessageResult } from './parseSignal'
import type { PipelineTimestamps } from './pipelineTimestamps'
import type { SignalRow } from './tradeExecutor'
import { parsedMissesLabeledEntry } from './signalEntryNowRequirement'

export const MESSAGE_REVISION_DISPATCH_SOURCE = 'message_revision'

export type ExistingSignalRow = {
  id: string
  user_id: string
  channel_id: string | null
  raw_message: string
  parsed_data: SignalRow['parsed_data']
  status: string
  skip_reason: string | null
  parent_signal_id: string | null
  is_modification: boolean
  telegram_message_id: string | null
  reply_to_message_id: string | null
  created_at: string
  telegram_edit_date_seen: number | null
  user_override?: Record<string, unknown> | null
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
      'id,user_id,channel_id,raw_message,parsed_data,status,skip_reason,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at,telegram_edit_date_seen,user_override',
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
      'id,user_id,channel_id,raw_message,parsed_data,status,skip_reason,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at,telegram_edit_date_seen,user_override',
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
  telegramEditDateSeen?: number | null,
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
    telegram_edit_date_seen:
      telegramEditDateSeen != null && telegramEditDateSeen > 0
        ? Math.floor(telegramEditDateSeen)
        : existing.telegram_edit_date_seen,
  }
}

export async function updateSignalAfterRevision(
  supabase: SupabaseClient,
  args: {
    signalId: string
    rawMessage: string
    parseResult: ParseChannelMessageResult
    telegramEditDateSeen?: number | null
    /** When the signal already executed, keep status so revision refresh cannot downgrade it. */
    existingStatus?: string | null
  },
): Promise<boolean> {
  const keepExecutionStatus = args.existingStatus === 'executed'
  const patch: Record<string, unknown> = {
    raw_message: args.rawMessage,
    parsed_data: args.parseResult.parsed,
    telegram_reconciled_at: new Date().toISOString(),
  }
  // Upgrade skipped → parsed when a revision finds a real trade (do not leave UI stuck on Skipped).
  // Keep executed as-is so cosmetic edits cannot downgrade an already-filled signal.
  if (!keepExecutionStatus) {
    if (args.parseResult.status === 'parsed') {
      patch.status = 'parsed'
      patch.skip_reason = null
    } else if (args.existingStatus !== 'skipped') {
      patch.status = args.parseResult.status
      patch.skip_reason = args.parseResult.skip_reason
    }
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

export function parsedHasExplicitStopsOrTargets(parsed: {
  sl?: unknown
  tp?: unknown
} | null | undefined): boolean {
  if (parsed?.sl != null && Number(parsed.sl) > 0) return true
  const tps = Array.isArray(parsed?.tp) ? parsed.tp : []
  return tps.some(t => Number(t) > 0)
}

type RevisionParsedFields = {
  action?: unknown
  sl?: unknown
  tp?: unknown
  entry_price?: unknown
  entry_zone_low?: unknown
  entry_zone_high?: unknown
  raw_instruction?: unknown
}

/**
 * True when the message labels an entry price/zone/level but the deterministic parse has no
 * anchor — a parser gap. Such a revision must not be trusted on its own; let the AI try.
 */
function revisedMissesLabeledEntry(revisedParsed: RevisionParsedFields | null | undefined): boolean {
  return parsedMissesLabeledEntry(revisedParsed, String(revisedParsed?.raw_instruction ?? ''))
}

/** Bare entry was edited into a fully-parameterized entry on the same Telegram message. */
export function revisionCompletesSettleableEntry(
  priorParsed: RevisionParsedFields | null | undefined,
  revisedParsed: RevisionParsedFields | null | undefined,
): boolean {
  if (revisedMissesLabeledEntry(revisedParsed)) return false
  return entryDispatchLooksSettleable(priorParsed)
    && !entryDispatchLooksSettleable(revisedParsed)
    && parsedHasExplicitStopsOrTargets(revisedParsed)
}

/**
 * True when a deterministic re-parse of an edited Telegram message is actionable
 * without AI: teaser→full completion, SL/TP ladder edits on an already-complete
 * entry, or an explicit modify with stops.
 */
export function revisionHasDeterministicActionableParse(
  priorParsed: RevisionParsedFields | null | undefined,
  revisedParsed: RevisionParsedFields | null | undefined,
): boolean {
  if (!revisedParsed) return false
  if (revisionCompletesSettleableEntry(priorParsed, revisedParsed)) return true
  const action = String(revisedParsed.action ?? '').toLowerCase()
  if (!parsedHasExplicitStopsOrTargets(revisedParsed)) return false
  // If the message labels an entry the parser could not read, let the AI try — for
  // buy/sell and modify alike.
  if (revisedMissesLabeledEntry(revisedParsed)) return false
  if (action === 'modify') return true
  if (action !== 'buy' && action !== 'sell') return false
  // Same-direction (or first-time) entry edit that carries explicit SL/TP — e.g.
  // "Gold sell now / TP … / SL …" edited from one ladder to another.
  const priorAction = normalizedTradeAction(priorParsed?.action)
  if (priorAction == null || priorAction === action) return true
  return false
}

export function isOpenAiRateLimitMessage(message: string | null | undefined): boolean {
  const text = String(message ?? '').toLowerCase()
  return text.includes('openai http 429')
    || text.includes('rate limit')
    || text.includes('current quota')
    || text.includes('insufficient_quota')
    || text.includes('too many requests')
}
