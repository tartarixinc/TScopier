/**
 * Gate: is the canonical channel feed live for a subscriber?
 * When true in primary mode, passive subscribers skip redundant poll/reconcile.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  channelListenerConfig,
  channelListenerModeEnabled,
  channelListenerPrimaryMode,
  isSignalChannelEnrolled,
  loadSignalChannelMeta,
} from './channelListenerConfig'
import { fetchChannelLeaseReader, isChannelLeaseRowLive } from './channelListenerLease'

const feedLiveCache = new Map<string, { live: boolean; expiresAt: number }>()

function cacheTtlMs(): number {
  return Math.max(2_000, Math.min(30_000, Number(process.env.CHANNEL_FEED_GATE_CACHE_MS ?? 8_000)))
}

async function fetchCanonicalFeedHealthy(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<boolean> {
  const meta = await loadSignalChannelMeta(supabase, signalChannelId)
  if (!meta) return false

  if (!isSignalChannelEnrolled(signalChannelId, meta.telegram_chat_id, meta.subscriber_count)) {
    return false
  }

  const reader = await fetchChannelLeaseReader(supabase, signalChannelId)
  if (!reader) return false

  if (meta.last_live_at) {
    const ageMs = Date.now() - new Date(meta.last_live_at).getTime()
    if (ageMs > channelListenerConfig.feedStaleMs) return false
  }

  const { data: lease } = await supabase
    .from('channel_listener_leases')
    .select('expires_at')
    .eq('signal_channel_id', signalChannelId)
    .maybeSingle()

  return isChannelLeaseRowLive(lease)
}

export async function isChannelFeedLive(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<boolean> {
  if (!channelListenerModeEnabled()) return false

  const cached = feedLiveCache.get(signalChannelId)
  if (cached && cached.expiresAt > Date.now()) return cached.live

  const live = await fetchCanonicalFeedHealthy(supabase, signalChannelId)
  feedLiveCache.set(signalChannelId, { live, expiresAt: Date.now() + cacheTtlMs() })
  return live
}

/** True when subscriber should rely on canonical feed (skip per-user poll/reconcile). */
export async function isChannelFeedLiveForSubscriber(
  supabase: SupabaseClient,
  userId: string,
  signalChannelId: string,
): Promise<boolean> {
  if (!channelListenerPrimaryMode()) return false

  const reader = await fetchChannelLeaseReader(supabase, signalChannelId)
  if (reader === userId) return false

  return isChannelFeedLive(supabase, signalChannelId)
}

export async function loadPassiveSignalChannelIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  const passive = new Set<string>()
  if (!channelListenerPrimaryMode()) return passive

  const { data: rows } = await supabase
    .from('telegram_channels')
    .select('signal_channel_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .not('signal_channel_id', 'is', null)

  for (const row of rows ?? []) {
    const scId = (row as { signal_channel_id?: string }).signal_channel_id
    if (!scId) continue
    if (await isChannelFeedLiveForSubscriber(supabase, userId, scId)) {
      passive.add(scId)
    }
  }

  return passive
}

export function invalidateChannelFeedCache(signalChannelId?: string): void {
  if (signalChannelId) feedLiveCache.delete(signalChannelId)
  else feedLiveCache.clear()
}
