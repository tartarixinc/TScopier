/**
 * Redis Streams queue configuration for listener → trade dispatch.
 */

import {
  isEntryAction,
  isManagementAction,
  parsedAction,
} from '../tradeSignalActions'
import { shardForUserId, workerConfig } from '../workerConfig'

export type SignalQueueLane = 'entry' | 'mgmt'

export type SignalQueueConfig = {
  enabled: boolean
  /** When set, only these shard ids use the queue (canary). Empty = all shards when enabled. */
  canaryShardIds: Set<number> | null
  entryStreamBase: string
  mgmtStreamBase: string
  consumerBlockMs: number
  mgmtConsumerBlockMs: number
  claimIdleMs: number
  maxAttempts: number
  readCount: number
  shardCount: number
  consumerConcurrency: number
  pushFallbackOnQueueFail: boolean
  redisRestUrl: string
  redisRestToken: string
}

function parseEnvBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') return defaultValue
  const v = raw.toLowerCase().trim()
  if (v === '0' || v === 'false' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'yes') return true
  return defaultValue
}

function parseCanaryShards(raw: string | undefined): Set<number> | null {
  if (!raw?.trim()) return null
  const ids = raw.split(',').map(s => Math.floor(Number(s.trim()))).filter(n => Number.isFinite(n) && n >= 0)
  return ids.length > 0 ? new Set(ids) : null
}

export function queueShardCount(): number {
  const raw = process.env.TRADE_SIGNAL_QUEUE_SHARD_COUNT
    ?? process.env.TRADE_WORKER_SHARD_COUNT
    ?? process.env.WORKER_SHARD_COUNT
    ?? '1'
  return Math.max(1, Math.floor(Number(raw)))
}

export function loadSignalQueueConfig(): SignalQueueConfig {
  return {
    enabled: parseEnvBool(process.env.TRADE_SIGNAL_QUEUE_ENABLED, false),
    canaryShardIds: parseCanaryShards(process.env.TRADE_SIGNAL_QUEUE_CANARY_SHARDS),
    entryStreamBase: String(process.env.TRADE_SIGNAL_QUEUE_ENTRY_STREAM ?? 'signals:entry').trim(),
    mgmtStreamBase: String(process.env.TRADE_SIGNAL_QUEUE_MGMT_STREAM ?? 'signals:mgmt').trim(),
    consumerBlockMs: Math.max(100, Math.min(30_000, Number(process.env.TRADE_SIGNAL_QUEUE_CONSUMER_BLOCK_MS ?? 2_000))),
    mgmtConsumerBlockMs: Math.max(100, Math.min(5_000, Number(process.env.TRADE_SIGNAL_QUEUE_MGMT_CONSUMER_BLOCK_MS ?? 500))),
    claimIdleMs: Math.max(5_000, Math.min(600_000, Number(process.env.TRADE_SIGNAL_QUEUE_CLAIM_IDLE_MS ?? 60_000))),
    maxAttempts: Math.max(1, Math.min(20, Number(process.env.TRADE_SIGNAL_QUEUE_MAX_ATTEMPTS ?? 5))),
    readCount: Math.max(1, Math.min(100, Number(process.env.TRADE_SIGNAL_QUEUE_READ_COUNT ?? 10))),
    shardCount: queueShardCount(),
    consumerConcurrency: Math.max(
      1,
      Math.min(
        32,
        Number(
          process.env.TRADE_SIGNAL_QUEUE_CONSUMER_CONCURRENCY
          ?? process.env.EXECUTOR_MAX_CONCURRENT_SIGNALS
          ?? 8,
        ),
      ),
    ),
    pushFallbackOnQueueFail: parseEnvBool(process.env.TRADE_SIGNAL_PUSH_FALLBACK_ON_QUEUE_FAIL, true),
    redisRestUrl: String(process.env.UPSTASH_REDIS_REST_URL ?? process.env.REDIS_REST_URL ?? '').trim(),
    redisRestToken: String(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.REDIS_REST_TOKEN ?? '').trim(),
  }
}

let cachedConfig: SignalQueueConfig | null = null

export function signalQueueConfig(): SignalQueueConfig {
  if (!cachedConfig) cachedConfig = loadSignalQueueConfig()
  return cachedConfig
}

/** Reset cached config (tests). */
export function resetSignalQueueConfigCache(): void {
  cachedConfig = null
}

export function redisQueueConfigured(): boolean {
  const cfg = signalQueueConfig()
  return Boolean(cfg.redisRestUrl && cfg.redisRestToken)
}

export function queueLaneForParsed(parsed: { action?: string } | null | undefined): SignalQueueLane | null {
  const action = parsedAction(parsed)
  if (!action || action === 'ignore') return null
  if (isManagementAction(action)) return 'mgmt'
  if (isEntryAction(action)) return 'entry'
  return null
}

export function streamKeyForLane(lane: SignalQueueLane, shardId: number): string {
  const cfg = signalQueueConfig()
  const base = lane === 'entry' ? cfg.entryStreamBase : cfg.mgmtStreamBase
  return `${base}:${shardId}`
}

export function consumerGroupForLane(lane: SignalQueueLane, shardId: number): string {
  return `${lane}-shard-${shardId}`
}

export function tradeShardForUser(userId: string): number {
  return shardForUserId(userId, signalQueueConfig().shardCount)
}

export function shouldEnqueueForUser(userId: string): boolean {
  const cfg = signalQueueConfig()
  if (!cfg.enabled || !redisQueueConfigured()) return false
  const shard = tradeShardForUser(userId)
  if (cfg.canaryShardIds && !cfg.canaryShardIds.has(shard)) return false
  return true
}

export function shouldConsumeQueueLane(lane: SignalQueueLane): boolean {
  const cfg = signalQueueConfig()
  if (!cfg.enabled || !redisQueueConfigured()) return false
  if (!workerConfig.runsTrade) return false
  if (cfg.canaryShardIds && !cfg.canaryShardIds.has(workerConfig.shardId)) return false

  const mode = workerConfig.tradeExecutorMode
  if (mode === 'all') return true
  if (lane === 'entry') return mode === 'entry'
  if (lane === 'mgmt') return mode === 'mgmt'
  return false
}

export function deployedTradeShardCount(): number {
  const shardUrls = String(process.env.TRADE_WORKER_SHARD_URLS ?? '').trim()
  if (shardUrls) {
    return Math.max(1, shardUrls.split(',').map(s => s.trim()).filter(Boolean).length)
  }
  const raw = process.env.TRADE_WORKER_SHARD_COUNT ?? process.env.WORKER_SHARD_COUNT ?? '1'
  return Math.max(1, Math.floor(Number(raw)))
}

export function buildIdempotencyKey(parts: {
  signalId: string
  userId: string
  actionClass: string
  brokerAccountId?: string | null
}): string {
  const broker = parts.brokerAccountId?.trim() || '_'
  return `${parts.signalId}:${parts.userId}:${broker}:${parts.actionClass}`
}
