/**
 * Permanent signal_channels registry + subscription linking + inherit-on-add.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { normalizeTelegramChatId, isNumericTelegramChatId } from './telegramChatId'
import { channelListenerConfig, recordSignalChannelMetric } from './channelListenerConfig'

export interface SignalChannelMeta {
  id: string
  telegram_chat_id: string
  channel_username: string
  display_name: string
  subscriber_count: number
  last_live_at: string | null
}

export interface ResolveSignalChannelInput {
  telegramChatId: string
  channelUsername?: string | null
  displayName?: string | null
}

/** Upsert permanent registry row; reuse existing channel when telegram_chat_id matches. */
export async function resolveOrCreateSignalChannel(
  supabase: SupabaseClient,
  input: ResolveSignalChannelInput,
): Promise<SignalChannelMeta | null> {
  const rawChatId = String(input.telegramChatId ?? '').trim()
  const telegramChatId = isNumericTelegramChatId(rawChatId)
    ? normalizeTelegramChatId(rawChatId)
    : rawChatId

  if (!telegramChatId) return null

  const username = String(input.channelUsername ?? '').trim().replace(/^@/, '').toLowerCase()
  const displayName = String(input.displayName ?? '').trim() || telegramChatId

  const { data, error } = await supabase
    .from('signal_channels')
    .upsert(
      {
        telegram_chat_id: telegramChatId,
        channel_username: username,
        display_name: displayName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_chat_id' },
    )
    .select('id, telegram_chat_id, channel_username, display_name, subscriber_count, last_live_at')
    .single()

  if (error) {
    console.error('[channelRegistry] resolveOrCreateSignalChannel failed:', error.message)
    return null
  }

  recordSignalChannelMetric(data.id as string, 'signal_channel_registry_upsert')
  return data as SignalChannelMeta
}

/** Link telegram_channels subscription row to registry (returns signal_channel_id). */
export async function linkSubscriptionToSignalChannel(
  supabase: SupabaseClient,
  subscriptionRowId: string,
  signalChannelId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('telegram_channels')
    .update({ signal_channel_id: signalChannelId, updated_at: new Date().toISOString() })
    .eq('id', subscriptionRowId)
    .is('signal_channel_id', null)

  if (error) {
    console.error('[channelRegistry] linkSubscription failed:', error.message)
    return false
  }
  return true
}

/** Ensure subscription has signal_channel_id; upsert registry if needed. */
export async function ensureSubscriptionLinked(
  supabase: SupabaseClient,
  args: {
    userId: string
    subscriptionRowId: string
    telegramChatId: string
    channelUsername?: string | null
    displayName?: string | null
  },
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('telegram_channels')
    .select('signal_channel_id')
    .eq('id', args.subscriptionRowId)
    .maybeSingle()

  const linked = (existing as { signal_channel_id?: string | null } | null)?.signal_channel_id
  if (linked) return linked

  const registry = await resolveOrCreateSignalChannel(supabase, {
    telegramChatId: args.telegramChatId,
    channelUsername: args.channelUsername,
    displayName: args.displayName,
  })
  if (!registry) return null

  const { error } = await supabase
    .from('telegram_channels')
    .update({ signal_channel_id: registry.id, updated_at: new Date().toISOString() })
    .eq('id', args.subscriptionRowId)
    .eq('user_id', args.userId)

  if (error) {
    console.error('[channelRegistry] ensureSubscriptionLinked update failed:', error.message)
    return null
  }

  return registry.id
}

/** Project recent canonical channel_signals into user signals for management context. */
export async function inheritChannelHistory(
  supabase: SupabaseClient,
  userId: string,
  signalChannelId: string,
  opts?: { backfillHours?: number },
): Promise<{ projected: number }> {
  const hours = opts?.backfillHours ?? channelListenerConfig.inheritBackfillHours
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

  const { data: subscription } = await supabase
    .from('telegram_channels')
    .select('id')
    .eq('user_id', userId)
    .eq('signal_channel_id', signalChannelId)
    .eq('is_active', true)
    .maybeSingle()

  const subscriptionId = (subscription as { id?: string } | null)?.id
  if (!subscriptionId) return { projected: 0 }

  const { data: canonicalRows } = await supabase
    .from('channel_signals')
    .select('id, telegram_message_id, raw_message, parsed_data, status, skip_reason, parent_message_id, pipeline_ts, created_at')
    .eq('signal_channel_id', signalChannelId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(500)

  let projected = 0
  for (const row of canonicalRows ?? []) {
    const r = row as {
      id: string
      telegram_message_id: string
      raw_message: string
      parsed_data: Record<string, unknown> | null
      status: string
      skip_reason: string | null
      parent_message_id: string | null
      pipeline_ts: Record<string, unknown> | null
    }
    const signalId = randomUUID()
    const { error } = await supabase.from('signals').upsert(
      {
        id: signalId,
        user_id: userId,
        channel_id: subscriptionId,
        channel_signal_id: r.id,
        raw_message: r.raw_message,
        parsed_data: r.parsed_data,
        status: r.status,
        skip_reason: r.skip_reason,
        telegram_message_id: r.telegram_message_id,
        reply_to_message_id: r.parent_message_id,
        is_modification: Boolean(r.parent_message_id),
      },
      { onConflict: 'user_id,channel_id,telegram_message_id', ignoreDuplicates: true },
    )
    if (!error) projected++
  }

  if (projected > 0) {
    recordSignalChannelMetric(signalChannelId, 'channel_inherit_backfill', projected)
    console.log(
      `[channelRegistry] inheritChannelHistory user=${userId} signalChannel=${signalChannelId} projected=${projected}`,
    )
  }

  return { projected }
}

/** Full add-channel hook: registry upsert + subscription link + optional backfill. */
export async function onChannelSubscriptionAdded(
  supabase: SupabaseClient,
  args: {
    userId: string
    subscriptionRowId: string
    telegramChatId: string
    channelUsername?: string | null
    displayName?: string | null
    inheritHistory?: boolean
  },
): Promise<{ signalChannelId: string | null; inherited: number }> {
  const signalChannelId = await ensureSubscriptionLinked(supabase, args)
  if (!signalChannelId) return { signalChannelId: null, inherited: 0 }

  let inherited = 0
  if (args.inheritHistory !== false) {
    const result = await inheritChannelHistory(supabase, args.userId, signalChannelId)
    inherited = result.projected
  }

  return { signalChannelId, inherited }
}

/** Backfill unlinked active subscriptions (worker startup hygiene). */
export async function backfillUnlinkedSubscriptions(supabase: SupabaseClient): Promise<number> {
  const { data: rows } = await supabase
    .from('telegram_channels')
    .select('id, user_id, channel_id, channel_username, display_name')
    .eq('is_active', true)
    .is('signal_channel_id', null)
    .limit(200)

  let linked = 0
  for (const row of rows ?? []) {
    const r = row as {
      id: string
      user_id: string
      channel_id: string
      channel_username: string
      display_name: string
    }
    if (!isNumericTelegramChatId(r.channel_id)) continue
    const id = await ensureSubscriptionLinked(supabase, {
      userId: r.user_id,
      subscriptionRowId: r.id,
      telegramChatId: r.channel_id,
      channelUsername: r.channel_username,
      displayName: r.display_name,
    })
    if (id) linked++
  }
  return linked
}
