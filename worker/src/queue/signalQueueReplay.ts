/**
 * Dead-letter replay hooks for signal queue jobs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TradeExecutor, SignalRow } from '../tradeExecutor'
import { xadd } from './redisStreamsClient'
import { streamKeyForLane, type SignalQueueLane } from './signalQueueConfig'
import { buildIdempotencyKey } from './signalQueueConfig'
import { parsedAction } from '../tradeSignalActions'
import type { TradeSignalPushPayload } from '../tradeSignalPush'

export type DeadLetterRow = {
  id: string
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
  status: string
}

export async function listReplayableDeadLetters(
  supabase: SupabaseClient,
  limit = 50,
): Promise<DeadLetterRow[]> {
  const { data, error } = await supabase
    .from('signal_queue_dead_letters')
    .select('*')
    .eq('status', 'dead')
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) {
    throw new Error(`listReplayableDeadLetters: ${error.message}`)
  }
  return (data ?? []) as DeadLetterRow[]
}

export async function replayDeadLetterToStream(
  supabase: SupabaseClient,
  row: DeadLetterRow,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const lane = (row.lane === 'mgmt' ? 'mgmt' : 'entry') as SignalQueueLane
  const streamKey = streamKeyForLane(lane, row.shard_id)
  const signal = row.payload as unknown as TradeSignalPushPayload
  const action = parsedAction(signal.parsed_data as { action?: string })

  try {
    const messageId = await xadd(streamKey, {
      signal_id: row.signal_id,
      user_id: row.user_id,
      channel_id: signal.channel_id ?? '',
      action_class: action,
      priority: 'normal',
      shard_id: String(row.shard_id),
      lane,
      idempotency_key: buildIdempotencyKey({
        signalId: row.signal_id,
        userId: row.user_id,
        actionClass: `${action}:replay:${row.id}`,
      }),
      attempts: '1',
      enqueued_at: String(Date.now()),
      pipeline_ts: JSON.stringify(signal.pipeline_ts ?? {}),
      payload: JSON.stringify(signal),
      replay_of_dlq_id: row.id,
    })

    const { error } = await supabase
      .from('signal_queue_dead_letters')
      .update({ status: 'replayed', replayed_at: new Date().toISOString() })
      .eq('id', row.id)

    if (error) {
      return { ok: false, error: error.message }
    }
    return { ok: true, messageId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

/** In-process replay: push DLQ payload directly to executor (ops tooling). */
export function replayDeadLetterInProcess(
  tradeExecutor: TradeExecutor,
  row: DeadLetterRow,
): boolean {
  const signal = row.payload as unknown as TradeSignalPushPayload
  const signalRow = signal as unknown as SignalRow
  return tradeExecutor.acceptDispatchSignal(signalRow, {
    priority: 'normal',
    source: 'dlq_replay',
  })
}
