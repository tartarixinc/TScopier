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
}

export function messageTextChanged(stored: string, fetched: string): boolean {
  return stored.trim() !== fetched.trim()
}

export async function loadSignalByTelegramMessage(
  supabase: SupabaseClient,
  args: { userId: string; channelRowId: string; telegramMessageId: string },
): Promise<ExistingSignalRow | null> {
  const { data, error } = await supabase
    .from('signals')
    .select(
      'id,user_id,channel_id,raw_message,parsed_data,status,parent_signal_id,is_modification,telegram_message_id,reply_to_message_id,created_at',
    )
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelRowId)
    .eq('telegram_message_id', args.telegramMessageId)
    .maybeSingle()
  if (error || !data) return null
  return data as ExistingSignalRow
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
  },
): Promise<boolean> {
  const { error } = await supabase
    .from('signals')
    .update({
      raw_message: args.rawMessage,
      parsed_data: args.parseResult.parsed,
      status: 'parsed',
      skip_reason: null,
    })
    .eq('id', args.signalId)
  return !error
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
