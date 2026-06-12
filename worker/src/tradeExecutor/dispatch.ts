import type { TradeExecutorContext } from './context'
import { hasMetatraderApiConfigured } from '../metatraderapi'
import type { BrokerRow, QueuedSignal, SignalRow } from './types'
import {
  dispatchPriorityForAction,
  isEntryAction,
  isManagementAction,
  parsedAction,
  signalMatchesExecutorMode,
} from '../tradeSignalActions'
import { workerConfig } from '../workerConfig'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import {
  channelConfigReadyForExecution,
  resolveChannelTradingConfig,
  withChannelTradingConfig,
} from '../channelTradingConfig'
import {
  isChannelManagementBlocked,
  managementFilterContextFromParsed,
  normalizeChannelMessageFiltersMap,
} from '../channelMessageFilters'
import { shouldRouteAsBasketParameterRefresh, parsedHasSlOrTp } from '../multiTradeMerge'
import type { ParsedSignal } from '../manualPlanner'
import { SKIP_REASON_SIGNAL_ENTRY_REQUIRED } from '../manualPlanner'
import { parsePipelineTimestamps, pipelineSummaryPayload } from '../pipelineTimestamps'
import { buildTscopierCommentPrefix, resolveChannelLabelForComment, sanitizeChannelCommentSlug } from '../tradeComment'
import { isMtUuid, operationFor } from './helpers'
import {
  EXECUTION_LOG_ACTIONS_HANDLED,
  EXECUTOR_MAX_CONCURRENT_SIGNALS,
  EXECUTOR_REPLAY_MAX_AGE_MS,
  PARSED_STATUSES,
  telegramLiveTradeGateEnabled,
} from './types'
import type { ChannelKeywords } from '../manualPlanner'
import { MESSAGE_REVISION_DISPATCH_SOURCE, revisionDirectionFlippedFromActions } from '../signalRevision'
import {
  closeBasketForRevisionDirectionFlip,
  waitForSignalBasketFlat,
} from './messageRevisionDirectionFlipClose'
import {
  loadCachedUserSubscription,
  loadCachedUserIsAdmin,
  subscriptionBlocksSignalExecution,
  isSubscriptionActive,
} from '../subscriptionAccess'
import { evaluateParsedSignalExecutionEligibility } from '../signalExecutionEligibility'
import { evaluateChannelCopyLimitPauseForBroker } from '../copyLimitDispatch'

export function shouldUseEntryFastPath(ctx: TradeExecutorContext, row: SignalRow): boolean {
    const mode = workerConfig.tradeExecutorMode
    if (mode !== 'entry' && mode !== 'all') return false
    const parsed = row.parsed_data
    if (!parsed) return false
    // SL/TP follow-ups (replies / adjust posts) must modify the open basket — never OrderSend first.
    if (shouldRouteAsBasketParameterRefresh(parsed)) return false
    return isEntryAction(parsedAction(parsed))
  }

export function enqueueSignal(ctx: TradeExecutorContext, 
    row: SignalRow,
    opts?: {
      liveDispatch?: boolean
      priority?: 'high' | 'normal'
      source?: string
      dispatchReceivedAt?: number
    },
  ): void {
    if (!PARSED_STATUSES.has(row.status)) return
    if (!signalMatchesExecutorMode(row.parsed_data, workerConfig.tradeExecutorMode)) return
    if (ctx.inflight.has(row.id) || ctx.queuedIds.has(row.id)) return

    const action = parsedAction(row.parsed_data)
    const high = (opts?.priority ?? dispatchPriorityForAction(action)) === 'high'

    ctx.queuedIds.add(row.id)
    const item: QueuedSignal = {
      row,
      liveDispatch: opts?.liveDispatch,
      source: opts?.source,
      dispatchReceivedAt: opts?.dispatchReceivedAt,
    }
    if (high) {
      ctx.highPriorityQueue.push(item)
    } else {
      ctx.normalPriorityQueue.push(item)
    }
    ctx.scheduleQueueDrain()
  }

export function scheduleQueueDrain(ctx: TradeExecutorContext, ): void {
    if (ctx.queueDrainScheduled) return
    ctx.queueDrainScheduled = true
    setImmediate(() => {
      ctx.queueDrainScheduled = false
      void ctx.drainSignalQueues()
    })
  }

export function dequeueQueuedSignal(ctx: TradeExecutorContext, ): QueuedSignal | null {
    return ctx.highPriorityQueue.shift() ?? ctx.normalPriorityQueue.shift() ?? null
  }

export async function drainSignalQueues(ctx: TradeExecutorContext, ): Promise<void> {
    if (ctx.queueDraining) return
    ctx.queueDraining = true
    const inFlight = new Set<Promise<void>>()
    try {
      while (ctx.highPriorityQueue.length > 0 || ctx.normalPriorityQueue.length > 0 || inFlight.size > 0) {
        while (
          inFlight.size < EXECUTOR_MAX_CONCURRENT_SIGNALS
          && (ctx.highPriorityQueue.length > 0 || ctx.normalPriorityQueue.length > 0)
        ) {
          const item = ctx.dequeueQueuedSignal()
          if (!item) break
          const row = item.row
          ctx.queuedIds.delete(row.id)
          const job = ctx.handleSignal(row, {
            liveDispatch: item.liveDispatch === true,
            lightIdempotency: false,
            dispatchSource: item.source,
            dispatchReceivedAt: item.dispatchReceivedAt,
          })
            .catch(err => console.error(`[tradeExecutor] handleSignal failed for ${row.id}:`, err))
          inFlight.add(job)
          void job.finally(() => {
            inFlight.delete(job)
          })
        }
        if (inFlight.size > 0) {
          await Promise.race(inFlight)
        } else {
          break
        }
      }
    } finally {
      ctx.queueDraining = false
      if (ctx.highPriorityQueue.length > 0 || ctx.normalPriorityQueue.length > 0) {
        ctx.scheduleQueueDrain()
      }
    }
  }

export async function logPipelineStage(ctx: TradeExecutorContext, 
    signal: SignalRow,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        action,
        status: 'success',
        request_payload: payload as unknown as Record<string, unknown>,
      })
    } catch {
      /* best-effort */
    }
  }

export async function logDispatchSkipped(ctx: TradeExecutorContext, 
    signal: SignalRow,
    skipReason: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        action: 'dispatch_skipped',
        status: 'skipped',
        error_message: skipReason,
        request_payload: {
          skip_reason: skipReason,
          channel_id: signal.channel_id ?? null,
          ...extra,
        },
      })
      await ctx.supabase
        .from('signals')
        .update({ status: 'skipped', skip_reason: skipReason })
        .eq('id', signal.id)
        .in('status', ['parsed', 'pending'])
    } catch {
      /* best-effort */
    }
  }

export function logPipelineSummaryBackground(ctx: TradeExecutorContext, 
    signal: SignalRow,
    extra?: Record<string, unknown>,
  ): void {
    const ts = signal.pipeline_ts ?? {}
    void ctx.supabase
      .from('trade_execution_logs')
      .insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        action: 'pipeline_summary',
        status: 'success',
        request_payload: pipelineSummaryPayload(ts, extra) as unknown as Record<string, unknown>,
      })
      .then(({ error }) => {
        if (error) {
          console.warn(`[tradeExecutor] pipeline_summary log failed signal=${signal.id}: ${error.message}`)
        }
      })
  }

export async function markSignalExecuted(ctx: TradeExecutorContext, signalId: string): Promise<void> {
    try {
      await ctx.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', signalId)
        .eq('status', 'parsed')
    } catch {
      /* best-effort */
    }
  }

async function signalDispatchAlreadyHandled(ctx: TradeExecutorContext, signalId: string): Promise<boolean> {
    const [trades, range, entry, logs, claims] = await Promise.all([
      ctx.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId),
      ctx.supabase
        .from('range_pending_legs')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId),
      ctx.supabase
        .from('signal_entry_pending_orders')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId),
      ctx.supabase
        .from('trade_execution_logs')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('status', 'success')
        .in('action', [...EXECUTION_LOG_ACTIONS_HANDLED]),
      ctx.supabase
        .from('signal_broker_dispatch_claims')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId),
    ])
    return (
      (trades.count ?? 0) > 0
      || (range.count ?? 0) > 0
      || (entry.count ?? 0) > 0
      || (logs.count ?? 0) > 0
      || (claims.count ?? 0) > 0
    )
  }

export async function signalLiveDispatchAlreadyHandled(ctx: TradeExecutorContext, signalId: string): Promise<boolean> {
    return signalDispatchAlreadyHandled(ctx, signalId)
  }

export async function signalAlreadyHandled(ctx: TradeExecutorContext, signalId: string): Promise<boolean> {
    return signalDispatchAlreadyHandled(ctx, signalId)
  }

export function signalTooOldForReplay(ctx: TradeExecutorContext, row: SignalRow): boolean {
    if (!row.created_at) return false
    const ageMs = Date.now() - new Date(row.created_at).getTime()
    return Number.isFinite(ageMs) && ageMs > EXECUTOR_REPLAY_MAX_AGE_MS
  }

export function claimSignalExecution(ctx: TradeExecutorContext, signalId: string): boolean {
    if (ctx.inflight.has(signalId)) return false
    ctx.inflight.add(signalId)
    return true
  }

/** Wait for an in-flight entry on the same signal row (teaser merge + revision overlap). */
export async function waitForSignalInflightClear(
  ctx: TradeExecutorContext,
  signalId: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (ctx.inflight.has(signalId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !ctx.inflight.has(signalId)
}

export async function handleSignal(ctx: TradeExecutorContext, 
    row: SignalRow,
    opts?: {
      liveDispatch?: boolean
      lightIdempotency?: boolean
      dispatchSource?: string
      dispatchReceivedAt?: number
    },
  ) {
    if (!hasMetatraderApiConfigured()) return
    const isMessageRevisionEarly = opts?.dispatchSource === MESSAGE_REVISION_DISPATCH_SOURCE
    if (isMessageRevisionEarly) {
      await waitForSignalInflightClear(ctx, row.id)
    }
    if (!ctx.claimSignalExecution(row.id)) return

    const handleStartMs = Date.now()
    const liveFast = opts?.liveDispatch === true && opts?.lightIdempotency === true
    const channelMetaPromise = liveFast && row.channel_id
      ? ctx.getChannelMeta(row.channel_id)
      : null
    const queueWaitMs = opts?.dispatchReceivedAt != null
      ? Math.max(0, handleStartMs - (opts.dispatchReceivedAt as number))
      : null
    let pipelineOutcome: Record<string, unknown> = { live_fast: liveFast }
    const isMessageRevision = opts?.dispatchSource === MESSAGE_REVISION_DISPATCH_SOURCE
    try {
      if (!opts?.liveDispatch && !isMessageRevision && ctx.signalTooOldForReplay(row)) return

      if (!liveFast) {
        void ctx.logPipelineStage(row, 'handle_start', {
          live_dispatch: opts?.liveDispatch === true,
          source: opts?.dispatchSource ?? null,
          queue_wait_ms: queueWaitMs,
        })
      }

      if (!isMessageRevision && !liveFast && await ctx.signalAlreadyHandled(row.id)) {
        await ctx.markSignalExecuted(row.id)
        return
      }
      let userSub: Awaited<ReturnType<typeof loadCachedUserSubscription>>
      let isAdmin: boolean
      if (
        liveFast
        && telegramLiveTradeGateEnabled()
        && row.channel_id
        && ctx.sessionManager
      ) {
        const [teleLive, sub, admin] = await Promise.all([
          ctx.sessionManager.canExecuteTelegramCopierTradesAsync(row.user_id),
          loadCachedUserSubscription(ctx.supabase, row.user_id),
          loadCachedUserIsAdmin(ctx.supabase, row.user_id),
        ])
        if (!teleLive) {
          console.warn(
            `[tradeExecutor] skip signal ${row.id} (user ${row.user_id}): telegram listener not live for channel-backed copier`,
          )
          await ctx.logDispatchSkipped(row, 'telegram_listener_not_live')
          return
        }
        userSub = sub
        isAdmin = admin
      } else {
        if (telegramLiveTradeGateEnabled() && row.channel_id) {
          const live = ctx.sessionManager
            ? await ctx.sessionManager.canExecuteTelegramCopierTradesAsync(row.user_id)
            : false
          if (!live) {
            console.warn(
              `[tradeExecutor] skip signal ${row.id} (user ${row.user_id}): telegram listener not live for channel-backed copier`,
            )
            await ctx.logDispatchSkipped(row, 'telegram_listener_not_live')
            return
          }
        }
        ;[userSub, isAdmin] = await Promise.all([
          loadCachedUserSubscription(ctx.supabase, row.user_id),
          loadCachedUserIsAdmin(ctx.supabase, row.user_id),
        ])
      }
      if (!isAdmin && (!userSub || !isSubscriptionActive(userSub.status))) {
        await ctx.logDispatchSkipped(row, 'subscription_inactive')
        return
      }

      const pipelineT0 = Date.now()
      const parsed = row.parsed_data
      if (!parsed || !parsed.action) return
      const action = String(parsed.action).toLowerCase()
      if (action === 'ignore') return
      const executionEligibility = evaluateParsedSignalExecutionEligibility(
        parsed,
        String((row as { raw_message?: string | null }).raw_message ?? parsed.raw_instruction ?? ''),
      )
      if (!executionEligibility.eligible) {
        await ctx.logDispatchSkipped(row, executionEligibility.skipReason ?? 'entry_not_execution_eligible')
        return
      }

      const rawMatchingBrokers = (ctx.brokersByUser.get(row.user_id) ?? []).filter(b =>
        b.is_active && isMtUuid(b.metaapi_account_id) && channelMatchesBrokerSignal(b, row.channel_id),
      )
      const configSkipReasons: string[] = []
      const allMatchingBrokers = rawMatchingBrokers.flatMap(b => {
        const ready = channelConfigReadyForExecution(b, row.channel_id)
        if (!ready.ready) {
          configSkipReasons.push(ready.reason)
          console.warn(
            `[tradeExecutor] skip broker ${b.id} signal=${row.id} channel=${row.channel_id ?? 'none'}`
            + ` reason=${ready.reason}`,
          )
          return []
        }
        return [withChannelTradingConfig(b, row.channel_id)]
      })
      let brokers = allMatchingBrokers.filter(b => ctx.brokerEligibleForSignal(b, row))
      if (brokers.length > 0 && row.channel_id) {
        const profileTz = ctx.userTimezoneById.get(row.user_id)
        const channelId = row.channel_id
        if (liveFast && parsed.symbol) {
          void ctx.prewarmBrokersForLiveEntry(brokers, parsed.symbol)
        }
        const pauseResults = await Promise.all(
          brokers.map(async broker => {
            const state = await ctx.fetchCopyLimitState(broker.id, channelId)
            const pause = evaluateChannelCopyLimitPauseForBroker(
              broker,
              channelId,
              profileTz,
              state,
            )
            if (pause.paused && pause.reason) {
              const skipLog = ctx.logDispatchSkipped(row, pause.reason, {
                broker_id: broker.id,
                channel_id: channelId,
                pause_key: pause.pauseKey ?? null,
              })
              if (liveFast) void skipLog
              else await skipLog
              return null
            }
            return broker
          }),
        )
        brokers = pauseResults.filter((b): b is typeof brokers[number] => b != null)
      }
      if (!brokers.length) {
        if (configSkipReasons.length > 0 && rawMatchingBrokers.length > 0) {
          await ctx.logDispatchSkipped(row, configSkipReasons[0] ?? 'channel_config_missing', {
            channel_id: row.channel_id ?? null,
            matching_brokers: rawMatchingBrokers.length,
          })
          return
        }
        if (rawMatchingBrokers.length > 0) {
          // A matching broker exists but it was reactivated AFTER the signal
          // arrived — i.e. the signal piled up while the broker was disabled.
          // Marking as skipped here prevents the 5-min sweep from picking it
          // up the moment the user re-enables a broker.
          console.warn(
            `[tradeExecutor] skip signal ${row.id}: all matching brokers reactivated after signal arrival (stale-after-outage)`,
          )
          await ctx.logDispatchSkipped(row, 'broker_reactivated_after_signal', {
            matching_brokers: allMatchingBrokers.length,
            broker_activated_at: allMatchingBrokers.map(b => ({
              id: b.id,
              activated_at: ctx.brokerActivatedAt.get(b.id) ?? null,
            })),
            signal_created_at: row.created_at ?? null,
          })
          return
        }
        console.warn(
          `[tradeExecutor] skip signal ${row.id}: no active broker matches channel=${row.channel_id ?? 'none'} (check Configure Trading channel selection)`,
        )
        await ctx.logDispatchSkipped(row, 'no_broker_channel_match')
        return
      }

      for (const broker of brokers) {
        const blockReason = subscriptionBlocksSignalExecution(
          userSub,
          (broker.manual_settings ?? null) as Record<string, unknown> | null,
          isAdmin,
        )
        if (blockReason === 'plan_advanced_feature_required') {
          await ctx.logDispatchSkipped(row, blockReason)
          return
        }
      }

      if (
        isMessageRevision
        && row.revision_prior_action
        && revisionDirectionFlippedFromActions(row.revision_prior_action, action)
      ) {
        const flipClose = await closeBasketForRevisionDirectionFlip(ctx, row, brokers)
        await waitForSignalBasketFlat(ctx, row, brokers)
        if (flipClose.closed === 0 && flipClose.failed > 0) {
          await ctx.logDispatchSkipped(row, 'message_revision_direction_flip_close_failed')
          return
        }
        if (!parsedHasSlOrTp(parsed as unknown as Record<string, unknown>)) {
          await ctx.logDispatchSkipped(row, 'message_revision_direction_flip_closed')
          await ctx.markSignalExecuted(row.id)
          return
        }
      }

      // Pre-fetch channel keywords + comment slug once per signal.
      const { keywords: channelKeywords, commentSlug } = channelMetaPromise
        ? await channelMetaPromise
        : await ctx.getChannelMeta(row.channel_id)
      const commentPrefix = buildTscopierCommentPrefix(row.id, commentSlug)
      const rawText = String(parsed.raw_instruction ?? '').toLowerCase()
      const ignoreKw = channelKeywords?.additional?.ignore_keyword?.trim().toLowerCase()
      const skipKw = channelKeywords?.additional?.skip_keyword?.trim().toLowerCase()
      if ((ignoreKw && rawText.includes(ignoreKw)) || (skipKw && rawText.includes(skipKw))) {
        // Channel-level ignore — parse-signal usually already short-circuits this,
        // but we double-check here so a stale parse can't slip through.
        return
      }

      if (isManagementAction(action)) {
        const mgmtCtx = managementFilterContextFromParsed(parsed)
        const mgmtBrokers = brokers.filter(
          b => !isChannelManagementBlocked(
            normalizeChannelMessageFiltersMap(b.channel_message_filters),
            row.channel_id,
            action,
            mgmtCtx,
          ),
        )
        if (!mgmtBrokers.length) {
          await ctx.logDispatchSkipped(row, 'channel_filter_ignored')
          return
        }
        await ctx.applyManagement(row, parsed, mgmtBrokers)
        return
      }

      const op = operationFor(action, parsed)
      if (!op || !parsed.symbol) return

      if (!liveFast) {
        for (const b of brokers) {
          const resolved = resolveChannelTradingConfig(b, row.channel_id)
          const ms = resolved.manual_settings
          console.log(
            `[tradeExecutor] channel config signal=${row.id} channel=${row.channel_id ?? 'none'}`
            + ` broker=${b.id} source=${resolved.config_source}`
            + ` style=${String(ms.trade_style ?? 'single')}`
            + ` fixed_lot=${String(ms.fixed_lot ?? 'missing')}`,
          )
        }
      }

      if (liveFast && row.pipeline_ts) {
        row.pipeline_ts.t_order_send_start = Date.now()
      }
      const outcomes = await Promise.all(
        brokers.map(b => ctx.sendOrder(row, parsed, op, b, channelKeywords, pipelineT0, {
          liveEntryFast: liveFast,
          commentPrefix,
          sameSignalRefresh: isMessageRevision,
        })),
      )
      if (liveFast && row.pipeline_ts) {
        row.pipeline_ts.t_order_send_done = Date.now()
      }
      const anyOpened = outcomes.some(o => o.openedOrMerged === true)
      const pipelineMs = Date.now() - pipelineT0
      const channelDelayMs = Math.max(...outcomes.map(o => o.channelDelayMs ?? 0))
      const channelDelaySkipped = outcomes.some(o => o.channelDelaySkipped === true)
      pipelineOutcome = {
        ...pipelineOutcome,
        any_opened: anyOpened,
        pipeline_ms: pipelineMs,
        brokers: brokers.length,
        dispatch_source: opts?.dispatchSource ?? null,
        channel_delay_ms: channelDelayMs > 0 ? channelDelayMs : null,
        channel_delay_skipped: channelDelaySkipped || null,
        has_listener_timestamps: !!(row.pipeline_ts?.t_listener_received && row.pipeline_ts?.t_dispatch_sent),
      }
      if (pipelineMs > 4000) {
        console.warn(
          `[tradeExecutor] slow pipeline signal=${row.id} user=${row.user_id} ms=${pipelineMs} brokers=${brokers.length}`,
        )
      }
      const strictSkips = outcomes.filter(o => o.signalEntryRequiredSkip === true).length
      const finalizeSkipReasons = outcomes
        .map(o => o.finalizeSkipReason)
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
      if (!anyOpened && strictSkips === brokers.length && strictSkips > 0) {
        try {
          const { error: sigErr } = await ctx.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: SKIP_REASON_SIGNAL_ENTRY_REQUIRED })
            .eq('id', row.id)
            .eq('status', 'parsed')
          if (sigErr) {
            console.warn(`[tradeExecutor] signal skip finalize failed id=${row.id}: ${sigErr.message}`)
          }
        } catch {
          // best-effort
        }
      } else if (!anyOpened && finalizeSkipReasons.length === brokers.length && finalizeSkipReasons.length > 0) {
        const skipReason = finalizeSkipReasons[0]!
        try {
          const { error: sigErr } = await ctx.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: skipReason })
            .eq('id', row.id)
            .eq('status', 'parsed')
          if (sigErr) {
            console.warn(`[tradeExecutor] signal skip finalize failed id=${row.id}: ${sigErr.message}`)
          }
        } catch {
          // best-effort
        }
      } else if (anyOpened) {
        await ctx.markSignalExecuted(row.id)
      } else if (isMessageRevision) {
        const revisionApplied = outcomes.some(o => o.openedOrMerged === true)
        if (revisionApplied) {
          await ctx.markSignalExecuted(row.id)
        } else {
          try {
            const { error: sigErr } = await ctx.supabase
              .from('signals')
              .update({ status: 'parsed', skip_reason: 'basket_modify_failed' })
              .eq('id', row.id)
            if (sigErr) {
              console.warn(
                `[tradeExecutor] revision modify failed finalize id=${row.id}: ${sigErr.message}`,
              )
            }
          } catch {
            // best-effort
          }
        }
      }
    } finally {
      const handleMs = Date.now() - handleStartMs
      if (liveFast) {
        ctx.logPipelineSummaryBackground(row, { handle_ms: handleMs, ...pipelineOutcome })
      } else {
        void ctx.logPipelineStage(row, 'handle_end', {
          handle_ms: handleMs,
          source: opts?.dispatchSource ?? null,
        })
      }
      ctx.inflight.delete(row.id)
      ctx.queuedIds.delete(row.id)
    }
  }

export async function getChannelMeta(ctx: TradeExecutorContext, channelId: string | null): Promise<{
    keywords: ChannelKeywords | null
    commentSlug: string | null
  }> {
    if (!channelId) return { keywords: null, commentSlug: null }
    const cached = ctx.channelMetaCache.get(channelId)
    if (cached && Date.now() - cached.loadedAt < 5 * 60_000) {
      return { keywords: cached.keywords, commentSlug: cached.commentSlug }
    }
    try {
      const { data } = await ctx.supabase
        .from('telegram_channels')
        .select('channel_keywords, display_name, channel_username')
        .eq('id', channelId)
        .maybeSingle()
      const row = data as {
        channel_keywords?: ChannelKeywords | null
        display_name?: string | null
        channel_username?: string | null
      } | null
      const keywords = row?.channel_keywords ?? null
      const label = resolveChannelLabelForComment(row?.display_name, row?.channel_username)
      const commentSlug = label ? sanitizeChannelCommentSlug(label) : null
      ctx.channelMetaCache.set(channelId, { keywords, commentSlug, loadedAt: Date.now() })
      return { keywords, commentSlug }
    } catch {
      ctx.channelMetaCache.set(channelId, { keywords: null, commentSlug: null, loadedAt: Date.now() })
      return { keywords: null, commentSlug: null }
    }
  }

export function brokerEligibleForSignal(ctx: TradeExecutorContext, broker: BrokerRow, signal: SignalRow): boolean {
    const activatedAt = ctx.brokerActivatedAt.get(broker.id)
    if (activatedAt == null) return true
    const createdAtRaw = (signal as { created_at?: string | number | null }).created_at
    if (createdAtRaw == null) return true
    const createdMs = typeof createdAtRaw === 'number'
      ? createdAtRaw
      : Date.parse(String(createdAtRaw))
    if (!Number.isFinite(createdMs)) return true
    return createdMs >= activatedAt
  }
