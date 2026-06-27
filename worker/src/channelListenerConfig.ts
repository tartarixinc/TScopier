/**
 * Channel-scoped listener feature flags and enrollment helpers.
 *
 * CHANNEL_LISTENER_MODE:
 *   off      — per-user ingest only (default, rollback)
 *   shadow   — elected reader writes canonical store; per-user ingest remains primary
 *   primary  — canonical feed drives projection; passive subscribers skip redundant polls
 *
 * CHANNEL_LISTENER_ALLOWLIST — comma-separated signal_channels.id or telegram_chat_id values.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { incMetric } from './workerMetrics'
import { normalizeTelegramChatId } from './telegramChatId'

export type ChannelListenerMode = 'off' | 'shadow' | 'primary'

const AUTO_ENROLL_MIN_SUBSCRIBERS = Math.max(
  1,
  Math.floor(Number(process.env.CHANNEL_LISTENER_AUTO_ENROLL_MIN ?? 3)),
)

function parseMode(raw: string | undefined): ChannelListenerMode {
  const v = String(raw ?? 'off').toLowerCase().trim()
  if (v === 'shadow' || v === 'primary') return v
  return 'off'
}

function parseAllowlist(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const part of String(raw ?? '').split(',')) {
    const t = part.trim()
    if (t) out.add(t)
  }
  return out
}

const globalMode = parseMode(process.env.CHANNEL_LISTENER_MODE)
const allowlist = parseAllowlist(process.env.CHANNEL_LISTENER_ALLOWLIST)

function runtimeMode(): ChannelListenerMode {
  return parseMode(process.env.CHANNEL_LISTENER_MODE ?? globalMode)
}

function runtimeAllowlist(): Set<string> {
  const raw = process.env.CHANNEL_LISTENER_ALLOWLIST
  if (raw === undefined || raw === '') return allowlist
  return parseAllowlist(raw)
}

export const channelListenerConfig = {
  get mode() { return runtimeMode() },
  get allowlist() { return runtimeAllowlist() },
  autoEnrollMinSubscribers: AUTO_ENROLL_MIN_SUBSCRIBERS,
  leaseTtlMs: Math.max(
    15_000,
    Math.min(120_000, Number(process.env.CHANNEL_LISTENER_LEASE_TTL_MS ?? 45_000)),
  ),
  feedStaleMs: Math.max(
    30_000,
    Math.min(600_000, Number(process.env.CHANNEL_LISTENER_FEED_STALE_MS ?? 120_000)),
  ),
  inheritBackfillHours: Math.max(
    1,
    Math.min(168, Number(process.env.CHANNEL_INHERIT_BACKFILL_HOURS ?? 24)),
  ),
}

export function channelListenerModeEnabled(): boolean {
  return runtimeMode() !== 'off'
}

export function channelListenerPrimaryMode(): boolean {
  return runtimeMode() === 'primary'
}

export function channelListenerShadowMode(): boolean {
  return runtimeMode() === 'shadow'
}

export function isSignalChannelEnrolled(
  signalChannelId: string,
  telegramChatId?: string | null,
  subscriberCount?: number,
): boolean {
  const mode = runtimeMode()
  if (mode === 'off') return false

  const list = runtimeAllowlist()
  if (list.size > 0) {
    if (list.has(signalChannelId)) return true
    if (telegramChatId) {
      const canonical = normalizeTelegramChatId(telegramChatId)
      if (list.has(canonical) || list.has(telegramChatId)) return true
    }
    return false
  }

  if (subscriberCount != null && subscriberCount >= channelListenerConfig.autoEnrollMinSubscribers) {
    return true
  }

  return false
}

export function recordSignalChannelMetric(
  signalChannelId: string,
  name: string,
  delta = 1,
): void {
  incMetric(name, delta)
  incMetric(`${name}:${signalChannelId.slice(0, 8)}`, delta)
}

export async function loadSignalChannelMeta(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<{ id: string; telegram_chat_id: string; subscriber_count: number; last_live_at: string | null } | null> {
  const { data } = await supabase
    .from('signal_channels')
    .select('id, telegram_chat_id, subscriber_count, last_live_at')
    .eq('id', signalChannelId)
    .maybeSingle()

  return data as { id: string; telegram_chat_id: string; subscriber_count: number; last_live_at: string | null } | null
}

export async function countActiveSubscribers(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<number> {
  const { count } = await supabase
    .from('telegram_channels')
    .select('id', { count: 'exact', head: true })
    .eq('signal_channel_id', signalChannelId)
    .eq('is_active', true)

  return count ?? 0
}
