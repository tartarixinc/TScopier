import type { SupabaseClient } from '@supabase/supabase-js'
import { userBelongsToShard, workerConfig } from './workerConfig'

/** Active tick interval when work exists (default 1500ms). */
export function monitorActiveIntervalMs(envKey: string, defaultMs: number): number {
  const raw = Number(process.env[envKey])
  if (Number.isFinite(raw) && raw >= 500) return Math.min(raw, 60_000)
  return defaultMs
}

/** Idle backoff when no work exists (default 60000ms). */
export function monitorIdleIntervalMs(envKey: string, defaultMs = 60_000): number {
  const raw = Number(process.env[envKey])
  if (Number.isFinite(raw) && raw >= 5_000) return Math.min(raw, 300_000)
  return defaultMs
}

export type MonitorLoopHandle = { stop: () => void; poke: () => void }

/**
 * Schedules monitor ticks with idle backoff: cheap hasWork probe first,
 * full tick only when work exists, longer sleep when idle.
 */
export function startMonitorLoop(opts: {
  name: string
  supabase: SupabaseClient
  activeIntervalMs: number
  idleIntervalMs: number
  hasWork: (supabase: SupabaseClient) => Promise<boolean>
  tick: (supabase: SupabaseClient) => Promise<void>
}): MonitorLoopHandle {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let ticking = false

  const schedule = (delayMs: number) => {
    if (stopped) return
    timer = setTimeout(() => { void runCycle() }, delayMs)
    timer.unref?.()
  }

  const runCycle = async () => {
    if (stopped || ticking) {
      schedule(opts.activeIntervalMs)
      return
    }
    ticking = true
    try {
      const work = await opts.hasWork(opts.supabase)
      if (!work) {
        schedule(opts.idleIntervalMs)
        return
      }
      await opts.tick(opts.supabase)
      schedule(opts.activeIntervalMs)
    } catch (err) {
      console.error(`[${opts.name}] tick failed:`, err instanceof Error ? err.message : String(err))
      schedule(opts.activeIntervalMs)
    } finally {
      ticking = false
    }
  }

  schedule(0)

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    poke() {
      if (stopped) return
      if (timer) clearTimeout(timer)
      schedule(0)
    },
  }
}

const SHARD_USERS_TTL_MS = 5 * 60_000
let cachedShardUserIds: string[] | null = null
let cachedShardUserIdsAt = 0

/** Active broker user ids on this worker shard (null = no shard filter). */
export async function shardUserIds(supabase: SupabaseClient): Promise<string[] | null> {
  if (workerConfig.shardCount <= 1) return null
  const now = Date.now()
  if (cachedShardUserIds && now - cachedShardUserIdsAt < SHARD_USERS_TTL_MS) {
    return cachedShardUserIds
  }
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('user_id')
    .eq('is_active', true)
  if (error) {
    console.warn('[monitorIdleGate] shardUserIds load failed:', error.message)
    return cachedShardUserIds
  }
  const ids = [...new Set(
    (data ?? [])
      .map(r => String((r as { user_id?: string }).user_id ?? ''))
      .filter(uid => uid && userBelongsToShard(uid)),
  )]
  cachedShardUserIds = ids
  cachedShardUserIdsAt = now
  return ids
}

type FilterChain = {
  in: (col: string, vals: string[]) => FilterChain
  eq: (col: string, val: unknown) => FilterChain
  not: (col: string, op: string, val: unknown) => FilterChain
  is: (col: string, val: unknown) => FilterChain
  lt: (col: string, val: string) => FilterChain
  lte: (col: string, val: string) => FilterChain
  gte: (col: string, val: string) => FilterChain
}

/** Cheap existence check via HEAD count. */
export async function tableHasRows(
  supabase: SupabaseClient,
  table: string,
  build: (q: FilterChain) => FilterChain,
): Promise<boolean> {
  let q = supabase.from(table).select('id', { count: 'exact', head: true }) as unknown as FilterChain
  q = build(q)
  const { count, error } = await (q as unknown as PromiseLike<{ count: number | null; error: { message: string } | null }>)
  if (error) {
    console.warn(`[monitorIdleGate] tableHasRows ${table}:`, error.message)
    return true
  }
  return (count ?? 0) > 0
}

/** Apply shard user_id filter when sharding is enabled. */
export function applyShardUserFilter<T extends { in: (col: string, vals: string[]) => T }>(
  q: T,
  userIds: string[] | null,
): T | null {
  if (userIds === null) return q
  if (userIds.length === 0) return null
  return q.in('user_id', userIds)
}

export function invalidateShardUserCache(): void {
  cachedShardUserIds = null
  cachedShardUserIdsAt = 0
}

/** Existence check with optional shard user_id filter. */
export async function hasWorkOnShard(
  supabase: SupabaseClient,
  table: string,
  build: (q: FilterChain) => FilterChain,
): Promise<boolean> {
  const uids = await shardUserIds(supabase)
  if (uids !== null && uids.length === 0) return false
  let q = supabase.from(table).select('id', { count: 'exact', head: true }) as unknown as FilterChain
  q = build(q)
  if (uids !== null) q = q.in('user_id', uids)
  const { count, error } = await (q as unknown as PromiseLike<{ count: number | null; error: { message: string } | null }>)
  if (error) {
    console.warn(`[monitorIdleGate] hasWorkOnShard ${table}:`, error.message)
    return true
  }
  return (count ?? 0) > 0
}

/** Apply shard filter to a select query; returns null when shard has no users. */
export async function applyShardToQuery<Q>(
  supabase: SupabaseClient,
  q: Q,
): Promise<Q | null> {
  const uids = await shardUserIds(supabase)
  if (uids === null) return q
  if (uids.length === 0) return null
  return (q as FilterChain).in('user_id', uids) as Q
}
