/**
 * Retry policy and dead-letter persistence for signal queue jobs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { signalQueueConfig } from './signalQueueConfig'

export function parseAttemptCount(fields: Record<string, string>): number {
  const raw = fields.attempts ?? '1'
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

export function shouldRetryAfterFailure(attempts: number): boolean {
  return attempts < signalQueueConfig().maxAttempts
}

export function retryBackoffMs(attempts: number): number {
  const base = Math.max(50, Number(process.env.TRADE_SIGNAL_QUEUE_RETRY_BASE_MS ?? 250))
  return Math.min(30_000, base * attempts)
}

export type DeadLetterRecord = {
  stream_key: string
  message_id: string
  idempotency_key: string
  signal_id: string
  user_id: string
  lane: string
  shard_id: number
  attempts: number
  reason: string
  payload: Record<string, unknown>
}

export async function persistDeadLetter(
  supabase: SupabaseClient,
  record: DeadLetterRecord,
): Promise<void> {
  const { error } = await supabase.from('signal_queue_dead_letters').insert({
    stream_key: record.stream_key,
    message_id: record.message_id,
    idempotency_key: record.idempotency_key,
    signal_id: record.signal_id,
    user_id: record.user_id,
    lane: record.lane,
    shard_id: record.shard_id,
    attempts: record.attempts,
    reason: record.reason.slice(0, 500),
    payload: record.payload,
    status: 'dead',
  })
  if (error) {
    console.error(
      `[signalQueue] DLQ insert failed signal=${record.signal_id} user=${record.user_id}: ${error.message}`,
    )
  }
}

export async function logQueueExecution(
  supabase: SupabaseClient,
  row: {
    user_id: string
    signal_id: string
    action: string
    status: 'success' | 'failed' | 'skipped'
    request_payload: Record<string, unknown>
  },
): Promise<void> {
  const { error } = await supabase.from('trade_execution_logs').insert(row)
  if (error) {
    console.warn(`[signalQueue] log insert failed action=${row.action}: ${error.message}`)
  }
}
