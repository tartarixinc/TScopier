/**
 * Canonical ingest (channel_messages + channel_signals) and shadow compare.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import {
  channelListenerPrimaryMode,
  channelListenerShadowMode,
  recordSignalChannelMetric,
} from './channelListenerConfig'
import { projectChannelSignalToSubscribers, type CanonicalChannelSignal } from './channelSignalProjector'
import type { ProjectorDispatchFn } from './channelSignalProjector'
import { incMetric } from './workerMetrics'
import { persistListenerEvent } from './listenerEvents'

export interface CanonicalIngestInput {
  signalChannelId: string
  telegramMessageId: string
  rawMessage: string
  replyToMessageId?: string | null
  editDate?: Date | null
  parseResult: {
    parsed: Record<string, unknown>
    status: string
    skip_reason: string | null
  }
  pipelineTs?: Record<string, unknown> | null
}

export async function writeChannelMessage(
  supabase: SupabaseClient,
  input: {
    signalChannelId: string
    telegramMessageId: string
    rawMessage: string
    replyToMessageId?: string | null
    editDate?: Date | null
  },
): Promise<void> {
  const { error } = await supabase.from('channel_messages').upsert(
    {
      signal_channel_id: input.signalChannelId,
      telegram_message_id: input.telegramMessageId,
      raw_message: input.rawMessage,
      reply_to_message_id: input.replyToMessageId ?? null,
      edit_date: input.editDate?.toISOString() ?? null,
      received_at: new Date().toISOString(),
    },
    { onConflict: 'signal_channel_id,telegram_message_id' },
  )
  if (error) {
    console.error('[channelCanonicalIngest] channel_messages upsert failed:', error.message)
    return
  }

  await supabase
    .from('signal_channels')
    .update({ last_live_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', input.signalChannelId)

  recordSignalChannelMetric(input.signalChannelId, 'channel_message_ingested')
}

export async function writeChannelSignal(
  supabase: SupabaseClient,
  input: CanonicalIngestInput,
): Promise<CanonicalChannelSignal | null> {
  await writeChannelMessage(supabase, {
    signalChannelId: input.signalChannelId,
    telegramMessageId: input.telegramMessageId,
    rawMessage: input.rawMessage,
    replyToMessageId: input.replyToMessageId,
    editDate: input.editDate ?? null,
  })

  const channelSignalId = randomUUID()
  const { data, error } = await supabase
    .from('channel_signals')
    .upsert(
      {
        id: channelSignalId,
        signal_channel_id: input.signalChannelId,
        telegram_message_id: input.telegramMessageId,
        raw_message: input.rawMessage,
        parsed_data: input.parseResult.parsed,
        status: input.parseResult.status,
        skip_reason: input.parseResult.skip_reason,
        parent_message_id: input.replyToMessageId ?? null,
        pipeline_ts: input.pipelineTs ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'signal_channel_id,telegram_message_id' },
    )
    .select('id, signal_channel_id, telegram_message_id, raw_message, parsed_data, status, skip_reason, parent_message_id, pipeline_ts')
    .single()

  if (error) {
    console.error('[channelCanonicalIngest] channel_signals upsert failed:', error.message)
    return null
  }

  recordSignalChannelMetric(input.signalChannelId, 'channel_signal_ingested')
  incMetric('channel_signal_canonical_written')
  return data as CanonicalChannelSignal
}

function parsedActionMatch(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  const actionA = String(a?.action ?? '').toLowerCase()
  const actionB = String(b?.action ?? '').toLowerCase()
  if (actionA !== actionB) return false
  const symA = String(a?.symbol ?? '').toUpperCase()
  const symB = String(b?.symbol ?? '').toUpperCase()
  return symA === symB
}

/** Compare canonical parse to per-user signal; log shadow mismatches. */
export async function compareShadowSignal(
  supabase: SupabaseClient,
  args: {
    userId: string
    subscriptionRowId: string
    signalChannelId: string
    telegramMessageId: string
    canonicalParsed: Record<string, unknown>
    canonicalStatus: string
    userParsed: Record<string, unknown>
    userStatus: string
  },
): Promise<void> {
  const match = parsedActionMatch(args.canonicalParsed, args.userParsed)
    && args.canonicalStatus === args.userStatus

  if (match) {
    incMetric('channel_shadow_match')
    recordSignalChannelMetric(args.signalChannelId, 'channel_shadow_match')
    return
  }

  incMetric('channel_shadow_mismatch')
  recordSignalChannelMetric(args.signalChannelId, 'channel_shadow_mismatch')

  void persistListenerEvent(supabase, {
    userId: args.userId,
    eventType: 'channel_shadow_mismatch',
    channelRowId: args.subscriptionRowId,
    telegramMessageId: args.telegramMessageId,
    detail: {
      signal_channel_id: args.signalChannelId,
      canonical_status: args.canonicalStatus,
      user_status: args.userStatus,
      canonical_action: args.canonicalParsed?.action,
      user_action: args.userParsed?.action,
    },
  })
}

/**
 * Handle canonical write after elected reader parses a message.
 * In primary mode, also projects to all subscribers.
 */
export async function ingestCanonicalFromReader(
  supabase: SupabaseClient,
  input: CanonicalIngestInput,
  dispatch?: ProjectorDispatchFn,
): Promise<{ canonical: CanonicalChannelSignal | null; projected: number }> {
  if (!channelListenerShadowMode() && !channelListenerPrimaryMode()) {
    return { canonical: null, projected: 0 }
  }

  const canonical = await writeChannelSignal(supabase, input)
  if (!canonical) return { canonical: null, projected: 0 }

  if (channelListenerPrimaryMode()) {
    const { projected } = await projectChannelSignalToSubscribers(supabase, canonical, dispatch)
    return { canonical, projected }
  }

  return { canonical, projected: 0 }
}
