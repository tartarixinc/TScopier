import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
  hasMetatraderApiConfigured,
  isBrokerDisconnectedMessage,
  MT_SESSION_EXPIRED_HINT,
  mtPlatformFrom,
  MetatraderApiClient,
  MtOperation,
  normalizeSymbolParams,
  OrderSendArgs,
  SymbolParams,
} from '../metatraderapi'
import {
  clampPendingExpiryHours,
  computeCwOverrideTp,
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  signalEntryPriceStrictEnabled,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  lastPositiveParsedTpPrice,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerPartialTp,
  type PlannerResult,
  type VirtualPendingLeg,
} from '../manualPlanner'
import { normalizeManualSettingsForExecution } from '../manualPlanning/normalizeManualSettings'
import { findActiveNewsBlackout } from '../newsTrading/blackout'
import { getCalendarEventsCached } from '../newsTrading/calendarProvider'
import { isNewsTradingEnabled } from '../newsTrading/settings'
import { autoManagementTradeSnapshot } from '../autoManagement'
import {
  referencePriceForDirection,
  cweInstructionGroupKey,
  parseCweInstructionGroupKey,
  selectTradesForCweInstruction,
} from '../closeWorseEntries'
import {
  dispatchPriorityForAction,
  isEntryAction,
  isManagementAction,
  parsedAction,
  signalMatchesExecutorMode,
} from '../tradeSignalActions'
import { workerConfig, userBelongsToShard } from '../workerConfig'
import { writeBrokerConnectionStatus } from '../brokerConnectionStatus'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from '../monitorIdleGate'
import {
  isChannelManagementBlocked,
  isOppositeSignalCloseBlocked,
  isPendingCancelBlocked,
  normalizeChannelMessageFiltersMap,
  type ChannelMessageFiltersMap,
} from '../channelMessageFilters'
import { signalPipPrice } from '../signalPip'
import { trailingTradeRowSnapshot } from '../trailingStop'
import { isPostgresDuplicateKeyError } from '../rangePendingLegPersist'
import { cancelSignalEntryRowAtBroker, type SignalEntryPendingRow } from '../signalEntryPendingHelpers'
import {
  computeBasketMergeLinkContext,
  type BasketMergeLinkContext,
  MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
} from '../signalMergeLink'
import type { UserSessionManager } from '../sessionManager'
import {
  buildPerLegStopTargets,
  legacyMergeLinkingEnabled,
  mergePlanImmediateOrders,
  resolveLatestOpenBasketAnchor,
  shouldRouteAsBasketParameterRefresh,
  type MergeModifySummary,
} from '../multiTradeMerge'
import { symbolsCompatibleForBasket } from '../basketModFollowUp'
import {
  classifyGhostBasketLegs,
  closeStaleOpenTrades,
  fetchOpenBrokerTickets,
  fetchOpenBrokerTicketsStrict,
  GHOST_BASKET_CLOSED_USER_MESSAGE,
  markBasketReconcileDone,
  markBasketReconcileDoneForAnchor,
  runBasketLegModifies,
  upsertBasketReconcileJob,
  type BasketOpenLeg,
  type BasketSymbolParams,
} from '../basketSlTpReconcile'
import { syncRangePendingLadderOnBasketRefresh } from '../rangePendingLadderSync'
import { loadExistingRangeStepIndices } from '../rangePendingFireGuard'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import { takeProfitForLegIndex } from '../manualPlanning/tpBucketDistribution'
import {
  explicitMgmtSymbol,
  isReplyScopedManagement,
  loadOpenTradesForManagement,
  resolveChannelModifyTargets,
  type MgmtTradeRow,
} from '../managementScope'
import {
  applyChannelParamsToVirtualPendingList,
  estimateBasketTotalPlannedLegs,
  loadChannelActiveTradeParamsForSymbol,
  mergeParsedWithChannelParams,
  reapplyChannelParamsToPendingLegs,
  parsedSignalHasExplicitStops,
  shouldMergeChannelParamsForEntry,
  stripInvalidStopsForSide,
  symbolsForChannelParamsPersist,
  upsertChannelActiveTradeParams,
  type ChannelActiveTradeParams,
} from '../channelActiveTradeParams'
import {
  loadRangePendingLegsInMgmtScope,
  pendingLegsToCancelScopes,
  updateRangePendingLegsForManagement,
} from '../managementPendingLegs'
import { parsePipelineTimestamps, pipelineSummaryPayload, type PipelineTimestamps } from '../pipelineTimestamps'
import {
  buildTscopierCommentPrefix,
  resolveChannelLabelForComment,
  sanitizeChannelCommentSlug,
} from '../tradeComment'
import { applyPostFillFollowUp, type PostFillTradeLeg } from '../postFillFollowUp'
import { isBenignOrderModifyError } from '../orderModifyBenign'
import { invalidateChannelParseCache } from '../channelKeywordsCache'
import type { TradeExecutorContext } from './context'
import type { BrokerRow, ParsedSignal, RangePendingCancelScope, SignalRow } from './types'
import { isMtUuid } from './helpers'

interface CloseVerificationResult {
  confirmed: boolean
  reason?: string
  attempts: number
}

async function closeWithVerification(
  api: MetatraderApiClient,
  uuid: string,
  ticket: number,
  opts: { maxAttempts?: number; slippageEscalation?: number } = {},
): Promise<CloseVerificationResult> {
  const maxAttempts = opts.maxAttempts ?? 2
  const slippageStep = opts.slippageEscalation ?? 50

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const slippage = 20 + (attempt - 1) * slippageStep
    const result = await api.orderClose(uuid, { ticket, slippage })

    if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) {
      if (attempt >= maxAttempts) {
        return { confirmed: false, reason: `orderClose state=${result.state}`, attempts: attempt }
      }
      await new Promise(r => setTimeout(r, 300))
      continue
    }

    await new Promise(r => setTimeout(r, 400))

    let stillOpen = false
    try {
      const openOrders = await api.openedOrders(uuid)
      for (const raw of openOrders ?? []) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        const t = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (t === ticket) { stillOpen = true; break }
      }
    } catch {
      return { confirmed: true, attempts: attempt }
    }

    if (!stillOpen) {
      return { confirmed: true, attempts: attempt }
    }

    if (attempt >= maxAttempts) {
      return { confirmed: false, reason: 'ticket still open after orderClose + verification', attempts: attempt }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return { confirmed: false, reason: 'exhausted attempts', attempts: maxAttempts }
}

export async function logSendSkipped(ctx: TradeExecutorContext, 
    signal: SignalRow,
    broker: BrokerRow,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (reason === 'broker_session_not_connected') {
      const uuid = broker.metaapi_account_id
      if (uuid) {
        await ctx.markBrokerSessionDown(broker, uuid, 'broker_session_not_connected')
      }
    }
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'order_send',
        status: 'skipped',
        request_payload: { skip_reason: reason, ...extra } as unknown as Record<string, unknown>,
      })
    } catch {
      // Logging failure is non-fatal.
    }
  }

export async function skipMgmtSignal(ctx: TradeExecutorContext, signalId: string, reason: string): Promise<void> {
    try {
      await ctx.supabase
        .from('signals')
        .update({ status: 'skipped', skip_reason: reason })
        .eq('id', signalId)
        .eq('status', 'parsed')
    } catch { /* best-effort */ }
  }

export async function applyManagement(ctx: TradeExecutorContext, signal: SignalRow, parsed: ParsedSignal, brokers: BrokerRow[]): Promise<void> {
    if (!hasMetatraderApiConfigured()) return

    const brokerAccountIds = brokers.map(b => b.id)
    const replyScoped = isReplyScopedManagement(signal)
    const symbolFromText = explicitMgmtSymbol(parsed)
    let basketAnchorId: string | null = null
    let rows: MgmtTradeRow[] = []

    if (replyScoped && signal.parent_signal_id) {
      let symbolHint: string | null = symbolFromText
      try {
        const { data: ps } = await ctx.supabase
          .from('signals')
          .select('parsed_data')
          .eq('id', signal.parent_signal_id)
          .maybeSingle()
        const p = (ps as { parsed_data?: ParsedSignal | null } | null)?.parsed_data
        const fromParent = p?.symbol != null && String(p.symbol).trim() ? String(p.symbol).trim() : null
        if (!symbolHint && fromParent) symbolHint = fromParent
      } catch {
        // best-effort
      }

      basketAnchorId = signal.parent_signal_id
      const { count: parentOpenCount } = await ctx.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signal.parent_signal_id)
        .in('broker_account_id', brokerAccountIds)
        .eq('status', 'open')
      if ((parentOpenCount ?? 0) === 0) {
        const mgmtAction = String(parsed.action ?? '').toLowerCase()
        const mgmtDir = mgmtAction === 'buy' || mgmtAction === 'sell'
          ? mgmtAction
          : null
        const symForResolve = symbolHint?.trim() ?? ''
        if (mgmtDir && symForResolve && signal.channel_id && brokerAccountIds[0]) {
          const latest = await resolveLatestOpenBasketAnchor(ctx.supabase, {
            userId: signal.user_id,
            brokerAccountId: brokerAccountIds[0]!,
            brokerSymbol: symForResolve,
            signalSymbol: symForResolve,
            direction: mgmtDir,
            channelId: signal.channel_id,
          })
          if (latest) basketAnchorId = latest.anchorSignalId
        }
        if (!basketAnchorId || basketAnchorId === signal.parent_signal_id) {
          basketAnchorId = await ctx.resolveBasketAnchorSignalIdForOpenTrades({
            userId: signal.user_id,
            brokerAccountIds,
            channelId: signal.channel_id,
            parentSignalId: signal.parent_signal_id,
            symbolHint,
          })
        }
      }
      if (!basketAnchorId) {
        await ctx.skipMgmtSignal(signal.id, 'mgmt_no_open_trades')
        return
      }

      const { data } = await ctx.supabase
        .from('trades')
        .select(
          'id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price,opened_at,cwe_close_price',
        )
        .eq('signal_id', basketAnchorId)
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(500)
      rows = (data ?? []) as MgmtTradeRow[]
    } else {
      if (!signal.channel_id) {
        await ctx.skipMgmtSignal(signal.id, 'mgmt_no_open_trades')
        return
      }
      const actionPre = String(parsed.action ?? '').toLowerCase()
      let channelRows = await loadOpenTradesForManagement(ctx.supabase, {
        userId: signal.user_id,
        channelId: signal.channel_id,
        brokerAccountIds,
        symbolFilter: symbolFromText,
      })
      if (
        actionPre === 'modify'
        && !symbolFromText
        && channelRows.length > 0
      ) {
        channelRows = resolveChannelModifyTargets(channelRows, parsed)
      }
      rows = channelRows
      basketAnchorId = rows[0]?.signal_id ?? null
    }

    const byBroker = new Map(brokers.map(b => [b.id, b]))
    const action = String(parsed.action).toLowerCase()
    const cancelledPendingScopes = new Set<string>()

    const pendingLegs = await loadRangePendingLegsInMgmtScope(ctx.supabase, {
      userId: signal.user_id,
      brokerAccountIds,
      channelId: replyScoped ? null : signal.channel_id,
      basketSignalId: replyScoped ? basketAnchorId : null,
      symbolFilter: symbolFromText,
    })

    if (action === 'close') {
      for (const scope of pendingLegsToCancelScopes(pendingLegs)) {
        cancelledPendingScopes.add(JSON.stringify(scope satisfies RangePendingCancelScope))
      }
      const earlyScopes = Array.from(cancelledPendingScopes)
        .map(enc => JSON.parse(enc) as RangePendingCancelScope)
        .filter(scope => {
          const broker = byBroker.get(scope.brokerAccountId)
          if (!broker) return false
          return !isPendingCancelBlocked(
            normalizeChannelMessageFiltersMap(broker.channel_message_filters),
            signal.channel_id,
          )
        })
      if (earlyScopes.length) {
        await ctx.cancelRangePendingLegsForScopes(signal.user_id, signal.id, earlyScopes, 'signal_closed')
      }
    }

    const sanitizeLevel = (v: number | null | undefined): number => {
      const n = typeof v === 'number' ? v : Number(v ?? 0)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    const hasNewSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
    const parsedTpLevels = (parsed.tp ?? []).filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    )
    const hasNewTp = parsedTpLevels.length > 0

    const mgmtCtx = { hasNewSl, hasNewTp }

    if (action === 'close_worse_entries') {
      if (!rows.length) {
        await ctx.skipMgmtSignal(signal.id, 'mgmt_no_open_trades')
        return
      }
      const eligibleBrokers = brokers.filter(
        b => !isChannelManagementBlocked(
          normalizeChannelMessageFiltersMap(b.channel_message_filters),
          signal.channel_id,
          action,
          mgmtCtx,
        ),
      )
      if (!eligibleBrokers.length) {
        try {
          await ctx.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: 'channel_filter_ignored' })
            .eq('id', signal.id)
            .eq('status', 'parsed')
        } catch { /* best-effort */ }
        return
      }
      const eligibleIds = new Set(eligibleBrokers.map(b => b.id))
      const eligibleRows = rows.filter(r => eligibleIds.has(r.broker_account_id))
      const eligibleByBroker = new Map(eligibleBrokers.map(b => [b.id, b]))
      await ctx.applyCloseWorseEntriesInstruction(signal, parsed, eligibleRows, eligibleByBroker)
      return
    }

    if (!rows.length && !pendingLegs.length) {
      const skipReason = action === 'modify' && !symbolFromText && !replyScoped
        ? 'mgmt_ambiguous_modify'
        : 'mgmt_no_open_trades'
      await ctx.skipMgmtSignal(signal.id, skipReason)
      return
    }

    if (action === 'close' && !rows.length && pendingLegs.length) {
      const scopes = Array.from(cancelledPendingScopes)
        .map(enc => JSON.parse(enc) as RangePendingCancelScope)
        .filter(scope => {
          const broker = byBroker.get(scope.brokerAccountId)
          if (!broker) return false
          return !isPendingCancelBlocked(
            normalizeChannelMessageFiltersMap(broker.channel_message_filters),
            signal.channel_id,
          )
        })
      if (scopes.length) {
        await ctx.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'signal_closed')
      }
      try {
        await ctx.supabase
          .from('signals')
          .update({ status: 'executed' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
      return
    }

    const rowsByBrokerSignal = new Map<string, MgmtTradeRow[]>()
    for (const tr of rows) {
      const key = `${tr.broker_account_id}|${tr.signal_id}`
      const list = rowsByBrokerSignal.get(key) ?? []
      list.push(tr)
      rowsByBrokerSignal.set(key, list)
    }

    await Promise.allSettled(rows.map(async trade => {
      const broker = byBroker.get(trade.broker_account_id)
      if (!broker || !isMtUuid(broker.metaapi_account_id)) return
      if (isChannelManagementBlocked(
        normalizeChannelMessageFiltersMap(broker.channel_message_filters),
        signal.channel_id,
        action,
        mgmtCtx,
      )) {
        return
      }
      const uuid = broker.metaapi_account_id!
      const ticket = Number(trade.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) return
      const api = ctx.apiFor(broker)
      if (!api) return
      const basketKey = `${trade.broker_account_id}|${trade.signal_id}`
      const brokerRows = rowsByBrokerSignal.get(basketKey) ?? [trade]
      const legIndex = brokerRows.findIndex(r => r.id === trade.id)
      const manual = (broker.manual_settings ?? {}) as ManualSettings
      const multiBasket =
        manual.trade_style === 'multi'
        && brokerRows.length > 1
        && parsedTpLevels.length >= 2

      try {
        if (action === 'close') {
          const closeResult = await closeWithVerification(api, uuid, ticket, { maxAttempts: 2, slippageEscalation: 50 })
          if (!closeResult.confirmed) {
            throw new Error(
              closeResult.reason ?? 'orderClose succeeded but ticket still open on broker',
            )
          }
          await ctx.supabase.from('trades').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', trade.id)
          cancelledPendingScopes.add(JSON.stringify({
            signalId: trade.signal_id,
            brokerAccountId: trade.broker_account_id,
            symbol: trade.symbol,
          } satisfies RangePendingCancelScope))
        } else if (action === 'partial_profit' || action === 'partial_breakeven') {
          const fraction = typeof parsed.partial_close_fraction === 'number' && parsed.partial_close_fraction > 0
            ? Math.min(0.95, parsed.partial_close_fraction)
            : 0.5
          const lots = +(trade.lot_size * fraction).toFixed(2)
          await api.orderClose(uuid, { ticket, lots })
          const remaining = Math.max(0, +(trade.lot_size - lots).toFixed(2))
          if (remaining < 0.0001) {
            await ctx.supabase.from('trades').update({
              status: 'closed',
              closed_at: new Date().toISOString(),
              lot_size: 0,
            }).eq('id', trade.id)
          } else {
            await ctx.supabase.from('trades').update({ lot_size: remaining }).eq('id', trade.id)
          }
        } else if (action === 'breakeven') {
          const entry = sanitizeLevel(trade.entry_price)
          if (entry > 0) {
            await api.orderModify(uuid, {
              ticket,
              stoploss: entry,
              takeprofit: sanitizeLevel(trade.tp),
            })
            await ctx.supabase.from('trades').update({ sl: entry }).eq('id', trade.id)
          }
        } else if (action === 'modify') {
          const newSl = hasNewSl ? (parsed.sl as number) : sanitizeLevel(trade.sl)
          let newTp = hasNewTp ? parsedTpLevels[0]! : sanitizeLevel(trade.tp)
          if (hasNewTp && multiBasket && legIndex >= 0) {
            const distributed = takeProfitForLegIndex({
              legIndex,
              openLegCount: brokerRows.length,
              finalTps: parsedTpLevels,
              tpLots: manual.tp_lots,
            })
            if (distributed > 0) newTp = distributed
          }
          await api.orderModify(uuid, {
            ticket,
            stoploss: newSl,
            takeprofit: newTp,
          })
          const dbPatch: Record<string, number | null> = {}
          if (hasNewSl) dbPatch.sl = parsed.sl as number
          if (hasNewTp) dbPatch.tp = newTp
          if (Object.keys(dbPatch).length > 0) {
            await ctx.supabase.from('trades').update(dbPatch).eq('id', trade.id)
          }
        }
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: 'success',
          request_payload: {
            ticket,
            action,
            basket_anchor_signal_id: trade.signal_id,
            mgmt_scope: replyScoped ? 'reply_basket' : 'channel',
            mgmt_parent_signal_id: signal.parent_signal_id,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const benign = isBenignOrderModifyError(msg)
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: benign ? 'success' : 'failed',
          request_payload: {
            ticket,
            action,
            basket_anchor_signal_id: trade.signal_id,
            mgmt_scope: replyScoped ? 'reply_basket' : 'channel',
            mgmt_parent_signal_id: signal.parent_signal_id,
            already_synced: benign || undefined,
          },
          error_message: benign ? null : msg,
        })
      }
    }))

    if (
      (action === 'modify' || action === 'breakeven' || action === 'partial_breakeven')
      && pendingLegs.length
      && (hasNewSl || hasNewTp || action === 'breakeven' || action === 'partial_breakeven')
    ) {
      const tpLotsByBroker = new Map(
        brokers.map(b => [b.id, ((b.manual_settings ?? {}) as ManualSettings).tp_lots]),
      )
      const pendingUpdated = await updateRangePendingLegsForManagement({
        supabase: ctx.supabase,
        parsed,
        pendingLegs,
        openTrades: rows,
        tpLotsByBroker,
        action,
        hasNewSl,
        hasNewTp,
        parsedTpLevels,
      })
      if (pendingUpdated > 0) {
        console.log(
          `[tradeExecutor] mgmt updated ${pendingUpdated} range_pending_legs signal=${signal.id} action=${action}`,
        )
      }
    }

    if (
      action === 'modify'
      && signal.channel_id
      && (hasNewSl || hasNewTp)
    ) {
      const symbols = symbolsForChannelParamsPersist({
        symbolFromText,
        tradeSymbols: rows.map(r => r.symbol),
        pendingSymbols: pendingLegs.map(l => l.symbol),
      })
      await upsertChannelActiveTradeParams(ctx.supabase, {
        userId: signal.user_id,
        channelId: signal.channel_id,
        symbols,
        stoploss: hasNewSl ? (parsed.sl as number) : null,
        tpLevels: hasNewTp ? parsedTpLevels : undefined,
      })
      const openLegCountByBasket = new Map<string, number>()
      for (const tr of rows) {
        const key = `${tr.signal_id}|${tr.broker_account_id}`
        openLegCountByBasket.set(key, (openLegCountByBasket.get(key) ?? 0) + 1)
      }
      const tpLotsByBroker = new Map(
        brokers.map(b => [b.id, ((b.manual_settings ?? {}) as ManualSettings).tp_lots]),
      )
      const mgmtSignalIds = replyScoped && basketAnchorId ? [basketAnchorId] : null
      for (const sym of symbols) {
        const n = await reapplyChannelParamsToPendingLegs({
          supabase: ctx.supabase,
          userId: signal.user_id,
          channelId: signal.channel_id,
          brokerAccountIds,
          symbolHint: sym,
          signalIds: mgmtSignalIds,
          tpLotsByBroker,
          openLegCountByBasket,
        })
        if (n > 0) {
          console.log(
            `[tradeExecutor] channel params reapplied to ${n} range_pending_legs signal=${signal.id} symbol=${sym}`,
          )
        }
      }
    }

    if (action === 'close' && cancelledPendingScopes.size > 0) {
      const scopes = Array.from(cancelledPendingScopes)
        .map(enc => JSON.parse(enc) as RangePendingCancelScope)
        .filter(scope => {
          const broker = byBroker.get(scope.brokerAccountId)
          if (!broker) return false
          return !isPendingCancelBlocked(
            normalizeChannelMessageFiltersMap(broker.channel_message_filters),
            signal.channel_id,
          )
        })
      if (scopes.length > 0) {
        await ctx.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'signal_closed')
      }
    }

    // Management messages do not insert `trades` with `signal_id = this row`,
    // so `sweep()` never skips them via the "trade already exists" guard.
    // Flip off `parsed` after one dispatch so we never double-apply the same
    // Close half / breakeven / modify intent on every 15s tick.
    try {
      const { error: sigErr } = await ctx.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', signal.id)
        .eq('status', 'parsed')
      if (sigErr) {
        console.warn(`[tradeExecutor] mgmt signal finalize failed id=${signal.id}: ${sigErr.message}`)
      }
    } catch {
      // best-effort
    }
  }

export async function applyCloseWorseEntriesInstruction(ctx: TradeExecutorContext, 
    signal: SignalRow,
    parsed: ParsedSignal,
    rows: Array<{
      id: string
      broker_account_id: string
      metaapi_order_id: string | null
      symbol: string
      direction: string
      lot_size: number
      status: string
      entry_price: number | null
      cwe_close_price?: number | null
    }>,
    byBroker: Map<string, BrokerRow>,
  ): Promise<void> {
    if (!hasMetatraderApiConfigured()) return

    const openRows = rows.filter(r => r.status === 'open')
    if (!openRows.length) {
      try {
        await ctx.supabase
          .from('signals')
          .update({ status: 'skipped', skip_reason: 'cwe_no_open_trades' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
      return
    }

    const groups = new Map<string, typeof openRows>()
    for (const t of openRows) {
      const key = cweInstructionGroupKey(t)
      const list = groups.get(key) ?? []
      list.push(t)
      groups.set(key, list)
    }

    await Promise.allSettled(Array.from(groups.entries()).map(async ([key, groupTrades]) => {
      const parsedKey = parseCweInstructionGroupKey(key)
      if (!parsedKey) return
      const { brokerId, symbol, direction } = parsedKey
      const broker = byBroker.get(brokerId)
      if (!broker || !isMtUuid(broker.metaapi_account_id)) return

      const manual = (broker.manual_settings ?? {}) as ManualSettings
      if (manual.trade_style !== 'multi' || manual.close_worse_entries !== true) {
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close_worse_entries',
          status: 'skipped',
          request_payload: {
            reason: 'close_worse_entries_disabled',
            trade_style: manual.trade_style ?? 'single',
            close_worse_entries: manual.close_worse_entries === true,
          },
        })
        return
      }

      const pips = Math.max(1, Number(manual.close_worse_entries_pips ?? 30))
      const uuid = broker.metaapi_account_id!
      const api = ctx.apiFor(broker)
      if (!api) return
      const pipSize = signalPipPrice(symbol)
      if (!Number.isFinite(pipSize) || pipSize <= 0) {
        console.warn(`[tradeExecutor] cwe instruction skip: invalid pip size symbol=${symbol}`)
        return
      }

      let q: { bid: number; ask: number }
      try {
        q = await api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[tradeExecutor] cwe instruction /Quote failed symbol=${symbol}: ${msg}`)
        return
      }

      const ref = referencePriceForDirection(direction, q.bid, q.ask)
      const toClose = selectTradesForCweInstruction({
        trades: groupTrades,
        referencePrice: ref,
        pips,
        pipSize,
      })

      console.log(
        `[tradeExecutor] cwe instruction signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` ref=${ref} pips=${pips} matched=${toClose.length}/${groupTrades.length}`,
      )

      for (const trade of toClose) {
        const ticket = Number(trade.metaapi_order_id)
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        try {
          const closeResult = await closeWithVerification(api, uuid, ticket, { maxAttempts: 2, slippageEscalation: 50 })
          if (!closeResult.confirmed) {
            throw new Error(closeResult.reason ?? 'cwe orderClose: ticket still open')
          }
          await ctx.supabase
            .from('trades')
            .update({
              status: 'closed',
              closed_at: new Date().toISOString(),
              cwe_close_price: null,
            })
            .eq('id', trade.id)
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'mgmt_close_worse_entries',
            status: 'success',
            request_payload: {
              ticket,
              symbol,
              direction: trade.direction,
              entry_price: trade.entry_price,
              reference_price: ref,
              pips,
              pip_size: pipSize,
            },
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
          if (benign) {
            await ctx.supabase
              .from('trades')
              .update({
                status: 'closed',
                closed_at: new Date().toISOString(),
                cwe_close_price: null,
              })
              .eq('id', trade.id)
          } else {
            await ctx.supabase.from('trade_execution_logs').insert({
              user_id: signal.user_id,
              signal_id: signal.id,
              broker_account_id: broker.id,
              action: 'mgmt_close_worse_entries',
              status: 'failed',
              request_payload: {
                ticket,
                symbol,
                entry_price: trade.entry_price,
                reference_price: ref,
                pips,
              },
              error_message: msg,
            })
          }
        }
      }
    }))

    try {
      const { error: sigErr } = await ctx.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', signal.id)
        .eq('status', 'parsed')
      if (sigErr) {
        console.warn(`[tradeExecutor] cwe instruction finalize failed id=${signal.id}: ${sigErr.message}`)
      }
    } catch {
      // best-effort
    }
  }
