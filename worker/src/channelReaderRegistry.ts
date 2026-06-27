/**
 * Channel reader registry — enrollment, election, and reader assignment per signal_channel.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  channelListenerModeEnabled,
  isSignalChannelEnrolled,
  recordSignalChannelMetric,
} from './channelListenerConfig'
import {
  ensureChannelReaderElected,
  fetchChannelLeaseReader,
  renewChannelListenerLease,
  electReaderCandidate,
} from './channelListenerLease'
import { workerConfig, shardForSignalChannelId } from './workerConfig'

export interface EnrolledChannel {
  signalChannelId: string
  telegramChatId: string
  subscriberCount: number
  readerUserId: string | null
}

export async function listEnrolledSignalChannels(
  supabase: SupabaseClient,
): Promise<EnrolledChannel[]> {
  if (!channelListenerModeEnabled()) return []

  const { data } = await supabase
    .from('signal_channels')
    .select('id, telegram_chat_id, subscriber_count')
    .gt('subscriber_count', 0)
    .order('subscriber_count', { ascending: false })

  const out: EnrolledChannel[] = []
  for (const row of data ?? []) {
    const r = row as { id: string; telegram_chat_id: string; subscriber_count: number }
    if (!isSignalChannelEnrolled(r.id, r.telegram_chat_id, r.subscriber_count)) continue
    if (!signalChannelBelongsToShard(r.id)) continue

    const readerUserId = await fetchChannelLeaseReader(supabase, r.id)
    out.push({
      signalChannelId: r.id,
      telegramChatId: r.telegram_chat_id,
      subscriberCount: r.subscriber_count,
      readerUserId,
    })
  }
  return out
}

export function signalChannelBelongsToShard(signalChannelId: string): boolean {
  if (workerConfig.shardCount <= 1) return true
  return shardForSignalChannelId(signalChannelId, workerConfig.shardCount) === workerConfig.shardId
}

/** Ensure every enrolled channel on this shard has an elected reader. */
export async function syncChannelReaders(
  supabase: SupabaseClient,
): Promise<{ elected: number; total: number }> {
  const channels = await listEnrolledSignalChannels(supabase)
  let elected = 0

  for (const ch of channels) {
    if (ch.readerUserId) continue
    const result = await ensureChannelReaderElected(supabase, ch.signalChannelId)
    if (result.elected) {
      elected++
      recordSignalChannelMetric(ch.signalChannelId, 'channel_reader_elected')
      console.log(
        `[channelReaderRegistry] elected reader user=${result.readerUserId} signalChannel=${ch.signalChannelId}`,
      )
    }
  }

  return { elected, total: channels.length }
}

/** Renew leases for channels where this worker holds the reader session. */
export async function renewChannelLeasesForReader(
  supabase: SupabaseClient,
  readerUserId: string,
): Promise<number> {
  const { data } = await supabase
    .from('channel_listener_leases')
    .select('signal_channel_id')
    .eq('reader_user_id', readerUserId)
    .gt('expires_at', new Date(Date.now() - 5_000).toISOString())

  let renewed = 0
  for (const row of data ?? []) {
    const scId = (row as { signal_channel_id: string }).signal_channel_id
    if (!signalChannelBelongsToShard(scId)) continue
    const ok = await renewChannelListenerLease(supabase, scId, readerUserId)
    if (ok) renewed++
  }
  return renewed
}

/** Failover: re-elect when reader subscription deactivated. */
export async function failoverChannelReader(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<string | null> {
  const current = await fetchChannelLeaseReader(supabase, signalChannelId)
  if (current) {
    const { data: stillActive } = await supabase
      .from('telegram_channels')
      .select('id')
      .eq('user_id', current)
      .eq('signal_channel_id', signalChannelId)
      .eq('is_active', true)
      .maybeSingle()

    if (stillActive) return current
  }

  const candidate = await electReaderCandidate(supabase, signalChannelId)
  if (!candidate) return null

  const result = await ensureChannelReaderElected(supabase, signalChannelId)
  return result.readerUserId
}
