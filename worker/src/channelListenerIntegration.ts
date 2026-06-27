/**
 * Integration hooks for UserListener ↔ channel-scoped listener pipeline.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SignalRow } from './tradeExecutor/types'
import {
  channelListenerModeEnabled,
  channelListenerPrimaryMode,
  channelListenerShadowMode,
  isSignalChannelEnrolled,
  loadSignalChannelMeta,
} from './channelListenerConfig'
import {
  acquireChannelListenerLease,
  fetchChannelLeaseReader,
  isElectedChannelReader,
} from './channelListenerLease'
import {
  compareShadowSignal,
  ingestCanonicalFromReader,
} from './channelCanonicalIngest'
import { loadPassiveSignalChannelIds } from './channelFeedGate'
import { signalChannelBelongsToShard } from './channelReaderRegistry'
import { incMetric } from './workerMetrics'

export interface ChannelRowWithRegistry {
  id: string
  channel_id: string
  channel_username: string
  signal_channel_id?: string | null
  last_seen_message_id?: number | string | null
  last_seen_at?: string | null
  last_live_at?: string | null
}

export async function refreshPassiveSignalChannels(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  if (!channelListenerPrimaryMode()) return new Set()
  return loadPassiveSignalChannelIds(supabase, userId)
}

export async function resolveSignalChannelIdForRow(
  supabase: SupabaseClient,
  row: ChannelRowWithRegistry,
): Promise<string | null> {
  if (row.signal_channel_id) return row.signal_channel_id
  const { data } = await supabase
    .from('telegram_channels')
    .select('signal_channel_id')
    .eq('id', row.id)
    .maybeSingle()
  return (data as { signal_channel_id?: string | null } | null)?.signal_channel_id ?? null
}

export async function shouldSkipPassiveChannelIngest(
  supabase: SupabaseClient,
  userId: string,
  signalChannelId: string,
  passiveCache: Set<string>,
): Promise<boolean> {
  if (!channelListenerPrimaryMode()) return false
  if (passiveCache.has(signalChannelId)) return true
  const passive = await loadPassiveSignalChannelIds(supabase, userId)
  for (const id of passive) passiveCache.add(id)
  return passiveCache.has(signalChannelId)
}

/** Try to acquire channel listener leases for enrolled channels this user subscribes to. */
export async function syncUserChannelReaderLeases(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  if (!channelListenerModeEnabled()) return 0

  const { data: subs } = await supabase
    .from('telegram_channels')
    .select('signal_channel_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .not('signal_channel_id', 'is', null)

  let acquired = 0
  for (const row of subs ?? []) {
    const scId = (row as { signal_channel_id: string }).signal_channel_id
    if (!scId || !signalChannelBelongsToShard(scId)) continue

    const meta = await loadSignalChannelMeta(supabase, scId)
    if (!meta || !isSignalChannelEnrolled(scId, meta.telegram_chat_id, meta.subscriber_count)) {
      continue
    }

    const currentReader = await fetchChannelLeaseReader(supabase, scId)
    if (currentReader && currentReader !== userId) continue

    const result = await acquireChannelListenerLease(supabase, scId, userId)
    if (result.ok) {
      acquired++
      incMetric('channel_reader_lease_acquired')
    }
  }
  return acquired
}

export interface PostParseChannelArgs {
  supabase: SupabaseClient
  userId: string
  channelRow: ChannelRowWithRegistry
  signalChannelId: string
  messageId: string
  rawMessage: string
  replyToMessageId: string | null
  parseResult: {
    parsed: Record<string, unknown>
    status: string
    skip_reason: string | null
  }
  pipelineTs?: Record<string, unknown>
  dispatch?: (row: SignalRow) => boolean | void
}

/**
 * After parse on elected reader: write canonical store; in primary mode fan-out via projector.
 * Returns true when per-user ingest/dispatch should be skipped (primary + elected reader).
 */
export async function handlePostParseChannelIngest(
  args: PostParseChannelArgs,
): Promise<{ skipPerUserIngest: boolean; canonicalWritten: boolean }> {
  if (!channelListenerModeEnabled()) {
    return { skipPerUserIngest: false, canonicalWritten: false }
  }

  const elected = await isElectedChannelReader(args.supabase, args.signalChannelId, args.userId)
  if (!elected) return { skipPerUserIngest: false, canonicalWritten: false }

  const { canonical, projected } = await ingestCanonicalFromReader(
    args.supabase,
    {
      signalChannelId: args.signalChannelId,
      telegramMessageId: args.messageId,
      rawMessage: args.rawMessage,
      replyToMessageId: args.replyToMessageId,
      parseResult: args.parseResult,
      pipelineTs: args.pipelineTs ?? null,
    },
    args.dispatch,
  )

  if (channelListenerShadowMode() && canonical) {
    await compareShadowSignal(args.supabase, {
      userId: args.userId,
      subscriptionRowId: args.channelRow.id,
      signalChannelId: args.signalChannelId,
      telegramMessageId: args.messageId,
      canonicalParsed: args.parseResult.parsed,
      canonicalStatus: args.parseResult.status,
      userParsed: args.parseResult.parsed,
      userStatus: args.parseResult.status,
    })
  }

  if (channelListenerPrimaryMode()) {
    incMetric('channel_primary_reader_ingest')
    if (projected > 0) incMetric('channel_primary_projected', projected)
    return { skipPerUserIngest: true, canonicalWritten: Boolean(canonical) }
  }

  return { skipPerUserIngest: false, canonicalWritten: Boolean(canonical) }
}

export function isChannelRowPassive(
  signalChannelId: string | null | undefined,
  passiveCache: Set<string>,
): boolean {
  if (!signalChannelId || !channelListenerPrimaryMode()) return false
  return passiveCache.has(signalChannelId)
}
