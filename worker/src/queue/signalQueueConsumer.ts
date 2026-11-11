/**
 * Shard-aware Redis Streams consumer for trade_entry / trade_mgmt workers.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TradeExecutor, SignalRow } from '../tradeExecutor'
import { workerConfig } from '../workerConfig'
import { incMetric } from '../workerMetrics'
import { addWorkerBreadcrumb } from '../observability/sentry'
import { captureBusinessIssue } from '../observability/businessEvents'
import {
  buildPipelineCorrelation,
  emitPipelineEvent,
  setPipelineTimestamp,
} from '../pipelineTimestamps'
import {
  xack,
  xautoclaim,
  xgroupCreateMkStream,
  xlen,
  xpendingSummary,
  xreadgroup,
  type StreamMessage,
} from './redisStreamsClient'
import {
  consumerGroupForLane,
  shouldConsumeQueueLane,
  signalQueueConfig,
  streamKeyForLane,
  type SignalQueueLane,
} from './signalQueueConfig'
import { claimQueueIdempotency, releaseQueueIdempotency } from './signalQueueIdempotency'
import { parseQueueJobFields } from './signalQueuePublisher'
import {
  logQueueExecution,
  parseAttemptCount,
  persistDeadLetter,
  retryBackoffMs,
  shouldRetryAfterFailure,
} from './signalQueueRetry'

export type QueueConsumerMetrics = {
  lane: SignalQueueLane
  stream_key: string
  stream_length: number
  pending: number
  last_read_at: string | null
  last_ack_at: string | null
  last_error: string | null
}

export class SignalQueueConsumer {
  private stopped = false
  private readLoopPromise: Promise<void> | null = null
  private reclaimLoopPromise: Promise<void> | null = null
  private reclaimCursor = '0-0'
  private lastReadAt: number | null = null
  private lastAckAt: number | null = null
  private lastError: string | null = null
  private readErrorStreak = 0
  private reclaimErrorStreak = 0

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly tradeExecutor: TradeExecutor,
    private readonly lane: SignalQueueLane,
  ) {}

  static lanesForWorker(): SignalQueueLane[] {
    const lanes: SignalQueueLane[] = []
    if (shouldConsumeQueueLane('entry')) lanes.push('entry')
    if (shouldConsumeQueueLane('mgmt')) lanes.push('mgmt')
    return lanes
  }

  start(): void {
    if (this.readLoopPromise) return
    this.stopped = false
    const streamKey = streamKeyForLane(this.lane, workerConfig.shardId)
    const group = consumerGroupForLane(this.lane, workerConfig.shardId)
    void xgroupCreateMkStream(streamKey, group).catch(err => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[signalQueue] XGROUP CREATE failed stream=${streamKey}: ${msg}`)
    })
    this.readLoopPromise = this.readLoop()
    this.reclaimLoopPromise = this.reclaimLoop()
    console.log(
      `[signalQueue] consumer started lane=${this.lane} shard=${workerConfig.shardId}`
      + ` stream=${streamKey} group=${group}`,
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([this.readLoopPromise, this.reclaimLoopPromise])
    this.readLoopPromise = null
    this.reclaimLoopPromise = null
  }

  async getMetrics(): Promise<QueueConsumerMetrics> {
    const streamKey = streamKeyForLane(this.lane, workerConfig.shardId)
    const group = consumerGroupForLane(this.lane, workerConfig.shardId)
    let streamLength = 0
    let pending = 0
    try {
      streamLength = await xlen(streamKey)
      const summary = await xpendingSummary(streamKey, group)
      pending = summary.pending
    } catch {
      /* best-effort */
    }
    return {
      lane: this.lane,
      stream_key: streamKey,
      stream_length: streamLength,
      pending,
      last_read_at: this.lastReadAt ? new Date(this.lastReadAt).toISOString() : null,
      last_ack_at: this.lastAckAt ? new Date(this.lastAckAt).toISOString() : null,
      last_error: this.lastError,
    }
  }

  private consumerName(): string {
    return `${workerConfig.instanceId}:${this.lane}`
  }

  private async readLoop(): Promise<void> {
    const cfg = signalQueueConfig()
    const blockMs = this.lane === 'mgmt' ? cfg.mgmtConsumerBlockMs : cfg.consumerBlockMs
    const streamKey = streamKeyForLane(this.lane, workerConfig.shardId)
    const group = consumerGroupForLane(this.lane, workerConfig.shardId)
    const consumer = this.consumerName()

    while (!this.stopped) {
      try {
        const messages = await xreadgroup(
          group,
          consumer,
          streamKey,
          cfg.readCount,
          blockMs,
        )
        this.lastReadAt = Date.now()
        this.readErrorStreak = 0
        if (messages.length === 0) continue
        await mapConcurrent(
          messages,
          cfg.consumerConcurrency,
          msg => this.processMessage(streamKey, group, msg),
        )
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        this.readErrorStreak += 1
        incMetric('queue_consumer_read_errors')
        console.warn(`[signalQueue] read error lane=${this.lane}: ${this.lastError}`)
        if (this.readErrorStreak === 3 || this.readErrorStreak % 10 === 0) {
          captureBusinessIssue({
            category: 'queue',
            event: 'signal_dispatch_failed',
            severity: 'warning',
            reasonCode: 'QUEUE_READ_FAILURE',
            message: 'Signal queue consumer read failed repeatedly',
            userImpact: 'delayed',
            fingerprint: ['signal_dispatch_failed', 'queue_read', 'QUEUE_READ_FAILURE', this.lane],
            context: {
              stage: 'queue_read',
              operation: 'queue_read',
              dispatch_source: 'queue',
              retry_attempt: this.readErrorStreak,
              extra: { lane: this.lane, stream_key: streamKey },
            },
          })
        }
        await sleep(Math.min(5_000, blockMs))
      }
    }
  }

  private async reclaimLoop(): Promise<void> {
    const cfg = signalQueueConfig()
    const streamKey = streamKeyForLane(this.lane, workerConfig.shardId)
    const group = consumerGroupForLane(this.lane, workerConfig.shardId)
    const consumer = this.consumerName()
    const intervalMs = Math.max(5_000, Math.floor(cfg.claimIdleMs / 3))

    while (!this.stopped) {
      await sleep(intervalMs)
      if (this.stopped) break
      try {
        const { nextStart, messages } = await xautoclaim(
          streamKey,
          group,
          consumer,
          cfg.claimIdleMs,
          this.reclaimCursor,
          cfg.readCount,
        )
        this.reclaimCursor = nextStart
        this.reclaimErrorStreak = 0
        if (messages.length === 0) continue
        incMetric('queue_reclaimed', messages.length)
        await mapConcurrent(
          messages,
          cfg.consumerConcurrency,
          msg => this.processMessage(streamKey, group, msg, { reclaimed: true }),
        )
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        this.reclaimErrorStreak += 1
        incMetric('queue_consumer_reclaim_errors')
        console.warn(`[signalQueue] reclaim error lane=${this.lane}: ${this.lastError}`)
        if (this.reclaimErrorStreak === 3 || this.reclaimErrorStreak % 10 === 0) {
          captureBusinessIssue({
            category: 'queue',
            event: 'signal_dispatch_failed',
            severity: 'warning',
            reasonCode: 'QUEUE_RECLAIM_FAILURE',
            message: 'Signal queue reclaim failed repeatedly',
            userImpact: 'delayed',
            fingerprint: ['signal_dispatch_failed', 'queue_reclaim', 'QUEUE_RECLAIM_FAILURE', this.lane],
            context: {
              stage: 'queue_reclaim',
              operation: 'queue_reclaim',
              dispatch_source: 'queue',
              retry_attempt: this.reclaimErrorStreak,
              extra: { lane: this.lane, stream_key: streamKey },
            },
          })
        }
      }
    }
  }

  private async processMessage(
    streamKey: string,
    group: string,
    msg: StreamMessage,
    opts?: { reclaimed?: boolean },
  ): Promise<void> {
    const job = parseQueueJobFields(msg.fields)
    if (!job) {
      incMetric('queue_malformed')
      captureBusinessIssue({
        category: 'queue',
        event: 'signal_dispatch_failed',
        severity: 'error',
        reasonCode: 'QUEUE_MALFORMED_PAYLOAD',
        message: 'Malformed signal queue payload was acknowledged without dispatch',
        userImpact: 'failed',
        fingerprint: ['signal_dispatch_failed', 'queue_parse', 'QUEUE_MALFORMED_PAYLOAD', this.lane],
        context: {
          stage: 'queue_parse',
          operation: 'queue_parse',
          queue_message_id: msg.id,
          extra: { lane: this.lane, stream_key: streamKey },
        },
      })
      await xack(streamKey, group, msg.id)
      return
    }

    const attempts = parseAttemptCount(msg.fields)
    const receivedAt = Date.now()
    job.pipeline_ts = setPipelineTimestamp(job.pipeline_ts ?? {}, 'queue_consumed_at', receivedAt)
    const enqueueToStartMs = Math.max(0, receivedAt - job.enqueued_at)
    const correlation = buildPipelineCorrelation({
      userId: job.user_id,
      signalId: job.signal_id,
      channelId: job.channel_id,
      queueMessageId: msg.id,
      dispatchSource: 'queue',
    })
    emitPipelineEvent({
      event: 'queue_consumed',
      correlation,
      timestamps: job.pipeline_ts,
      outcome: 'started',
      path: job.lane,
      extra: {
        shard_id: job.shard_id,
        attempts,
        reclaimed: opts?.reclaimed === true,
      },
    })

    const claimed = await claimQueueIdempotency(this.supabase, job.idempotency_key, {
      signal_id: job.signal_id,
      user_id: job.user_id,
      lane: job.lane,
    })
      if (!claimed) {
        incMetric('queue_duplicate_skip')
      addWorkerBreadcrumb({
        category: 'queue',
        message: 'duplicate queue message skipped',
        level: 'info',
        data: { lane: job.lane, attempts },
      })
      emitPipelineEvent({
        event: 'execution_duplicate_prevented',
        correlation,
        timestamps: job.pipeline_ts,
        outcome: 'duplicate',
        path: job.lane,
        extra: {
          idempotency_key: job.idempotency_key,
          attempts,
        },
      })
      await xack(streamKey, group, msg.id)
      this.lastAckAt = Date.now()
      return
    }

    const signalRow: SignalRow = {
      ...job.signal,
      pipeline_ts: job.pipeline_ts,
    } as SignalRow

    void logQueueExecution(this.supabase, {
      user_id: job.user_id,
      signal_id: job.signal_id,
      action: 'queue_consume_start',
      status: 'success',
      request_payload: {
        message_id: msg.id,
        lane: job.lane,
        shard_id: job.shard_id,
        attempts,
        enqueue_to_start_ms: enqueueToStartMs,
        reclaimed: opts?.reclaimed === true,
      },
    })

    try {
      const accepted = await this.tradeExecutor.acceptDispatchSignalAwait(signalRow, {
        priority: job.priority,
        source: 'queue',
      })

      if (!accepted) {
        throw new Error('trade_executor_rejected_signal')
      }

      await xack(streamKey, group, msg.id)
      this.lastAckAt = Date.now()
      incMetric('queue_consume_ok')
      void logQueueExecution(this.supabase, {
        user_id: job.user_id,
        signal_id: job.signal_id,
        action: 'queue_consume_ack',
        status: 'success',
        request_payload: {
          message_id: msg.id,
          enqueue_to_ack_ms: Date.now() - job.enqueued_at,
        },
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.lastError = reason
      incMetric('queue_consume_failed')

      if (!shouldRetryAfterFailure(attempts)) {
        incMetric('queue_dlq')
        captureBusinessIssue({
          category: 'queue',
          event: 'signal_queue_dead_lettered',
          severity: 'error',
          reasonCode: 'QUEUE_DEAD_LETTER',
          message: 'Signal queue job dead-lettered after final retry',
          userImpact: 'failed',
          fingerprint: ['signal_queue_dead_lettered', job.lane, 'QUEUE_DEAD_LETTER'],
          context: {
            user_id: job.user_id,
            signal_id: job.signal_id,
            queue_message_id: msg.id,
            dispatch_source: 'queue',
            stage: 'queue_dead_letter',
            operation: 'queue_consume',
            retry_attempt: attempts,
            extra: { lane: job.lane, shard_id: job.shard_id },
          },
        })
        await persistDeadLetter(this.supabase, {
          stream_key: streamKey,
          message_id: msg.id,
          idempotency_key: job.idempotency_key,
          signal_id: job.signal_id,
          user_id: job.user_id,
          lane: job.lane,
          shard_id: job.shard_id,
          attempts,
          reason,
          payload: job.signal as unknown as Record<string, unknown>,
        })
        await xack(streamKey, group, msg.id)
        void logQueueExecution(this.supabase, {
          user_id: job.user_id,
          signal_id: job.signal_id,
          action: 'queue_dead_letter',
          status: 'failed',
          request_payload: {
            message_id: msg.id,
            attempts,
            reason: reason.slice(0, 200),
          },
        })
        return
      }

      void logQueueExecution(this.supabase, {
        user_id: job.user_id,
        signal_id: job.signal_id,
        action: 'queue_consume_retry',
        status: 'failed',
        request_payload: {
          message_id: msg.id,
          attempts,
          next_attempt: attempts + 1,
          reason: reason.slice(0, 200),
          backoff_ms: retryBackoffMs(attempts),
          reclaimed: opts?.reclaimed === true,
        },
      })

      // Release idempotency so reclaim can actually re-execute (previously reclaim
      // always hit "duplicate" and acked without running).
      await releaseQueueIdempotency(this.supabase, job.idempotency_key)

      // Leave unacked — XAUTOCLAIM will retry after claim idle timeout.
    }
  }
}

async function mapConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const pool = Math.max(1, Math.min(limit, items.length))
  let idx = 0
  await Promise.all(Array.from({ length: pool }, async () => {
    while (idx < items.length) {
      const i = idx++
      await fn(items[i]!)
    }
  }))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class SignalQueueConsumerManager {
  private consumers: SignalQueueConsumer[] = []

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly tradeExecutor: TradeExecutor,
  ) {}

  start(): void {
    if (this.consumers.length > 0) return
    for (const lane of SignalQueueConsumer.lanesForWorker()) {
      const consumer = new SignalQueueConsumer(this.supabase, this.tradeExecutor, lane)
      consumer.start()
      this.consumers.push(consumer)
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.consumers.map(c => c.stop()))
    this.consumers = []
  }

  async getMetrics(): Promise<QueueConsumerMetrics[]> {
    return Promise.all(this.consumers.map(c => c.getMetrics()))
  }
}
