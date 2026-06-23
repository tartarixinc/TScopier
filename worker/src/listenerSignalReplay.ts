/**
 * Replay parsed signals after Telegram listener lease recovers from expiry.
 */

import { loadCachedUserCopierPaused } from './copierPause'
import { hasActiveSignalRangeEntryWait } from './signalRangeEntryHelpers'
import { enqueueSignal } from './tradeExecutor/dispatch'
import type { TradeExecutorContext } from './tradeExecutor/context'
import type { SignalRow } from './tradeExecutor/types'
import { EXECUTOR_REPLAY_MAX_AGE_MS } from './tradeExecutor/types'
import { dispatchPriorityForAction, parsedAction } from './tradeSignalActions'

const REPLAY_BATCH_LIMIT = 40

const listenerLeaseLiveByUser = new Map<string, boolean>()

/**
 * On trade workers (split deploy), detect lease false→true and replay missed signals.
 */
export async function listenerLeaseRecoveryTick(ctx: TradeExecutorContext): Promise<void> {
  for (const userId of ctx.brokersByUser.keys()) {
    const { isTelegramListenerLiveForUser } = await import('./sessionLease')
    const live = await isTelegramListenerLiveForUser(ctx.supabase, userId)
    const hadPrior = listenerLeaseLiveByUser.has(userId)
    const wasLive = listenerLeaseLiveByUser.get(userId) ?? false
    listenerLeaseLiveByUser.set(userId, live)
    if (hadPrior && live && !wasLive) {
      void replaySignalsAfterListenerRecovery(ctx, userId)
    }
  }
}

/**
 * Enqueue recent parsed signals (and reset transient listener skips) after lease recovery.
 */
export async function replaySignalsAfterListenerRecovery(
  ctx: TradeExecutorContext,
  userId: string,
): Promise<number> {
  if (await loadCachedUserCopierPaused(ctx.supabase, userId)) return 0

  const since = new Date(Date.now() - EXECUTOR_REPLAY_MAX_AGE_MS).toISOString()

  try {
    await ctx.supabase
      .from('signals')
      .update({ status: 'parsed', skip_reason: null })
      .eq('user_id', userId)
      .eq('status', 'skipped')
      .eq('skip_reason', 'telegram_listener_not_live')
      .gte('created_at', since)
  } catch (err) {
    console.warn(
      `[listenerSignalReplay] reset transient skips failed user=${userId}:`,
      err instanceof Error ? err.message : err,
    )
  }

  const { data, error } = await ctx.supabase
    .from('signals')
    .select(
      'id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id',
    )
    .eq('user_id', userId)
    .eq('status', 'parsed')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(REPLAY_BATCH_LIMIT)

  if (error) {
    console.warn(
      `[listenerSignalReplay] load parsed signals failed user=${userId}: ${error.message}`,
    )
    return 0
  }

  let enqueued = 0
  for (const row of (data ?? []) as SignalRow[]) {
    if (ctx.inflight.has(row.id) || ctx.queuedIds.has(row.id)) continue
    if (await hasActiveSignalRangeEntryWait(ctx.supabase, row.id)) continue
    if (await ctx.signalAlreadyHandled(row.id)) {
      await ctx.markSignalExecuted(row.id)
      continue
    }
    enqueueSignal(ctx, row, {
      source: 'listener_lease_recovery_replay',
      priority: dispatchPriorityForAction(parsedAction(row.parsed_data)),
    })
    enqueued += 1
  }

  if (enqueued > 0) {
    console.log(
      `[listenerSignalReplay] user=${userId} re-queued ${enqueued} parsed signal(s) after listener lease recovery`,
    )
  }
  return enqueued
}
