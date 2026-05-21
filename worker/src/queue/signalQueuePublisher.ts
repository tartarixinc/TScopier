/**
 * Listener-side publisher: enqueue parsed signals to shard-scoped Redis Streams.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { dispatchPriorityForAction, parsedAction } from '../tradeSignalActions'
import type { PipelineTimestamps } from '../pipelineTimestamps'
import type { TradeSignalPushPayload } from '../tradeSignalPush'
import { xadd } from './redisStreamsClient'
import {
  buildIdempotencyKey,
  queueLaneForParsed,
  shouldEnqueueForUser,
  signalQueueConfig,
  streamKeyForLane,
  tradeShardForUser,
  type SignalQueueLane,
} from './signalQueueConfig'
import { logQueueExecution } from './signalQueueRetry'
import { incMetric } from '../workerMetrics'

export type SignalQueueJobPayload = {
  signal_id: string
  user_id: string
  channel_id: string | null
  action_class: string
  priority: 'high' | 'normal'
  shard_id: number
  lane: SignalQueueLane
  idempotency_key: string
  attempts: number
  enqueued_at: number
  pipeline_ts?: PipelineTimestamps
  signal: TradeSignalPushPayload
}

function buildJob(row: TradeSignalPushPayload, lane: SignalQueueLane): SignalQueueJobPayload {
  const action = parsedAction(row.parsed_data as { action?: string })
  const shardId = tradeShardForUser(row.user_id)
  return {
    signal_id: row.id,
    user_id: row.user_id,
    channel_id: row.channel_id,
    action_class: action,
    priority: dispatchPriorityForAction(action),
    shard_id: shardId,
    lane,
    idempotency_key: buildIdempotencyKey({
      signalId: row.id,
      userId: row.user_id,
      actionClass: action,
    }),
    attempts: 1,
    enqueued_at: Date.now(),
    pipeline_ts: row.pipeline_ts,
    signal: row,
  }
}

function serializeJob(job: SignalQueueJobPayload): Record<string, string> {
  return {
    signal_id: job.signal_id,
    user_id: job.user_id,
    channel_id: job.channel_id ?? '',
    action_class: job.action_class,
    priority: job.priority,
    shard_id: String(job.shard_id),
    lane: job.lane,
    idempotency_key: job.idempotency_key,
    attempts: String(job.attempts),
    enqueued_at: String(job.enqueued_at),
    pipeline_ts: JSON.stringify(job.pipeline_ts ?? {}),
    payload: JSON.stringify(job.signal),
  }
}

export function parseQueueJobFields(fields: Record<string, string>): SignalQueueJobPayload | null {
  try {
    const signalRaw = fields.payload
    if (!signalRaw) return null
    const signal = JSON.parse(signalRaw) as TradeSignalPushPayload
    const lane = (fields.lane === 'mgmt' ? 'mgmt' : 'entry') as SignalQueueLane
    let pipeline_ts: PipelineTimestamps | undefined
    if (fields.pipeline_ts) {
      try {
        pipeline_ts = JSON.parse(fields.pipeline_ts) as PipelineTimestamps
      } catch {
        pipeline_ts = undefined
      }
    }
    return {
      signal_id: fields.signal_id ?? signal.id,
      user_id: fields.user_id ?? signal.user_id,
      channel_id: fields.channel_id || signal.channel_id || null,
      action_class: fields.action_class ?? parsedAction(signal.parsed_data as { action?: string }),
      priority: fields.priority === 'normal' ? 'normal' : 'high',
      shard_id: Math.floor(Number(fields.shard_id ?? 0)),
      lane,
      idempotency_key: fields.idempotency_key ?? buildIdempotencyKey({
        signalId: signal.id,
        userId: signal.user_id,
        actionClass: parsedAction(signal.parsed_data as { action?: string }),
      }),
      attempts: Math.max(1, Math.floor(Number(fields.attempts ?? 1))),
      enqueued_at: Math.floor(Number(fields.enqueued_at ?? Date.now())),
      pipeline_ts,
      signal,
    }
  } catch {
    return null
  }
}

export type EnqueueResult = {
  ok: boolean
  streamKey?: string
  messageId?: string
  lane?: SignalQueueLane
  shardId?: number
  error?: string
  skipped?: boolean
  reason?: string
}

export async function enqueueParsedSignal(
  supabase: SupabaseClient,
  row: TradeSignalPushPayload,
): Promise<EnqueueResult> {
  if (!shouldEnqueueForUser(row.user_id)) {
    return { ok: false, skipped: true, reason: 'queue_not_enabled_for_user' }
  }

  const lane = queueLaneForParsed(row.parsed_data as { action?: string })
  if (!lane) {
    return { ok: false, skipped: true, reason: 'no_queue_lane_for_action' }
  }

  const shardId = tradeShardForUser(row.user_id)
  const streamKey = streamKeyForLane(lane, shardId)
  const job = buildJob(row, lane)
  const startedAt = Date.now()

  try {
    const messageId = await xadd(streamKey, serializeJob(job))
    incMetric('queue_enqueue_ok')
    const enqueueMs = Date.now() - startedAt
    void logQueueExecution(supabase, {
      user_id: row.user_id,
      signal_id: row.id,
      action: 'dispatch_enqueue_attempt',
      status: 'success',
      request_payload: {
        stream_key: streamKey,
        message_id: messageId,
        lane,
        shard_id: shardId,
        action_class: job.action_class,
        priority: job.priority,
        idempotency_key: job.idempotency_key,
        enqueue_ms: enqueueMs,
      },
    })
    return { ok: true, streamKey, messageId, lane, shardId }
  } catch (err) {
    incMetric('queue_enqueue_failed')
    const msg = err instanceof Error ? err.message : String(err)
    void logQueueExecution(supabase, {
      user_id: row.user_id,
      signal_id: row.id,
      action: 'dispatch_enqueue_failed',
      status: 'failed',
      request_payload: {
        stream_key: streamKey,
        lane,
        shard_id: shardId,
        action_class: job.action_class,
        error: msg.slice(0, 300),
        enqueue_ms: Date.now() - startedAt,
      },
    })
    console.warn(
      `[signalQueue] enqueue failed signal=${row.id} user=${row.user_id} stream=${streamKey}: ${msg}`,
    )
    return { ok: false, streamKey, lane, shardId, error: msg }
  }
}

export function describeQueuePublisherStatus(): Record<string, unknown> {
  const cfg = signalQueueConfig()
  return {
    enabled: cfg.enabled,
    canary_shards: cfg.canaryShardIds ? [...cfg.canaryShardIds] : null,
    shard_count: cfg.shardCount,
    entry_stream_base: cfg.entryStreamBase,
    mgmt_stream_base: cfg.mgmtStreamBase,
    redis_configured: Boolean(cfg.redisRestUrl && cfg.redisRestToken),
  }
}
