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
} from '../../metatraderapi'
import {
  clampPendingExpiryHours,
  computeCwOverrideTp,
  parsedHasExplicitEntryAnchor,
  planSinglePartialTps,
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
} from '../../manualPlanner'
import { normalizeManualSettingsForExecution } from '../../manualPlanning/normalizeManualSettings'
import { findActiveNewsBlackout } from '../../newsTrading/blackout'
import { getCalendarEventsCached } from '../../newsTrading/calendarProvider'
import { isNewsTradingEnabled } from '../../newsTrading/settings'
import { autoManagementTradeSnapshot } from '../../autoManagement'
import {
  referencePriceForDirection,
  cweInstructionGroupKey,
  parseCweInstructionGroupKey,
  selectTradesForCweInstruction,
} from '../../closeWorseEntries'
import {
  dispatchPriorityForAction,
  isEntryAction,
  isManagementAction,
  parsedAction,
  signalMatchesExecutorMode,
} from '../../tradeSignalActions'
import { workerConfig, userBelongsToShard } from '../../workerConfig'
import { writeBrokerConnectionStatus } from '../../brokerConnectionStatus'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from '../../monitorIdleGate'
import {
  isChannelManagementBlocked,
  isOppositeSignalCloseBlocked,
  isPendingCancelBlocked,
  normalizeChannelMessageFiltersMap,
  type ChannelMessageFiltersMap,
} from '../../channelMessageFilters'
import { signalPipPrice } from '../../signalPip'
import { trailingTradeRowSnapshot } from '../../trailingStop'
import { isPostgresDuplicateKeyError } from '../../rangePendingLegPersist'
import { cancelSignalEntryRowAtBroker, type SignalEntryPendingRow } from '../../signalEntryPendingHelpers'
import {
  computeBasketMergeLinkContext,
  type BasketMergeLinkContext,
  MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
} from '../../signalMergeLink'
import type { UserSessionManager } from '../../sessionManager'
import {
  buildPerLegStopTargets,
  legacyMergeLinkingEnabled,
  mergePlanImmediateOrders,
  resolveLatestOpenBasketAnchor,
  shouldRouteAsBasketParameterRefresh,
  type MergeModifySummary,
} from '../../multiTradeMerge'
import { symbolsCompatibleForBasket } from '../../basketModFollowUp'
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
} from '../../basketSlTpReconcile'
import { syncRangePendingLadderOnBasketRefresh } from '../../rangePendingLadderSync'
import { loadExistingRangeStepIndices } from '../../rangePendingFireGuard'
import { channelMatchesBrokerSignal } from '../../brokerChannelFilter'
import { resolveTpBucketRows } from '../../manualPlanning/tpBucketDistribution'
import {
  explicitMgmtSymbol,
  isReplyScopedManagement,
  loadOpenTradesForManagement,
  resolveChannelModifyTargets,
  type MgmtTradeRow,
} from '../../managementScope'
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
} from '../../channelActiveTradeParams'
import {
  loadRangePendingLegsInMgmtScope,
  pendingLegsToCancelScopes,
  updateRangePendingLegsForManagement,
} from '../../managementPendingLegs'
import { parsePipelineTimestamps, pipelineSummaryPayload, type PipelineTimestamps } from '../../pipelineTimestamps'
import {
  buildTscopierCommentPrefix,
  resolveChannelLabelForComment,
  sanitizeChannelCommentSlug,
} from '../../tradeComment'
import { applyPostFillFollowUp, type PostFillTradeLeg } from '../../postFillFollowUp'
import { isBenignOrderModifyError } from '../../orderModifyBenign'
import { invalidateChannelParseCache } from '../../channelKeywordsCache'
import type { TradeExecutorContext } from '../context'
import type {
  BrokerRow,
  MergeOutcome,
  ParsedSignal,
  RangePendingCancelScope,
  SignalRow,
  SymbolCacheEntry,
} from '../types'
import { computeCweTp, roundLot, triggerPriceFor } from '../helpers'

import { cancelRangePendingLegsForScopes } from './pendingCancel'
import { persistRangePendingLegRows } from './helpers'

export async function applyBasketSlTpRefresh(ctx: TradeExecutorContext, args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    commentPrefix: string
    anchorSignalId: string
    direction: 'buy' | 'sell'
    logAction: 'merge_routed_modify_only' | 'signal_merge_into_open_trade'
    messageEditOnly?: boolean
    mergeLinkMeta?: Record<string, unknown>
  }): Promise<{ success: boolean; summary: MergeModifySummary }> {
    const {
      signal, parsed, broker, channelKeywords, baseLot, params, symbol, uuid,
      strictEntryPrefetch, commentPrefix, anchorSignalId, direction, logAction, mergeLinkMeta,
      messageEditOnly,
    } = args
    const api = ctx.apiFor(broker)
    if (!api) {
      return {
        success: false,
        summary: { openLegs: 0, attempted: 0, modified: 0, failed: 0, skippedNoTicket: 0 },
      }
    }
    const manual = (broker.manual_settings ?? {}) as ManualSettings

    const loadFamilyTrades = async (): Promise<BasketOpenLeg[]> => {
      const { data: familyRows, error: famErr } = await ctx.supabase
        .from('trades')
        .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
        .eq('broker_account_id', broker.id)
        .eq('signal_id', anchorSignalId)
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(500)
      if (famErr) {
        console.warn(
          `[tradeExecutor] basket refresh load trades failed signal=${signal.id} anchor=${anchorSignalId}: ${famErr.message}`,
        )
        return []
      }
      const symHint = parsed.symbol ?? symbol
      return ((familyRows ?? []) as BasketOpenLeg[]).filter(tr =>
        symbolsCompatibleForBasket(symHint, tr.symbol)
        || symbolsCompatibleForBasket(symbol, tr.symbol),
      )
    }

    let familyTrades = await loadFamilyTrades()
    if (!familyTrades.length) {
      return {
        success: false,
        summary: { openLegs: 0, attempted: 0, modified: 0, failed: 0, skippedNoTicket: 0 },
      }
    }

    const newest = familyTrades[familyTrades.length - 1]!
    const rpe0 = resolvedParsedEntryPrice(parsed)
    const rzo0 = resolvedParsedEntryZone(parsed)
    let plannerParsed: PlannerParsedSignal = {
      action: parsed.action,
      symbol: parsed.symbol,
      entry_price: messageEditOnly ? null : rpe0,
      entry_zone_low: messageEditOnly ? null : (rzo0?.lo ?? parsed.entry_zone_low),
      entry_zone_high: messageEditOnly ? null : (rzo0?.hi ?? parsed.entry_zone_high),
      sl: parsed.sl,
      tp: parsed.tp,
      lot_size: parsed.lot_size,
      open_tp: parsed.open_tp,
      partial_close_fraction: parsed.partial_close_fraction,
      raw_instruction: parsed.raw_instruction,
    }
    let channelParamsForLadder: ChannelActiveTradeParams | null = null
    if (signal.channel_id) {
      channelParamsForLadder = await loadChannelActiveTradeParamsForSymbol(
        ctx.supabase,
        signal.user_id,
        signal.channel_id,
        symbol,
      )
      if (logAction === 'signal_merge_into_open_trade' && channelParamsForLadder) {
        plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParamsForLadder, {
          overlay: true,
        })
      }
    }
    const effectiveParsed: ParsedSignal = {
      ...parsed,
      sl: plannerParsed.sl,
      tp: plannerParsed.tp,
    }
    if (!parsedHasExplicitEntryAnchor(plannerParsed)) {
      const ep = Number(newest.entry_price)
      if (Number.isFinite(ep) && ep > 0) plannerParsed.entry_price = ep
    }
    if (!parsedHasExplicitEntryAnchor(plannerParsed)) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        plannerParsed.entry_price = direction === 'buy' ? q.ask : q.bid
      } catch {
        console.warn(`[tradeExecutor] basket refresh skipped: no entry anchor signal=${signal.id}`)
        return {
          success: false,
          summary: {
            openLegs: familyTrades.length,
            attempted: 0,
            modified: 0,
            failed: 0,
            skippedNoTicket: familyTrades.length,
          },
        }
      }
    }

    const mergeBaseOp: MtOperation = direction === 'buy' ? 'Buy' : 'Sell'
    const plan = planManualOrders({
      parsed: plannerParsed,
      resolvedSymbol: symbol,
      baseOperation: mergeBaseOp,
      manual,
      channelKeywords,
      manualLot: baseLot,
      ctx: {
        point: params?.point ?? 0.00001,
        digits: params?.digits ?? 5,
        minLot: params?.minLot ?? 0.01,
        lotStep: params?.lotStep ?? 0.01,
        contractSize: params?.contractSize ?? null,
        stopsLevel: params?.stopsLevel ?? 0,
        freezeLevel: params?.freezeLevel ?? 0,
        defaultLot: Number(broker.default_lot_size ?? 0.01),
        lastBalance: broker.last_balance ?? null,
        liveBid: strictEntryPrefetch?.bid,
        liveAsk: strictEntryPrefetch?.ask,
      },
      commentPrefix,
      expertId: 909090,
      slippage: 20,
    })

    if (plan.skip_reason) {
      return {
        success: false,
        summary: {
          openLegs: familyTrades.length,
          attempted: 0,
          modified: 0,
          failed: 0,
          skippedNoTicket: 0,
        },
      }
    }

    const refreshTpLevels = (effectiveParsed.tp ?? []).filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    )
    if (
      logAction === 'merge_routed_modify_only'
      && signal.channel_id
      && (typeof effectiveParsed.sl === 'number' && effectiveParsed.sl > 0 || refreshTpLevels.length > 0)
    ) {
      await upsertChannelActiveTradeParams(ctx.supabase, {
        userId: signal.user_id,
        channelId: signal.channel_id,
        symbols: [symbol],
        stoploss: effectiveParsed.sl,
        tpLevels: refreshTpLevels,
      })
      channelParamsForLadder = await loadChannelActiveTradeParamsForSymbol(
        ctx.supabase,
        signal.user_id,
        signal.channel_id,
        symbol,
      )
    }

    if (plan.delay_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(plan.delay_ms, 30_000)))
    }

    let virtualPendings = (plan.virtualPendings ?? []).slice(0, 500)
    const { data: activePendingRows } = await ctx.supabase
      .from('range_pending_legs')
      .select('step_idx')
      .eq('signal_id', anchorSignalId)
      .eq('broker_account_id', broker.id)
      .in('status', ['pending', 'claimed'])
      .limit(500)
    const activePendingCount = activePendingRows?.length ?? 0
    const maxPendingStepIdx = Math.max(0, ...(activePendingRows ?? []).map(r => Number(r.step_idx) || 0))
    const basketTotalPlannedLegs = Math.max(
      estimateBasketTotalPlannedLegs({
        openLegCount: familyTrades.length,
        activePendingCount,
        maxPendingStepIdx,
      }),
      familyTrades.length + virtualPendings.length,
    )
    if (signal.channel_id && virtualPendings.length > 0) {
      if (!channelParamsForLadder) {
        channelParamsForLadder = await loadChannelActiveTradeParamsForSymbol(
          ctx.supabase,
          signal.user_id,
          signal.channel_id,
          symbol,
        )
      }
      if (channelParamsForLadder) {
        const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount)
        const immediateEstimate = Math.max(0, familyTrades.length - firedPendingApprox)
        virtualPendings = applyChannelParamsToVirtualPendingList(
          virtualPendings,
          channelParamsForLadder,
          immediateEstimate,
          manual.tp_lots,
          basketTotalPlannedLegs,
        )
      }
    }
    const refreshImmediateLegCount = messageEditOnly
      ? familyTrades.length
      : Math.max(
          mergePlanImmediateOrders(plan).length,
          Math.max(0, familyTrades.length - Math.max(0, maxPendingStepIdx - activePendingCount)),
        )
    const parsedTpLevels = (effectiveParsed.tp ?? []).filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    )
    const singlePartialPlan = manual.trade_style !== 'multi' && parsedTpLevels.length > 0
      ? planSinglePartialTps({
          manualLot: baseLot,
          minLot: Number.isFinite(params?.minLot) && (params?.minLot ?? 0) > 0 ? (params?.minLot as number) : 0.01,
          lotStep: Number.isFinite(params?.lotStep) && (params?.lotStep ?? 0) > 0 ? (params?.lotStep as number) : 0.01,
          finalTps: parsedTpLevels,
          bucketRows: resolveTpBucketRows(parsedTpLevels, manual.tp_lots).bucketRows,
          singleTpTarget: manual.single_tp_target,
          isBuy: direction === 'buy',
        })
      : null
    let perLegTargets = buildPerLegStopTargets({
      plan,
      parsed: effectiveParsed,
      openLegCount: familyTrades.length,
      totalPlannedLegCount: basketTotalPlannedLegs,
      immediateLegCount: refreshImmediateLegCount,
      tpLots: manual.tp_lots,
    })
    if (manual.trade_style !== 'multi' && singlePartialPlan?.brokerTp) {
      perLegTargets = perLegTargets.map(target => ({ ...target, takeprofit: singlePartialPlan.brokerTp as number }))
    }

    let anchor: number | null = plan.anchor?.value ?? null
    if ((virtualPendings.length > 0 || !!plan.closeWorseEntries) && (anchor == null || anchor <= 0)) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        anchor = plan.isBuy === false ? q.bid : q.ask
      } catch { /* drop virtuals below */ }
    }
    const overrideTp = computeCweTp(plan, anchor, params)
    let nImmCwe = 0
    if (overrideTp != null && plan.closeWorseEntries) {
      nImmCwe = Math.max(0, Math.min(perLegTargets.length, plan.closeWorseEntries.immediates))
      for (let i = 0; i < nImmCwe; i++) {
        if (perLegTargets[i]) perLegTargets[i]!.takeprofit = 0
      }
    }

    for (const t of familyTrades) {
      try {
        await ctx.supabase.from('partial_tp_legs').delete().eq('trade_id', t.id)
      } catch { /* best-effort */ }
    }

    const basketParams: BasketSymbolParams | null = params
      ? {
          digits: params.digits,
          point: params.point,
          minLot: params.minLot,
          lotStep: params.lotStep,
          contractSize: params.contractSize,
          stopsLevel: params.stopsLevel,
          freezeLevel: params.freezeLevel,
        }
      : null

    let openedTickets: Set<number> | null = null
    try {
      openedTickets = await fetchOpenBrokerTickets(api, uuid)
    } catch { /* preflight optional */ }

    const modifiedTradeIds = new Set<string>()
    let legErrors: Array<{ error: string; leg_index: number }> = []
    let summary: MergeModifySummary & { skippedNotOnBroker?: number } = {
      openLegs: familyTrades.length,
      attempted: 0,
      modified: 0,
      failed: 0,
      skippedNoTicket: 0,
      skippedNotOnBroker: 0,
    }
    const stragglerRounds = Math.min(
      12,
      Math.max(3, Number(process.env.BASKET_REFRESH_STRAGGLER_ROUNDS ?? 8)),
    )

    for (let round = 0; round < stragglerRounds; round++) {
      if (round > 0) {
        await new Promise(r => setTimeout(r, Math.min(round, 4) * 200))
        familyTrades = await loadFamilyTrades()
        summary.openLegs = familyTrades.length
        const refreshedTargets = buildPerLegStopTargets({
          plan,
          parsed: effectiveParsed,
          openLegCount: familyTrades.length,
          totalPlannedLegCount: basketTotalPlannedLegs,
          immediateLegCount: refreshImmediateLegCount,
          tpLots: manual.tp_lots,
        })
        if (manual.trade_style !== 'multi' && singlePartialPlan?.brokerTp) {
          for (let i = 0; i < refreshedTargets.length; i++) {
            refreshedTargets[i] = { ...refreshedTargets[i]!, takeprofit: singlePartialPlan.brokerTp }
          }
        }
        if (refreshedTargets.length) {
          perLegTargets.length = 0
          perLegTargets.push(...refreshedTargets)
        }
        if (round === 1) {
          try {
            openedTickets = await fetchOpenBrokerTickets(api, uuid)
          } catch { /* optional */ }
        }
      }
      const pending = familyTrades.filter(tr => !modifiedTradeIds.has(tr.id))
      if (!pending.length) break
      if (round > 0 && pending.every(tr => {
        const t = Number(tr.metaapi_order_id)
        return !Number.isFinite(t) || t <= 0
      })) {
        break
      }

      const pass = await runBasketLegModifies({
        supabase: ctx.supabase,
        api,
        uuid,
        symbol,
        direction,
        baseLot,
        params: basketParams,
        signalId: signal.id,
        userId: signal.user_id,
        brokerAccountId: broker.id,
        familyTrades,
        perLegTargets,
        signalTps: (effectiveParsed.tp ?? []).filter(
          (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
        ),
        tpLots: manual.tp_lots,
        nImmCwe,
        overrideTp,
        strictEntryPrefetch,
        openedTickets,
        alreadyModified: modifiedTradeIds,
      })
      for (const id of pass.modifiedTradeIds) modifiedTradeIds.add(id)
      summary = pass.summary
      legErrors = pass.legErrors.map(e => ({ error: e.error, leg_index: e.leg_index }))
      if (modifiedTradeIds.size >= familyTrades.length) break
    }

    const stillMissingTicket = familyTrades.filter(tr => {
      const t = Number(tr.metaapi_order_id)
      return !Number.isFinite(t) || t <= 0
    }).length
    summary.skippedNoTicket = stillMissingTicket

    if (manual.trade_style !== 'multi' && singlePartialPlan && modifiedTradeIds.size > 0) {
      const partialRows = [...modifiedTradeIds].flatMap(tradeId =>
        singlePartialPlan.partials.map(p => ({
          trade_id: tradeId,
          signal_id: signal.id,
          user_id: signal.user_id,
          broker_account_id: broker.id,
          metaapi_account_id: uuid,
          symbol,
          is_buy: direction === 'buy',
          tp_idx: p.tpIdx,
          trigger_price: p.triggerPrice,
          close_lots: p.closeLots,
          status: 'pending',
        })),
      )
      if (partialRows.length > 0) {
        const { error: partialErr } = await ctx.supabase
          .from('partial_tp_legs')
          .insert(partialRows)
        if (partialErr) {
          console.warn(
            `[tradeExecutor] basket_refresh partial_tp_legs insert failed signal=${signal.id} broker=${broker.id}: ${partialErr.message}`,
          )
        }
      }
    }

    if (virtualPendings.length > 0 && anchor != null && Number.isFinite(anchor) && anchor > 0) {
      if (overrideTp != null && plan.closeWorseEntries) {
        const nVirt = virtualPendings.length
        for (let i = 0; i < nVirt; i++) {
          virtualPendings[i] = {
            ...virtualPendings[i]!,
            takeprofit: null,
            comment: `${virtualPendings[i]!.comment}.cw`,
            cweClosePrice: overrideTp,
          }
        }
      }
        const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
        const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0)
        const zoneHi = safe > 0 ? anchor + (safe + 2) * (params?.point ?? 0) : null
        const zoneLo = safe > 0 ? anchor - (safe + 2) * (params?.point ?? 0) : null
        const nowMs = Date.now()
      const plannedImmediateLegs = Math.max(
        mergePlanImmediateOrders(plan).length,
        plan.closeWorseEntries?.immediates ?? 0,
      )
      const ladderSync = await syncRangePendingLadderOnBasketRefresh({
        supabase: ctx.supabase,
        scope: { signalId: anchorSignalId, brokerAccountId: broker.id, symbol },
        virtualPendings,
        openTradeCount: familyTrades.length,
        plannedImmediateLegs,
        plannedRangeLegs: virtualPendings.length,
        channelParams: channelParamsForLadder,
        tpLots: manual.tp_lots,
        buildInsertRow: (v) => {
          const triggerPrice = triggerPriceFor(v, anchor, digits)
          if (zoneHi != null && zoneLo != null && triggerPrice > zoneLo && triggerPrice < zoneHi) {
            return null
          }
          const expiresAt = v.expiryHours && v.expiryHours > 0
            ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
            : null
          return {
            signal_id: anchorSignalId,
            user_id: signal.user_id,
            broker_account_id: broker.id,
            metaapi_account_id: uuid,
            symbol,
            step_idx: v.stepIdx,
            is_buy: v.isBuy,
            volume: roundLot(v.volume, params),
            anchor_price: anchor,
            trigger_price: triggerPrice,
            stoploss: v.stoploss,
            takeprofit: v.takeprofit,
            slippage: v.slippage,
            comment: v.comment,
            expert_id: v.expertID ?? null,
            expires_at: expiresAt,
            status: 'pending',
            cwe_close_price: v.cweClosePrice ?? null,
          }
        },
        persistRows: (rows, persistCtx) => persistRangePendingLegRows(ctx, rows, persistCtx),
        context: `basket_refresh signal=${signal.id} anchor=${anchorSignalId}`,
      })
      if (ladderSync.skippedConsumed > 0 || ladderSync.skippedCap > 0) {
        console.log(
          `[tradeExecutor] basket_refresh ladder sync signal=${signal.id} anchor=${anchorSignalId}`
          + ` updated=${ladderSync.updated} inserted=${ladderSync.inserted}`
          + ` skip_consumed=${ladderSync.skippedConsumed} skip_cap=${ladderSync.skippedCap}`,
        )
      }
    }

    let mergeFailed = summary.modified < summary.openLegs
    const skippedBroker = summary.skippedNotOnBroker ?? 0
    const allLegsGhostOnBroker =
      summary.openLegs > 0
      && skippedBroker >= summary.openLegs
      && summary.modified === 0
      && stillMissingTicket === 0

    if (allLegsGhostOnBroker) {
      const closedCount = await closeStaleOpenTrades(
        ctx.supabase,
        familyTrades.map(tr => tr.id),
      )
      await markBasketReconcileDoneForAnchor(ctx.supabase, broker.id, anchorSignalId)
            mergeFailed = true
            console.log(
        `[tradeExecutor] ghost basket closed after modify signal=${signal.id} broker=${broker.id}`
        + ` anchor=${anchorSignalId} closed=${closedCount}`,
      )
    }

    let partialMsg = mergeFailed
      ? `Not all trades were modified (${summary.modified}/${summary.openLegs} open legs`
        + `${stillMissingTicket > 0 ? `; ${stillMissingTicket} still waiting for broker ticket` : ''}`
        + `${skippedBroker > 0 ? `; ${skippedBroker} not on broker` : ''}`
        + `${summary.failed > 0 ? `; ${summary.failed} broker modify errors` : ''})`
      : null
    if (allLegsGhostOnBroker) {
      partialMsg = GHOST_BASKET_CLOSED_USER_MESSAGE
    }

    if (mergeFailed && !allLegsGhostOnBroker) {
      await upsertBasketReconcileJob(ctx.supabase, {
        userId: signal.user_id,
        brokerAccountId: broker.id,
        anchorSignalId,
        sourceSignalId: signal.id,
        channelId: signal.channel_id,
        symbol,
        direction,
        perLegTargets,
        familyTrades,
        signalTps: (effectiveParsed.tp ?? []).filter(
          (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
        ),
        tpLots: manual.tp_lots,
        virtualPendingsSnapshot: virtualPendings.length > 0 ? virtualPendings : null,
        nImmCwe,
        overrideTp,
        lastError: partialMsg,
      })
    } else {
      const { data: existingJob } = await ctx.supabase
        .from('basket_reconcile_jobs')
        .select('id')
        .eq('broker_account_id', broker.id)
        .eq('anchor_signal_id', anchorSignalId)
        .maybeSingle()
      if (existingJob?.id) {
        await markBasketReconcileDone(ctx.supabase, existingJob.id as string)
      }
    }

    console.log(
      `[tradeExecutor] merge_modify_summary signal=${signal.id} broker=${broker.id} anchor=${anchorSignalId}`
      + ` open=${summary.openLegs} attempted=${summary.attempted} modified=${summary.modified}`
      + ` failed=${summary.failed} no_ticket=${summary.skippedNoTicket}`,
    )

    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'merge_modify_summary',
        status: mergeFailed ? 'failed' : 'success',
        error_message: partialMsg,
        request_payload: {
          parent_signal_id: anchorSignalId,
        symbol,
          user_message: partialMsg,
          ...summary,
          virtual_pendings: virtualPendings.length,
          leg_errors: legErrors.slice(0, 10),
          ...(mergeLinkMeta ?? {}),
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: logAction,
        status: mergeFailed ? 'failed' : 'success',
        error_message: partialMsg,
        request_payload: {
          parent_signal_id: anchorSignalId,
          symbol,
          modify_only: true,
          user_message: partialMsg,
          ...summary,
          virtual_pendings: virtualPendings.length,
          leg_errors: legErrors.slice(0, 10),
          ...(mergeLinkMeta ?? {}),
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    if (!mergeFailed) {
      try {
        await ctx.supabase
          .from('signals')
          .update({ status: 'executed' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
    }

    return { success: !mergeFailed, summary }
  }
