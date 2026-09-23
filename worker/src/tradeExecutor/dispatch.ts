import type { TradeExecutorContext } from './context'
import { hasFxsocketConfigured } from '../fxsocketClient'
import type { BrokerRow, QueuedSignal, SendOrderOutcome, SignalRow } from './types'
import {
  dispatchPriorityForAction,
  isEntryAction,
  isManagementAction,
  parsedAction,
  signalMatchesExecutorMode,
} from '../tradeSignalActions'
import { workerConfig } from '../workerConfig'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import { loadCachedUserCopierPaused, signalPredatesCopierResume } from '../copierPause'
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
import { SKIP_REASON_SIGNAL_ENTRY_REQUIRED, SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED, SKIP_REASON_SIGNAL_ENTRY_RANGE_EXPIRED, SKIP_REASON_ENTRY_NOT_OPENED } from '../manualPlanner'
import {
  buildPipelineCorrelation,
  emitPipelineEvent,
  parsePipelineTimestamps,
  pipelineSummaryPayload,
  setPipelineTimestamp,
} from '../pipelineTimestamps'
import { signalExecutionProven } from '../signalExecutionProven'
import { resolveChannelLabelForComment, sanitizeChannelCommentSlug } from '../tradeComment'
import { ensureSignalRow } from '../ensureSignalRow'
import { operationFor, brokerHasLinkedSession } from './helpers'
import {
  EXECUTOR_MAX_CONCURRENT_SIGNALS,
  EXECUTOR_REPLAY_MAX_AGE_MS,
  PARSED_STATUSES,
  telegramLiveTradeGateEnabled,
} from './types'
import type { ChannelKeywords } from '../manualPlanner'
import { ACTIVITY_RETRY_DISPATCH_SOURCE } from '../retryActivity'
import { loadSignalById, MESSAGE_REVISION_DISPATCH_SOURCE, revisionDirectionFlippedFromActions } from '../signalRevision'
import { SIGNAL_RANGE_WAKE_DISPATCH_SOURCE } from '../signalRangeEntryHelpers'
import { finalizeSignalIfAllWaitsTerminal, syncWaitRow } from '../signalRangeEntryService'
import { signalEntryRangeStrictEnabled } from '../manualPlanning/manualSettings'
import { applyUserOverrideToSignalRow } from '../signalOverride'
import { incMetric } from '../workerMetrics'
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
import { isV2 } from '../engine/executionMode'
import { upsertBasketSlTpTarget } from '../basketTargetStore'
import { captureBusinessIssue } from '../observability/businessEvents'

/** Seed basket desired-state (source 'entry') for v2-flagged brokers only, so the v2
 * reconciler has the full SL/TP ladder. No-op for v1 brokers (zero behavior change). */
async function seedV2EntryDesiredState(
  ctx: TradeExecutorContext,
  row: SignalRow,
  parsed: ParsedSignal,
  brokers: BrokerRow[],
): Promise<void> {
  const sl = typeof parsed.sl === 'number' && parsed.sl > 0 ? parsed.sl : null
  const tps = Array.isArray(parsed.tp)
    ? parsed.tp.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0)
    : []
  if (sl == null && tps.length === 0) return
  for (const b of brokers) {
    if (!isV2({ brokerAccountId: b.id, userId: row.user_id, provider: b.provider })) continue
    const reverse = (b.manual_settings as { reverse_signal?: boolean } | null)?.reverse_signal === true
    // Channel SL/TP are still the original side. Seeding them as desired state
    // would later overwrite the reversed ticket's predefined/mirrored stops.
    if (reverse) continue
    const isBuy = String(parsed.action ?? '').toLowerCase() === 'buy'
    const refPrice = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : Number(v ?? 0)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const ref = refPrice(parsed.entry_price) ?? refPrice(parsed.entry_zone_low) ?? refPrice(parsed.entry_zone_high)
    await upsertBasketSlTpTarget(ctx.supabase, {
      userId: row.user_id,
      brokerAccountId: b.id,
      anchorSignalId: row.id,
      channelId: row.channel_id,
      symbol: parsed.symbol ?? 'UNKNOWN',
      stoploss: sl,
      tpLevels: tps.length ? tps : null,
      source: 'entry',
      instructionAt: row.created_at,
      isBuy,
      referencePrice: ref,
    }).catch(() => {})
  }
}

export function shouldUseEntryFastPath(ctx: TradeExecutorContext, row: SignalRow): boolean {
    const mode = workerConfig.tradeExecutorMode
    if (mode !== 'entry' && mode !== 'all') return false
    const parsed = row.parsed_data
    if (!parsed) return false
    // Entry actions (buy/sell) take the live fast path — including teaser-completion
    // and SL/TP follow-up signals that route to merge-modify inside entryPrepare.
    // Whether the signal opens a trade or modifies the open basket is decided there
    // (never OrderSend-first for parameter refresh); the fast path only bypasses the
    // in-process queue + heavy idempotency and enables parallel leg modifies.
    return isEntryAction(parsedAction(parsed))
  }

function revisionDirectionFlip(row: SignalRow): boolean {
  if (!row.revision_prior_action) return false
  const action = parsedAction(row.parsed_data)
  return revisionDirectionFlippedFromActions(row.revision_prior_action, action)
}

/** Live management bypasses in-process queue + heavy idempotency (mirror entry fast path). */
export function shouldUseMgmtFastPath(row: SignalRow, source?: string): boolean {
  const mode = workerConfig.tradeExecutorMode
  if (mode !== 'mgmt' && mode !== 'all') return false
  const parsed = row.parsed_data
  if (!parsed) return false
  if (source === MESSAGE_REVISION_DISPATCH_SOURCE && revisionDirectionFlip(row)) {
    return false
  }
  const action = parsedAction(parsed)
  if (isManagementAction(action)) return true
  if (
    source === MESSAGE_REVISION_DISPATCH_SOURCE
    && shouldRouteAsBasketParameterRefresh(parsed)
  ) {
    return true
  }
  return false
}

export function isLiveMgmtFast(
  opts?: {
    liveDispatch?: boolean
    lightIdempotency?: boolean
    dispatchSource?: string
  },
  parsed?: { action?: string } | null,
  row?: SignalRow,
): boolean {
  if (opts?.liveDispatch !== true || opts?.lightIdempotency !== true) return false
  if (
    opts.dispatchSource === MESSAGE_REVISION_DISPATCH_SOURCE
    && row?.revision_prior_action
    && revisionDirectionFlippedFromActions(row.revision_prior_action, parsedAction(parsed))
  ) {
    return false
  }
  const action = parsedAction(parsed)
  if (isManagementAction(action)) return true
  // Parameter-refresh entries (teaser completion: zone + market-now + SL/TP, and
  // SL/TP follow-ups) route to merge-modify, so run their leg modifies on the fast
  // (parallel) path regardless of dispatch source — not just message revisions.
  if (parsed && shouldRouteAsBasketParameterRefresh(parsed as ParsedSignal)) {
    return true
  }
  return false
}

export function revisionInflightWaitMs(row: SignalRow, dispatchSource?: string): number {
  if (dispatchSource !== MESSAGE_REVISION_DISPATCH_SOURCE) return 60_000
  const parsed = row.parsed_data
  if (!parsed) return 60_000
  const action = parsedAction(parsed)
  if (isManagementAction(action)) return 10_000
  if (shouldRouteAsBasketParameterRefresh(parsed as ParsedSignal) && !isEntryAction(action)) {
    return 10_000
  }
  if (shouldRouteAsBasketParameterRefresh(parsed as ParsedSignal)) {
    return 10_000
  }
  return 60_000
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
          const entryFast = ctx.shouldUseEntryFastPath(row)
          const mgmtFast = shouldUseMgmtFastPath(row, item.source)
          const useFastPath = entryFast || mgmtFast
          const job = ctx.handleSignal(row, {
            liveDispatch: useFastPath || item.liveDispatch === true,
            lightIdempotency: useFastPath,
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

/** Skip reasons that may clear when listener lease recovers — keep signal parsed for sweep/replay. */
const TRANSIENT_DISPATCH_SKIP_REASONS = new Set(['telegram_listener_not_live'])

export async function logDispatchSkipped(ctx: TradeExecutorContext, 
    signal: SignalRow,
    skipReason: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const transient = TRANSIENT_DISPATCH_SKIP_REASONS.has(skipReason)
    if (skipReason === 'telegram_listener_not_live') {
      incMetric('dispatch_skipped_listener_not_live')
      console.warn(
        `[tradeExecutor] dispatch_skipped telegram_listener_not_live`
        + ` signal=${signal.id} user=${signal.user_id} channel=${signal.channel_id ?? 'n/a'}`,
      )
    }
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
          transient,
          ...extra,
        },
      })
      if (!transient) {
        await ctx.supabase
          .from('signals')
          .update({ status: 'skipped', skip_reason: skipReason })
          .eq('id', signal.id)
          .in('status', ['parsed', 'pending'])
      }
    } catch {
      /* best-effort */
    }
    if (!transient) {
      const reason = skipReason.toUpperCase().replace(/[^A-Z0-9_]+/g, '_')
      captureBusinessIssue({
        category: skipReason.includes('subscription') || skipReason.includes('plan_')
          ? 'auth'
          : skipReason.includes('broker') || skipReason.includes('channel_config')
            ? 'account'
            : 'trade',
        event: skipReason.includes('copy_limit') || skipReason.includes('risk') || skipReason.includes('max_')
          ? 'trade_copy_blocked'
          : skipReason.includes('broker')
            ? 'broker_account_unavailable'
            : 'trade_copy_blocked',
        severity: skipReason.includes('broker') || skipReason.includes('listener') ? 'error' : 'warning',
        reasonCode: reason,
        message: 'Signal dispatch skipped before trade execution',
        userImpact: 'skipped',
        context: {
          user_id: signal.user_id,
          signal_id: signal.id,
          channel_id: signal.channel_id,
          telegram_message_id: signal.telegram_message_id,
          operation: 'dispatch',
          extra: {
            skip_reason: skipReason,
            ...extra,
          },
        },
      })
    }
  }

export function logPipelineSummaryBackground(ctx: TradeExecutorContext, 
    signal: SignalRow,
    extra?: Record<string, unknown>,
  ): void {
    const ts = signal.pipeline_ts ?? {}
    const listenerToDispatchMs = ts.t_dispatch_received != null && ts.t_listener_received != null
      ? ts.t_dispatch_received - ts.t_listener_received
      : null
    const handleMs = typeof extra?.handle_ms === 'number' ? extra.handle_ms : null
    const mgmtFast = extra?.mgmt_fast_path === true
    const dispatchSource = extra?.dispatch_source ?? null
    const action = parsedAction(signal.parsed_data)
    if (isManagementAction(action)) {
      if (!mgmtFast) {
        console.warn(
          `[tradeExecutor] mgmt slow path signal=${signal.id} source=${String(dispatchSource ?? 'unknown')}`
          + `${listenerToDispatchMs != null ? ` listener_to_dispatch_ms=${listenerToDispatchMs}` : ''}`,
        )
      }
      if (handleMs != null && handleMs > 2_000) {
        console.warn(
          `[tradeExecutor] slow mgmt handle signal=${signal.id} ms=${handleMs}`
          + ` fast=${mgmtFast} source=${String(dispatchSource ?? 'unknown')}`,
        )
      }
    }
    void ctx.supabase
      .from('trade_execution_logs')
      .insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        action: 'pipeline_summary',
        status: 'success',
        request_payload: pipelineSummaryPayload(ts, {
          ...extra,
          listener_to_dispatch_ms: listenerToDispatchMs,
        }) as unknown as Record<string, unknown>,
      })
      .then(({ error }) => {
        if (error) {
          console.warn(`[tradeExecutor] pipeline_summary log failed signal=${signal.id}: ${error.message}`)
        }
      })
  }

export async function markSignalExecuted(ctx: TradeExecutorContext, signalId: string): Promise<void> {
    if (!(await signalExecutionProven(ctx.supabase, signalId))) return
    try {
      await ctx.supabase
        .from('signals')
        .update({ status: 'executed', skip_reason: null })
        .eq('id', signalId)
        // Include skipped: revision can trade after an initial skip while leaving status stuck.
        .in('status', ['parsed', 'pending', 'failed', 'skipped'])
    } catch {
      /* best-effort */
    }
  }

export function aggregateEntryFailureReason(outcomes: SendOrderOutcome[]): string {
  const reasons = outcomes
    .map(o => o.finalizeSkipReason ?? o.failureReason)
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
  return reasons[0] ?? SKIP_REASON_ENTRY_NOT_OPENED
}

async function signalDispatchAlreadyHandled(ctx: TradeExecutorContext, signalId: string): Promise<boolean> {
    return signalExecutionProven(ctx.supabase, signalId)
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
      wakeBrokerAccountId?: string
    },
  ) {
    if (!hasFxsocketConfigured()) return
    const isMessageRevisionEarly = opts?.dispatchSource === MESSAGE_REVISION_DISPATCH_SOURCE
    if (isMessageRevisionEarly) {
      await waitForSignalInflightClear(
        ctx,
        row.id,
        revisionInflightWaitMs(row, opts?.dispatchSource),
      )
    }
    // Defense in depth: guarantee signals row exists before OrderSend / post-fill FKs.
    // raw_message is preserved from any existing row (ensureSignalRow ignores empty
    // values) so listener-persisted Telegram text survives dispatch upserts.
    const ensured = await ensureSignalRow(ctx.supabase, {
      id: row.id,
      user_id: row.user_id,
      channel_id: row.channel_id,
      status: row.status || 'parsed',
      parsed_data: (row.parsed_data ?? null) as Record<string, unknown> | null,
      telegram_message_id: row.telegram_message_id ?? null,
      reply_to_message_id: row.reply_to_message_id ?? null,
      parent_signal_id: row.parent_signal_id,
      is_modification: row.is_modification,
      pipeline_ts: row.pipeline_ts as Record<string, unknown> | undefined,
    })
    if (ensured.duplicate && ensured.existingSignalId) {
      // Another signal owns this telegram message — a duplicate dispatch that
      // must not execute (double-executes management/entry actions). The owner
      // signal is already being handled by the executor.
      console.warn(
        `[tradeExecutor] duplicate dispatch skipped signal=${row.id} existing=${ensured.existingSignalId}`
        + ` user=${row.user_id} message=${row.telegram_message_id ?? 'n/a'}`,
      )
      return
    }
    if (!ensured.ok) {
      console.error(
        `[tradeExecutor] ensureSignalRow before handle failed signal=${row.id}: ${ensured.error ?? 'unknown'}`,
      )
    }
    if (!ctx.claimSignalExecution(row.id)) {
      emitPipelineEvent({
        event: 'execution_duplicate_prevented',
        correlation: buildPipelineCorrelation({
          userId: row.user_id,
          signalId: row.id,
          channelId: row.channel_id,
          telegramMessageId: row.telegram_message_id,
          brokerAccountId: opts?.wakeBrokerAccountId ?? row.wake_broker_account_id,
          dispatchSource: opts?.dispatchSource,
        }),
        timestamps: row.pipeline_ts,
        outcome: 'inflight',
        path: opts?.dispatchSource ?? 'executor',
      })
      return
    }

    if (await loadCachedUserCopierPaused(ctx.supabase, row.user_id)) {
      ctx.inflight.delete(row.id)
      ctx.queuedIds.delete(row.id)
      const action = parsedAction(row.parsed_data)
      if (isManagementAction(action)) {
        await ctx.logDispatchSkipped(row, 'copier_paused')
      }
      return
    }

    if (signalPredatesCopierResume(row.user_id, row.created_at)) {
      ctx.inflight.delete(row.id)
      ctx.queuedIds.delete(row.id)
      return
    }

    const handleStartMs = Date.now()
    setPipelineTimestamp(row.pipeline_ts ?? (row.pipeline_ts = {}), 'execution_planning_started_at', handleStartMs)
    const isRangeWake = opts?.dispatchSource === SIGNAL_RANGE_WAKE_DISPATCH_SOURCE
    const liveFast = isRangeWake
      || (opts?.liveDispatch === true && opts?.lightIdempotency === true)
    const liveMgmtFast = isLiveMgmtFast(opts, row.parsed_data, row)
    const channelMetaPromise = (liveFast || liveMgmtFast) && row.channel_id
      ? ctx.getChannelMeta(row.channel_id)
      : null
    const queueWaitMs = opts?.dispatchReceivedAt != null
      ? Math.max(0, handleStartMs - (opts.dispatchReceivedAt as number))
      : null
    let pipelineOutcome: Record<string, unknown> = {
      live_fast: liveFast,
      mgmt_fast_path: liveMgmtFast,
      dispatch_source: opts?.dispatchSource ?? null,
    }
    const isMessageRevision = opts?.dispatchSource === MESSAGE_REVISION_DISPATCH_SOURCE
    const isActivityRetry = opts?.dispatchSource === ACTIVITY_RETRY_DISPATCH_SOURCE
    try {
      if (!opts?.liveDispatch && !isMessageRevision && !isActivityRetry && ctx.signalTooOldForReplay(row)) return

      if (!liveFast && !liveMgmtFast) {
        void ctx.logPipelineStage(row, 'handle_start', {
          live_dispatch: opts?.liveDispatch === true,
          source: opts?.dispatchSource ?? null,
          queue_wait_ms: queueWaitMs,
        })
      }

      if (!isMessageRevision && !isActivityRetry && !isRangeWake && !liveFast && !liveMgmtFast && await ctx.signalAlreadyHandled(row.id)) {
        await ctx.markSignalExecuted(row.id)
        return
      }
      let userSub: Awaited<ReturnType<typeof loadCachedUserSubscription>>
      let isAdmin: boolean
      if (
        (liveFast || liveMgmtFast)
        && telegramLiveTradeGateEnabled()
        && row.channel_id
        && ctx.sessionManager
      ) {
        const [teleLive, sub, admin] = await Promise.all([
          ctx.sessionManager.canExecuteTelegramCopierTradesAsync(row.user_id, row.channel_id),
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
            ? await ctx.sessionManager.canExecuteTelegramCopierTradesAsync(row.user_id, row.channel_id)
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
      if (!isAdmin && (!userSub || !isSubscriptionActive(userSub.status, userSub.trial_ends_at))) {
        await ctx.logDispatchSkipped(row, 'subscription_inactive')
        return
      }

      if (isMessageRevision) {
        const fresh = await loadSignalById(ctx.supabase, row.id)
        if (!fresh?.parsed_data?.action) return
        // Telegram edit already wrote authoritative parsed_data — do not overlay
        // stale per-signal user_override SL/TP on top of the revision.
        row = {
          ...row,
          parsed_data: fresh.parsed_data,
          user_override: fresh.user_override,
        }
        const { data: activeWaits } = await ctx.supabase
          .from('signal_range_entry_waits')
          .select('id, broker_account_id, metaapi_account_id, symbol')
          .eq('signal_id', row.id)
          .eq('status', 'waiting')
        if (activeWaits?.length && row.parsed_data) {
          for (const waitRow of activeWaits) {
            const broker = ctx.brokersById.get(waitRow.broker_account_id)
            if (!broker) continue
            const manual = resolveChannelTradingConfig(broker, row.channel_id).manual_settings
            if (!signalEntryRangeStrictEnabled(manual)) {
              await ctx.supabase
                .from('signal_range_entry_waits')
                .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                .eq('id', waitRow.id)
                .eq('status', 'waiting')
              continue
            }
            await syncWaitRow(ctx.supabase, {
              signal: row,
              broker,
              uuid: waitRow.metaapi_account_id,
              symbol: waitRow.symbol,
              parsed: row.parsed_data,
              manual,
              preserveExpiresAt: true,
              logUpdates: true,
            })
          }
        }
      } else {
        row = applyUserOverrideToSignalRow(row)
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
        b.is_active && brokerHasLinkedSession(b) && channelMatchesBrokerSignal(b, row.channel_id),
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
      const wakeBrokerId = opts?.wakeBrokerAccountId ?? row.wake_broker_account_id
      if (isRangeWake && wakeBrokerId) {
        brokers = brokers.filter(b => b.id === wakeBrokerId)
      }
      const signalSymbolForWarm = parsed.symbol?.trim() ?? ''
      if (liveFast && signalSymbolForWarm && brokers.length > 0) {
        pipelineOutcome.brokers_warm_at_dispatch = ctx.brokersWarmForLiveEntry(
          brokers,
          signalSymbolForWarm,
        )
      }
      if (brokers.length > 0 && row.channel_id && !(liveMgmtFast && isManagementAction(action))) {
        const profileTz = ctx.userTimezoneById.get(row.user_id)
        const channelId = row.channel_id
        if (liveFast && parsed.symbol) {
          void ctx.prewarmBrokersForLiveEntry(brokers, parsed.symbol)
        }
        const copyLimitSkipReasons: string[] = []
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
              copyLimitSkipReasons.push(pause.reason)
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
        if (!brokers.length && copyLimitSkipReasons.length > 0) {
          // Per-broker skip already logged (e.g. channel_max_risk_hit).
          return
        }
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
          const staleAfterReactivation = allMatchingBrokers.length > 0
            && allMatchingBrokers.every(b => !ctx.brokerEligibleForSignal(b, row))
          if (!staleAfterReactivation) {
            captureBusinessIssue({
              category: 'account',
              event: 'broker_account_unavailable',
              severity: 'warning',
              reasonCode: 'NO_ELIGIBLE_BROKER_ACCOUNT',
              message: 'Signal matched configured brokers but none were currently eligible',
              userImpact: 'skipped',
              context: {
                user_id: row.user_id,
                signal_id: row.id,
                channel_id: row.channel_id,
                telegram_message_id: row.telegram_message_id,
                operation: 'dispatch',
                extra: {
                  raw_matching_brokers: rawMatchingBrokers.length,
                  configured_matching_brokers: allMatchingBrokers.length,
                },
              },
            })
            return
          }
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
      const rawText = String(parsed.raw_instruction ?? '').toLowerCase()
      const ignoreKw = channelKeywords?.additional?.ignore_keyword?.trim().toLowerCase()
      const skipKw = channelKeywords?.additional?.skip_keyword?.trim().toLowerCase()
      if ((ignoreKw && rawText.includes(ignoreKw)) || (skipKw && rawText.includes(skipKw))) {
        // Channel-level ignore — parse-signal usually already short-circuits this,
        // but we double-check here so a stale parse can't slip through.
        await ctx.logDispatchSkipped(row, 'channel_filter_ignored')
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
        const mgmtWallStart = Date.now()
        const mgmtResult = await ctx.applyManagement(row, parsed, mgmtBrokers, { liveMgmtFast })
        pipelineOutcome = {
          ...pipelineOutcome,
          mgmt_wall_ms: Date.now() - mgmtWallStart,
          mgmt_legs_total: mgmtResult.legsTotal,
          mgmt_legs_parallelism: mgmtResult.legsParallelism,
          mgmt_scope_load_ms: mgmtResult.scopeLoadMs ?? null,
          mgmt_baskets_total: mgmtResult.basketsTotal ?? null,
          mgmt_basket_apply_ms: mgmtResult.basketApplyMs ?? null,
          mgmt_basket_concurrency: mgmtResult.basketConcurrency ?? null,
          mgmt_action: action,
        }
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
          liveMgmtFast,
          commentSlug,
          sameSignalRefresh: isMessageRevision,
        })),
      )
      setPipelineTimestamp(row.pipeline_ts ?? (row.pipeline_ts = {}), 'execution_planning_completed_at', Date.now())
      if (liveFast && row.pipeline_ts) {
        row.pipeline_ts.t_order_send_done = Date.now()
      }
      const anyOpened = outcomes.some(o => o.openedOrMerged === true)
      const openedCount = outcomes.filter(o => o.openedOrMerged === true).length
      const failedCount = outcomes.length - openedCount
      const entryFailureReason = !anyOpened && isEntryAction(action)
        ? aggregateEntryFailureReason(outcomes)
        : null
      if (isEntryAction(action) && anyOpened && failedCount > 0) {
        const failureReasons = [...new Set(outcomes
          .filter(o => o.openedOrMerged !== true)
          .map(o => o.finalizeSkipReason ?? o.failureReason ?? 'UNKNOWN'))]
        captureBusinessIssue({
          category: 'trade',
          event: 'trade_copy_partial',
          severity: 'warning',
          reasonCode: 'PARTIAL_MULTI_ACCOUNT_EXECUTION',
          message: 'Trade copied to some accounts or legs but failed for others',
          userImpact: 'partial',
          context: {
            user_id: row.user_id,
            signal_id: row.id,
            channel_id: row.channel_id,
            telegram_message_id: row.telegram_message_id,
            broker_account_id: opts?.wakeBrokerAccountId ?? row.wake_broker_account_id,
            operation: 'order_send',
            symbol: parsed.symbol ?? null,
            side: String(action ?? ''),
            extra: {
              attempted_count: outcomes.length,
              successful_count: openedCount,
              failed_count: failedCount,
              failure_reasons: failureReasons.slice(0, 8),
              user_exposure_may_be_partial: true,
            },
          },
        })
      }
      if (isEntryAction(action) && !anyOpened && outcomes.length > 0 && entryFailureReason) {
        captureBusinessIssue({
          category: 'trade',
          event: 'trade_copy_failed',
          severity: 'error',
          reasonCode: entryFailureReason,
          message: 'Signal accepted but trade copy permanently failed',
          userImpact: 'failed',
          context: {
            user_id: row.user_id,
            signal_id: row.id,
            channel_id: row.channel_id,
            telegram_message_id: row.telegram_message_id,
            operation: 'order_send',
            symbol: parsed.symbol ?? null,
            side: String(action ?? ''),
            extra: {
              attempted_count: outcomes.length,
              failure_reason: entryFailureReason,
            },
          },
        })
      }
      if (anyOpened) {
        // v2 cutover: seed the basket desired-state at entry so the single v2
        // reconciler can fill naked legs from the ladder and converge every future
        // layer to the same SL/TP (no "new layers take old SL", no naked legs).
        void seedV2EntryDesiredState(ctx, row, parsed, brokers)
      }
      const pipelineMs = Date.now() - pipelineT0
      const channelDelayMs = Math.max(...outcomes.map(o => o.channelDelayMs ?? 0))
      const channelDelaySkipped = outcomes.some(o => o.channelDelaySkipped === true)
      pipelineOutcome = {
        ...pipelineOutcome,
        any_opened: anyOpened,
        failure_reason: entryFailureReason,
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
      const rangeRequiredSkips = outcomes.filter(o => o.signalRangeEntryRequiredSkip === true).length
      const rangeDeferred = outcomes.some(o => o.signalRangeEntryDeferred === true)
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
      } else if (!anyOpened && rangeRequiredSkips === brokers.length && rangeRequiredSkips > 0) {
        try {
          const { error: sigErr } = await ctx.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED })
            .eq('id', row.id)
            .eq('status', 'parsed')
          if (sigErr) {
            console.warn(`[tradeExecutor] signal skip finalize failed id=${row.id}: ${sigErr.message}`)
          }
        } catch {
          // best-effort
        }
      } else if (rangeDeferred) {
        try {
          const { error: sigErr } = await ctx.supabase
            .from('signals')
            .update({ status: 'parsed', skip_reason: null })
            .eq('id', row.id)
            .eq('status', 'parsed')
          if (sigErr) {
            console.warn(`[tradeExecutor] signal range wait finalize failed id=${row.id}: ${sigErr.message}`)
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
        const { count: waitingWaits } = await ctx.supabase
          .from('signal_range_entry_waits')
          .select('id', { count: 'exact', head: true })
          .eq('signal_id', row.id)
          .eq('status', 'waiting')
        if ((waitingWaits ?? 0) === 0) {
          await ctx.markSignalExecuted(row.id)
        }
      } else if (!anyOpened && isRangeWake) {
        await finalizeSignalIfAllWaitsTerminal(ctx.supabase, row.id)
      } else if (!anyOpened && !rangeDeferred) {
        const { count: waitingWaits } = await ctx.supabase
          .from('signal_range_entry_waits')
          .select('id', { count: 'exact', head: true })
          .eq('signal_id', row.id)
          .eq('status', 'waiting')
        if ((waitingWaits ?? 0) === 0) {
          const { count: expiredWaits } = await ctx.supabase
            .from('signal_range_entry_waits')
            .select('id', { count: 'exact', head: true })
            .eq('signal_id', row.id)
            .eq('status', 'expired')
          if ((expiredWaits ?? 0) > 0) {
            try {
              await ctx.supabase
                .from('signals')
                .update({ status: 'skipped', skip_reason: SKIP_REASON_SIGNAL_ENTRY_RANGE_EXPIRED })
                .eq('id', row.id)
                .eq('status', 'parsed')
            } catch {
              // best-effort
            }
          } else if (isEntryAction(action)) {
            const failReason = entryFailureReason ?? SKIP_REASON_ENTRY_NOT_OPENED
            const alreadyProven = await signalExecutionProven(ctx.supabase, row.id)
            if (alreadyProven) {
              await ctx.markSignalExecuted(row.id)
            } else if (!isMessageRevision) {
              try {
                await ctx.supabase
                  .from('signals')
                  .update({ status: 'failed', skip_reason: failReason })
                  .eq('id', row.id)
                  .eq('status', 'parsed')
              } catch {
                // best-effort
              }
            } else {
              await ctx.markSignalExecuted(row.id)
            }
          }
        }
      } else if (isMessageRevision) {
        const revisionApplied = outcomes.some(o => o.openedOrMerged === true)
        if (revisionApplied) {
          await ctx.markSignalExecuted(row.id)
        } else if (rangeDeferred) {
          try {
            await ctx.supabase
              .from('signals')
              .update({ status: 'parsed', skip_reason: null })
              .eq('id', row.id)
          } catch {
            // best-effort
          }
        } else {
          const { count: activeWaits } = await ctx.supabase
            .from('signal_range_entry_waits')
            .select('id', { count: 'exact', head: true })
            .eq('signal_id', row.id)
            .eq('status', 'waiting')
          if ((activeWaits ?? 0) > 0) {
            try {
              await ctx.supabase
                .from('signals')
                .update({ status: 'parsed', skip_reason: null })
                .eq('id', row.id)
            } catch {
              // best-effort
            }
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
      }
    } finally {
      const handleMs = Date.now() - handleStartMs
      const listenerTs = parsePipelineTimestamps(row.pipeline_ts)
      const listenerToDispatchMs = listenerTs?.t_dispatch_received != null
        && listenerTs?.t_listener_received != null
        ? listenerTs.t_dispatch_received - listenerTs.t_listener_received
        : null
      const summaryExtra = {
        handle_ms: handleMs,
        listener_to_dispatch_ms: listenerToDispatchMs,
        ...pipelineOutcome,
      }
      if (liveFast || liveMgmtFast) {
        ctx.logPipelineSummaryBackground(row, summaryExtra)
      } else {
        void ctx.logPipelineStage(row, 'handle_end', {
          handle_ms: handleMs,
          source: opts?.dispatchSource ?? null,
          ...pipelineOutcome,
        })
      }
      emitPipelineEvent({
        event: pipelineOutcome.any_opened === true ? 'execution_completed' : 'execution_skipped',
        correlation: buildPipelineCorrelation({
          userId: row.user_id,
          signalId: row.id,
          channelId: row.channel_id,
          telegramMessageId: row.telegram_message_id,
          brokerAccountId: opts?.wakeBrokerAccountId ?? row.wake_broker_account_id,
          dispatchSource: opts?.dispatchSource,
        }),
        timestamps: row.pipeline_ts,
        outcome: pipelineOutcome.any_opened === true ? 'success' : 'skipped',
        path: liveFast ? 'live_fast' : liveMgmtFast ? 'management_fast' : 'queued',
        extra: summaryExtra,
      })
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
    if (!broker.is_active) return false
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
