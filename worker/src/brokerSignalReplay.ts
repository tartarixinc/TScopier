/**
 * Replay status=parsed signals after a broker MT session recovers from disconnect.
 */

import { channelMatchesBrokerSignal } from './brokerChannelFilter'
import { loadCachedUserCopierPaused } from './copierPause'
import { brokerEligibleForSignal, enqueueSignal } from './tradeExecutor/dispatch'
import type { TradeExecutorContext } from './tradeExecutor/context'
import type { BrokerRow, SignalRow } from './tradeExecutor/types'
import { EXECUTOR_REPLAY_MAX_AGE_MS } from './tradeExecutor/types'

const REPLAY_BATCH_LIMIT = 40

export function clearBrokerSessionBlock(ctx: TradeExecutorContext, broker: BrokerRow): boolean {
  return ctx.sessionOrderBlocked.delete(broker.id)
}

/**
 * Enqueue recent parsed signals for channels linked to this broker so copy
 * resumes after reconnect without waiting for the next Telegram message.
 */
export async function replayParsedSignalsForBroker(
  ctx: TradeExecutorContext,
  broker: BrokerRow,
): Promise<number> {
  if (!broker.is_active) return 0
  if (await loadCachedUserCopierPaused(ctx.supabase, broker.user_id)) return 0

  const since = new Date(Date.now() - EXECUTOR_REPLAY_MAX_AGE_MS).toISOString()
  const { data, error } = await ctx.supabase
    .from('signals')
    .select(
      'id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id',
    )
    .eq('user_id', broker.user_id)
    .eq('status', 'parsed')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(REPLAY_BATCH_LIMIT)

  if (error) {
    console.warn(
      `[brokerSignalReplay] load parsed signals failed broker=${broker.id}: ${error.message}`,
    )
    return 0
  }

  let enqueued = 0
  for (const row of (data ?? []) as SignalRow[]) {
    if (!channelMatchesBrokerSignal(broker, row.channel_id)) continue
    if (!brokerEligibleForSignal(ctx, broker, row)) continue
    if (ctx.inflight.has(row.id) || ctx.queuedIds.has(row.id)) continue
    enqueueSignal(ctx, row, { source: 'broker_reconnect_replay' })
    enqueued += 1
  }

  if (enqueued > 0) {
    console.log(
      `[brokerSignalReplay] broker=${broker.id} re-queued ${enqueued} parsed signal(s) after session recovery`,
    )
  }
  return enqueued
}
