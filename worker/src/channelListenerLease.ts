/**
 * Channel reader election via channel_listener_leases (one elected subscriber session).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { channelListenerWorkerId, workerConfig } from './workerConfig'
import { channelListenerConfig } from './channelListenerConfig'

const leaseGateCache = new Map<string, { readerUserId: string | null; expiresAt: number }>()

function cacheTtlMs(): number {
  return Math.max(2_000, Math.min(30_000, Number(process.env.CHANNEL_LEASE_GATE_CACHE_MS ?? 8_000)))
}

function expiresAtIso(): string {
  return new Date(Date.now() + channelListenerConfig.leaseTtlMs).toISOString()
}

export interface ChannelListenerLeaseRow {
  signal_channel_id: string
  reader_user_id: string
  worker_id: string
  role: string
  shard_id: number
  shard_count: number
  expires_at: string
}

export function isChannelLeaseRowLive(
  row: { expires_at: string } | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!row) return false
  return new Date(row.expires_at).getTime() > nowMs
}

export async function acquireChannelListenerLease(
  supabase: SupabaseClient,
  signalChannelId: string,
  readerUserId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const workerId = channelListenerWorkerId()
  const expiresAt = expiresAtIso()

  const { data: acquired, error } = await supabase.rpc('acquire_channel_listener_lease', {
    p_signal_channel_id: signalChannelId,
    p_reader_user_id: readerUserId,
    p_worker_id: workerId,
    p_role: workerConfig.role === 'channel_listener' ? 'channel_listener' : 'listener',
    p_shard_id: workerConfig.shardId,
    p_shard_count: workerConfig.shardCount,
    p_expires_at: expiresAt,
  })

  if (error) {
    return acquireChannelListenerLeaseLegacy(supabase, signalChannelId, readerUserId)
  }

  if (acquired === true) {
    leaseGateCache.set(signalChannelId, { readerUserId, expiresAt: Date.now() + cacheTtlMs() })
    return { ok: true }
  }

  const { data: existing } = await supabase
    .from('channel_listener_leases')
    .select('reader_user_id, worker_id, expires_at')
    .eq('signal_channel_id', signalChannelId)
    .maybeSingle()

  const held = existing?.worker_id as string | undefined
  const exp = existing?.expires_at as string | undefined
  return {
    ok: false,
    reason: held && exp ? `channel lease held by ${held} until ${exp}` : 'channel lease acquire rejected',
  }
}

async function acquireChannelListenerLeaseLegacy(
  supabase: SupabaseClient,
  signalChannelId: string,
  readerUserId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const workerId = channelListenerWorkerId()
  const now = new Date().toISOString()

  const { data: existing } = await supabase
    .from('channel_listener_leases')
    .select('worker_id, expires_at, reader_user_id')
    .eq('signal_channel_id', signalChannelId)
    .maybeSingle()

  if (existing) {
    const exp = new Date(existing.expires_at as string).getTime()
    const held = existing.worker_id as string
    if (exp > Date.now() && held !== workerId) {
      return { ok: false, reason: `channel lease held by ${held} until ${existing.expires_at}` }
    }
  }

  const { error } = await supabase.from('channel_listener_leases').upsert(
    {
      signal_channel_id: signalChannelId,
      reader_user_id: readerUserId,
      worker_id: workerId,
      role: workerConfig.role === 'channel_listener' ? 'channel_listener' : 'listener',
      shard_id: workerConfig.shardId,
      shard_count: workerConfig.shardCount,
      expires_at: expiresAtIso(),
      updated_at: now,
    },
    { onConflict: 'signal_channel_id' },
  )

  if (error) return { ok: false, reason: error.message }
  leaseGateCache.set(signalChannelId, { readerUserId, expiresAt: Date.now() + cacheTtlMs() })
  return { ok: true }
}

export async function renewChannelListenerLease(
  supabase: SupabaseClient,
  signalChannelId: string,
  readerUserId: string,
): Promise<boolean> {
  const result = await acquireChannelListenerLease(supabase, signalChannelId, readerUserId)
  return result.ok
}

export async function releaseChannelListenerLease(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<void> {
  const workerId = channelListenerWorkerId()
  await supabase
    .from('channel_listener_leases')
    .delete()
    .eq('signal_channel_id', signalChannelId)
    .eq('worker_id', workerId)
  leaseGateCache.delete(signalChannelId)
}

export async function fetchChannelLeaseReader(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<string | null> {
  const cached = leaseGateCache.get(signalChannelId)
  if (cached && cached.expiresAt > Date.now()) return cached.readerUserId

  const { data } = await supabase
    .from('channel_listener_leases')
    .select('reader_user_id, expires_at')
    .eq('signal_channel_id', signalChannelId)
    .maybeSingle()

  if (!isChannelLeaseRowLive(data)) {
    leaseGateCache.set(signalChannelId, { readerUserId: null, expiresAt: Date.now() + cacheTtlMs() })
    return null
  }

  const readerUserId = (data as { reader_user_id: string }).reader_user_id
  leaseGateCache.set(signalChannelId, { readerUserId, expiresAt: Date.now() + cacheTtlMs() })
  return readerUserId
}

/** True when this user is the elected MTProto reader for the signal_channel. */
export async function isElectedChannelReader(
  supabase: SupabaseClient,
  signalChannelId: string,
  userId: string,
): Promise<boolean> {
  const reader = await fetchChannelLeaseReader(supabase, signalChannelId)
  return reader === userId
}

/** Pick a subscriber to elect as reader (lowest user_id for deterministic failover). */
export async function electReaderCandidate(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('telegram_channels')
    .select('user_id')
    .eq('signal_channel_id', signalChannelId)
    .eq('is_active', true)
    .order('user_id', { ascending: true })
    .limit(1)

  return (data?.[0] as { user_id?: string } | undefined)?.user_id ?? null
}

export async function ensureChannelReaderElected(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<{ readerUserId: string | null; elected: boolean }> {
  const existing = await fetchChannelLeaseReader(supabase, signalChannelId)
  if (existing) return { readerUserId: existing, elected: false }

  const candidate = await electReaderCandidate(supabase, signalChannelId)
  if (!candidate) return { readerUserId: null, elected: false }

  const result = await acquireChannelListenerLease(supabase, signalChannelId, candidate)
  if (!result.ok) {
    const reader = await fetchChannelLeaseReader(supabase, signalChannelId)
    return { readerUserId: reader, elected: false }
  }

  return { readerUserId: candidate, elected: true }
}

export async function listActiveChannelLeases(
  supabase: SupabaseClient,
): Promise<ChannelListenerLeaseRow[]> {
  const { data } = await supabase
    .from('channel_listener_leases')
    .select('signal_channel_id, reader_user_id, worker_id, role, shard_id, shard_count, expires_at')
    .gt('expires_at', new Date().toISOString())

  return (data ?? []) as ChannelListenerLeaseRow[]
}
