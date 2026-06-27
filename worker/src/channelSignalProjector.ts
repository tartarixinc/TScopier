/**
 * Project canonical channel_signals → per-user signals + parallel fan-out dispatch.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import type { SignalRow } from './tradeExecutor/types'
import { recordSignalChannelMetric } from './channelListenerConfig'
import { parallelMap } from './parallelPool'
import { incMetric } from './workerMetrics'

export interface CanonicalChannelSignal {
  id: string
  signal_channel_id: string
  telegram_message_id: string
  raw_message: string
  parsed_data: Record<string, unknown> | null
  status: string
  skip_reason: string | null
  parent_message_id: string | null
  pipeline_ts: Record<string, unknown> | null
}

export interface ProjectorDispatchFn {
  (row: SignalRow): boolean | void
}

async function loadActiveSubscriptions(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<Array<{ id: string; user_id: string }>> {
  const { data } = await supabase
    .from('telegram_channels')
    .select('id, user_id')
    .eq('signal_channel_id', signalChannelId)
    .eq('is_active', true)

  return (data ?? []) as Array<{ id: string; user_id: string }>
}

async function resolveParentSignalId(
  supabase: SupabaseClient,
  userId: string,
  subscriptionId: string,
  parentTelegramMessageId: string | null,
): Promise<string | null> {
  if (!parentTelegramMessageId) return null
  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_id', subscriptionId)
    .eq('telegram_message_id', parentTelegramMessageId)
    .maybeSingle()
  return (data as { id?: string } | null)?.id ?? null
}

/** Upsert one canonical signal into a single user's signals table. */
export async function projectChannelSignalToUser(
  supabase: SupabaseClient,
  canonical: CanonicalChannelSignal,
  subscription: { id: string; user_id: string },
): Promise<SignalRow | null> {
  const parentSignalId = await resolveParentSignalId(
    supabase,
    subscription.user_id,
    subscription.id,
    canonical.parent_message_id,
  )

  const { data: existing } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', subscription.user_id)
    .eq('channel_id', subscription.id)
    .eq('telegram_message_id', canonical.telegram_message_id)
    .maybeSingle()

  const signalId = (existing as { id?: string } | null)?.id ?? randomUUID()

  const rowPatch = {
    id: signalId,
    user_id: subscription.user_id,
    channel_id: subscription.id,
    channel_signal_id: canonical.id,
    raw_message: canonical.raw_message,
    parsed_data: canonical.parsed_data,
    status: canonical.status,
    skip_reason: canonical.skip_reason,
    telegram_message_id: canonical.telegram_message_id,
    is_modification: Boolean(canonical.parent_message_id),
    parent_signal_id: parentSignalId,
    reply_to_message_id: canonical.parent_message_id,
  }

  const { error } = await supabase.from('signals').upsert(rowPatch, {
    onConflict: 'user_id,channel_id,telegram_message_id',
    ignoreDuplicates: false,
  })

  if (error) {
    console.error(
      `[channelSignalProjector] upsert failed user=${subscription.user_id} msg=${canonical.telegram_message_id}:`,
      error.message,
    )
    return null
  }

  return {
    id: signalId,
    user_id: subscription.user_id,
    channel_id: subscription.id,
    raw_message: canonical.raw_message,
    parsed_data: canonical.parsed_data,
    status: canonical.status,
    skip_reason: canonical.skip_reason,
    telegram_message_id: canonical.telegram_message_id,
    is_modification: Boolean(canonical.parent_message_id),
    parent_signal_id: parentSignalId,
    reply_to_message_id: canonical.parent_message_id,
    dispatch_source: 'channel_projector',
  } as SignalRow
}

/** Fan-out one canonical channel_signal to all active subscriptions. */
export async function projectChannelSignalToSubscribers(
  supabase: SupabaseClient,
  canonical: CanonicalChannelSignal,
  dispatch?: ProjectorDispatchFn,
): Promise<{ projected: number; dispatched: number }> {
  const subscriptions = await loadActiveSubscriptions(supabase, canonical.signal_channel_id)
  if (!subscriptions.length) return { projected: 0, dispatched: 0 }

  let projected = 0
  let dispatched = 0

  await parallelMap(
    subscriptions,
    Math.min(12, subscriptions.length),
    async sub => {
      const row = await projectChannelSignalToUser(supabase, canonical, sub)
      if (!row) return
      projected++
      incMetric('channel_signal_projected')
      recordSignalChannelMetric(canonical.signal_channel_id, 'channel_signal_projected')

      if (dispatch) {
        const ok = dispatch(row) === true
        if (ok) {
          dispatched++
          incMetric('channel_signal_dispatched')
        }
      }
    },
  )

  return { projected, dispatched }
}

/** Load canonical row by id and project to all subscribers. */
export async function projectChannelSignalById(
  supabase: SupabaseClient,
  channelSignalId: string,
  dispatch?: ProjectorDispatchFn,
): Promise<{ projected: number; dispatched: number }> {
  const { data } = await supabase
    .from('channel_signals')
    .select('id, signal_channel_id, telegram_message_id, raw_message, parsed_data, status, skip_reason, parent_message_id, pipeline_ts')
    .eq('id', channelSignalId)
    .maybeSingle()

  if (!data) return { projected: 0, dispatched: 0 }
  return projectChannelSignalToSubscribers(supabase, data as CanonicalChannelSignal, dispatch)
}
