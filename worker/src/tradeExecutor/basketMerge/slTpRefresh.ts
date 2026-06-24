import { symbolsCompatibleForBasket } from '../../basketModFollowUp'
import {
  closeStaleOpenTrades,
  fetchOpenBrokerTickets,
  GHOST_BASKET_CLOSED_USER_MESSAGE,
  markBasketReconcileDone,
  markBasketReconcileDoneForAnchor,
  runBasketLegModifies,
  upsertBasketReconcileJob,
  basketLegModifyMergeFailed,
  type BasketOpenLeg,
  type BasketSymbolParams
} from '../../basketSlTpReconcile'
import {
  applyChannelParamsToVirtualPendingList,
  channelParamsPredateBasket,
  estimateBasketTotalPlannedLegs,
  loadChannelActiveTradeParamsForSymbol,
  mergeParsedWithChannelParams,
  reapplyChannelParamsToPendingLegs,
  parsedSignalHasExplicitStops,
  shouldOverlayChannelParamsOnBasketRefresh,
  shouldPreferParsedStopsOnEntry,
  shouldPreferSignalStopsOverChannelMemory,
  upsertChannelActiveTradeParams,
  type ChannelActiveTradeParams
} from '../../channelActiveTradeParams'
import { mergeSignalUserOverride, parseUserOverride } from '../../signalOverride'
import {
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerPartialTp
} from '../../manualPlanner'
import { isMtBridgeGlitchMessage } from '../../brokerConnectError'
import { MtOperation } from '../../fxsocketClient'
import { buildPerLegStopTargets, mergePlanImmediateOrders, type MergeModifySummary } from '../../multiTradeMerge'
import {
  logEffectiveBasketStops,
  resolveEffectiveBasketStops,
} from '../../basketEffectiveStops'
import { buildRangeBasketTpTargets, toRangeBasketParsedSlice } from '../../rangeBasketTpSync'
import { isRangeLayerTillCloseEnabled } from '../../rangeLayerTillClose'
import {
  patchActiveRangePendingLegStops,
  resolveExistingRangeLadderAnchor,
  syncRangePendingLadderOnBasketRefresh,
} from '../../rangePendingLadderSync'
import { type TradeExecutorContext } from '../context'
import { roundLot, triggerPriceFor, virtualPendingTriggerAllowed } from '../helpers'
import {
  type BrokerRow,
  type ParsedSignal,
  type SignalRow,
  type SymbolCacheEntry
} from '../types'
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
    sameSignalRefresh?: boolean
    liveMgmtFast?: boolean
    mergeLinkMeta?: Record<string, unknown>
  }): Promise<{ success: boolean; summary: MergeModifySummary }> {
    const {
      signal, parsed, broker, channelKeywords, baseLot, params, symbol, uuid,
      strictEntryPrefetch, commentPrefix, anchorSignalId, direction, logAction, mergeLinkMeta,
      sameSignalRefresh, liveMgmtFast,
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
      entry_price: sameSignalRefresh ? null : rpe0,
      entry_zone_low: sameSignalRefresh ? null : (rzo0?.lo ?? parsed.entry_zone_low),
      entry_zone_high: sameSignalRefresh ? null : (rzo0?.hi ?? parsed.entry_zone_high),
      sl: parsed.sl,
      tp: parsed.tp,
      lot_size: parsed.lot_size,
      open_tp: parsed.open_tp,
      partial_close_fraction: parsed.partial_close_fraction,
      raw_instruction: parsed.raw_instruction,
    }
    let channelParamsForLadder: ChannelActiveTradeParams | null = null
    let anchorCreatedAt: string | null = null
    let anchorUserOverride = null as ReturnType<typeof parseUserOverride>
    if (anchorSignalId) {
      const { data: anchorRow } = await ctx.supabase
        .from('signals')
        .select('created_at,user_override')
        .eq('id', anchorSignalId)
        .maybeSingle()
      anchorCreatedAt = (anchorRow as { created_at?: string } | null)?.created_at ?? null
      anchorUserOverride = parseUserOverride(
        (anchorRow as { user_override?: unknown } | null)?.user_override,
      )
    }
    if (signal.channel_id) {
      channelParamsForLadder = await loadChannelActiveTradeParamsForSymbol(
        ctx.supabase,
        signal.user_id,
        signal.channel_id,
        symbol,
      )
      if (
        sameSignalRefresh
        && shouldPreferParsedStopsOnEntry(plannerParsed)
      ) {
        channelParamsForLadder = null
      }
      if (
        channelParamsForLadder
        && channelParamsPredateBasket(channelParamsForLadder, anchorCreatedAt)
      ) {
        console.log(
          `[tradeExecutor] skip stale channel memory on basket refresh signal=${signal.id}`
          + ` anchor=${anchorSignalId} memory_updated=${channelParamsForLadder.updatedAt}`,
        )
        channelParamsForLadder = null
      }
      if (
        channelParamsForLadder
        && shouldOverlayChannelParamsOnBasketRefresh(plannerParsed, logAction)
      ) {
        plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParamsForLadder, {
          overlay: true,
        })
      } else if (shouldPreferParsedStopsOnEntry(plannerParsed)) {
        const refreshTpLevels = (plannerParsed.tp ?? []).filter(
          (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
        )
        await upsertChannelActiveTradeParams(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          symbols: [symbol],
          stoploss: plannerParsed.sl,
          tpLevels: refreshTpLevels,
          replace: true,
        })
        channelParamsForLadder = await loadChannelActiveTradeParamsForSymbol(
          ctx.supabase,
          signal.user_id,
          signal.channel_id,
          symbol,
        )
      }
    }
    if (anchorUserOverride) {
      plannerParsed = mergeSignalUserOverride(plannerParsed, anchorUserOverride, { overlay: true })
    }
    let effectiveParsed: ParsedSignal = {
      ...parsed,
      sl: plannerParsed.sl,
      tp: plannerParsed.tp,
    }
    let effectiveSlIsExplicitMgmt = false
    if (manual.range_trading === true && anchorSignalId && signal.channel_id) {
      const resolvedStops = await resolveEffectiveBasketStops({
        supabase: ctx.supabase,
        userId: signal.user_id,
        channelId: signal.channel_id,
        anchorSignalId,
        symbol,
        basketCreatedAt: anchorCreatedAt,
        anchorParsed: toRangeBasketParsedSlice(effectiveParsed),
        familyTrades,
      })
      logEffectiveBasketStops('[tradeExecutor]', anchorSignalId, resolvedStops)
      if (resolvedStops.stoploss > 0) {
        effectiveParsed = { ...effectiveParsed, sl: resolvedStops.stoploss }
      }
      if (resolvedStops.tpLevels.length) {
        effectiveParsed = { ...effectiveParsed, tp: resolvedStops.tpLevels }
      }
      effectiveSlIsExplicitMgmt = resolvedStops.source === 'mgmt_signal'
    }
    if (!effectiveSlIsExplicitMgmt && logAction === 'merge_routed_modify_only') {
      const parsedSl = typeof effectiveParsed.sl === 'number' ? effectiveParsed.sl : 0
      if (parsedSl > 0) effectiveSlIsExplicitMgmt = true
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
      signal.channel_id
      && (typeof effectiveParsed.sl === 'number' && effectiveParsed.sl > 0 || refreshTpLevels.length > 0)
      && (
        logAction === 'merge_routed_modify_only'
        || shouldPreferParsedStopsOnEntry(plannerParsed)
        || shouldPreferSignalStopsOverChannelMemory(plannerParsed)
      )
    ) {
      await upsertChannelActiveTradeParams(ctx.supabase, {
        userId: signal.user_id,
        channelId: signal.channel_id,
        symbols: [symbol],
        stoploss: effectiveParsed.sl,
        tpLevels: refreshTpLevels,
        replace: shouldPreferParsedStopsOnEntry(plannerParsed)
          || shouldPreferSignalStopsOverChannelMemory(plannerParsed)
          || logAction === 'merge_routed_modify_only',
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
    const { data: rangePendingRows } = await ctx.supabase
      .from('range_pending_legs')
      .select('step_idx, status')
      .eq('signal_id', anchorSignalId)
      .eq('broker_account_id', broker.id)
      .limit(500)
    const activePendingCount = (rangePendingRows ?? []).filter(
      r => r.status === 'pending' || r.status === 'claimed',
    ).length
    const maxPendingStepIdx = Math.max(0, ...(rangePendingRows ?? []).map(r => Number(r.step_idx) || 0))
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
    // Modify-only refreshes (message edits on an existing basket) must spread TPs
    // across every open leg. Using the entry-plan instant/range split after extra
    // range legs have fired leaves trailing legs with takeprofit=0 and can crash
    // the MT bridge when OrderModify sends TP=0 on a ticket that already has TP.
    const refreshImmediateLegCount =
      sameSignalRefresh || logAction === 'merge_routed_modify_only'
        ? familyTrades.length
        : Math.max(
            mergePlanImmediateOrders(plan).length,
            Math.max(0, familyTrades.length - Math.max(0, maxPendingStepIdx - activePendingCount)),
          )
    // Single-mode partial schedule comes from planManualOrders (uses derived finalTps,
    // predefined TP pips, Targets %, single_tp_target — not raw parsed.tp alone).
    const singlePartialPartials: PlannerPartialTp[] =
      manual.trade_style !== 'multi' ? (plan.partialTps ?? []) : []
    const singleBrokerTpRaw = manual.trade_style !== 'multi' ? plan.orders[0]?.takeprofit : undefined
    const singleBrokerTp =
      typeof singleBrokerTpRaw === 'number' && Number.isFinite(singleBrokerTpRaw) && singleBrokerTpRaw > 0
        ? singleBrokerTpRaw
        : null
    let perLegTargets = manual.range_trading === true
      ? buildRangeBasketTpTargets({
          familyTrades,
          plan,
          parsed: effectiveParsed,
          tpLots: manual.tp_lots,
          direction: direction as 'buy' | 'sell',
          activePendingCount,
          maxPendingStepIdx,
          stoplossOverride: effectiveSlIsExplicitMgmt
            ? (typeof effectiveParsed.sl === 'number' && effectiveParsed.sl > 0 ? effectiveParsed.sl : null)
            : null,
          explicitSl: effectiveSlIsExplicitMgmt,
        })
      : buildPerLegStopTargets({
          plan,
          parsed: effectiveParsed,
          openLegCount: familyTrades.length,
          totalPlannedLegCount: basketTotalPlannedLegs,
          immediateLegCount: refreshImmediateLegCount,
          tpLots: manual.tp_lots,
        })
    if (manual.trade_style !== 'multi' && singleBrokerTp != null) {
      perLegTargets = perLegTargets.map(target => ({ ...target, takeprofit: singleBrokerTp }))
    }

    let anchor: number | null = plan.anchor?.value ?? null
    if (virtualPendings.length > 0 && (anchor == null || anchor <= 0)) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        anchor = plan.isBuy === false ? q.bid : q.ask
      } catch { /* drop virtuals below */ }
    }
    // An existing ladder keeps its original anchor. The re-planned anchor above can fall
    // back to the newest fill or the live quote, which — when the basket is in profit —
    // would re-anchor new rungs in the favorable direction and fire fresh layers on tiny
    // pullbacks. Layering must only average against the basket's original entry.
    let ladderAnchor: number | null = anchor
    if (virtualPendings.length > 0) {
      const existingLadderAnchor = await resolveExistingRangeLadderAnchor(ctx.supabase, {
        signalId: anchorSignalId,
        brokerAccountId: broker.id,
        symbol,
      })
      if (existingLadderAnchor != null) ladderAnchor = existingLadderAnchor
    }
    const nImmCwe = 0
    const overrideTp: number | null = null

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
    let summary: MergeModifySummary & { skippedNotOnBroker?: number; skippedUnfixable?: number } = {
      openLegs: familyTrades.length,
      attempted: 0,
      modified: 0,
      failed: 0,
      skippedNoTicket: 0,
      skippedNotOnBroker: 0,
      skippedUnfixable: 0,
    }
    const stragglerRounds = liveMgmtFast
      ? Math.min(4, Math.max(1, Number(process.env.BASKET_REFRESH_STRAGGLER_ROUNDS ?? 2)))
      : Math.min(
        12,
        Math.max(3, Number(process.env.BASKET_REFRESH_STRAGGLER_ROUNDS ?? 8)),
      )

    for (let round = 0; round < stragglerRounds; round++) {
      if (round > 0) {
        const roundSleepMs = liveMgmtFast
          ? Math.min(round, 2) * 100
          : Math.min(round, 4) * 200
        await new Promise(r => setTimeout(r, roundSleepMs))
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
        if (manual.trade_style !== 'multi' && singleBrokerTp != null) {
          for (let i = 0; i < refreshedTargets.length; i++) {
            refreshedTargets[i] = { ...refreshedTargets[i]!, takeprofit: singleBrokerTp }
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
        skipAlreadySynced: true,
        liveMgmtFast,
        orderCommentsEnabled: manual.order_comments_enabled !== false,
        explicitChannelTargets: effectiveSlIsExplicitMgmt,
      })
      for (const id of pass.modifiedTradeIds) modifiedTradeIds.add(id)
      summary = pass.summary
      legErrors = pass.legErrors.map(e => ({ error: e.error, leg_index: e.leg_index }))
      if (modifiedTradeIds.size >= familyTrades.length) break
      const pendingErrors = pass.legErrors.filter(e => e.error && !e.skip_reason)
      if (
        pendingErrors.length > 0
        && pendingErrors.every(e => isMtBridgeGlitchMessage(e.error))
        && modifiedTradeIds.size === 0
      ) {
        console.warn(
          `[tradeExecutor] basket refresh bridge glitch — deferring straggler rounds`
          + ` signal=${signal.id} broker=${broker.id} legs=${familyTrades.length}`,
        )
        break
      }
    }

    const stillMissingTicket = familyTrades.filter(tr => {
      const t = Number(tr.metaapi_order_id)
      return !Number.isFinite(t) || t <= 0
    }).length
    summary.skippedNoTicket = stillMissingTicket

    if (manual.trade_style !== 'multi' && modifiedTradeIds.size > 0) {
      for (const tradeId of modifiedTradeIds) {
        try {
          await ctx.supabase.from('partial_tp_legs').delete().eq('trade_id', tradeId)
        } catch { /* best-effort */ }
      }
      if (singlePartialPartials.length > 0) {
        const partialRows = [...modifiedTradeIds].flatMap(tradeId =>
          singlePartialPartials.map(p => ({
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
    }

    if (virtualPendings.length > 0 && ladderAnchor != null && Number.isFinite(ladderAnchor) && ladderAnchor > 0) {
      const insertAnchor = ladderAnchor
        const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
        const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0)
        const zoneHi = safe > 0 ? insertAnchor + (safe + 2) * (params?.point ?? 0) : null
        const zoneLo = safe > 0 ? insertAnchor - (safe + 2) * (params?.point ?? 0) : null
        const nowMs = Date.now()
      const plannedImmediateLegs = mergePlanImmediateOrders(plan).length
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
          const triggerPrice = triggerPriceFor(v, insertAnchor, digits)
          if (!virtualPendingTriggerAllowed({
            triggerPrice,
            signalRangeBoundary: plan.rangeLayering?.signalRangeBoundary ?? null,
            isBuy: v.isBuy,
            stopsZoneLo: zoneLo,
            stopsZoneHi: zoneHi,
            signalZoneLo: plan.rangeLayering?.signalZoneLo ?? null,
            signalZoneHi: plan.rangeLayering?.signalZoneHi ?? null,
            useSignalEntryRange: plan.rangeLayering?.useSignalEntryRange === true,
          })) {
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
            anchor_price: insertAnchor,
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
        layerTillClose: isRangeLayerTillCloseEnabled(manual),
      })
      if (ladderSync.skippedConsumed > 0 || ladderSync.skippedCap > 0) {
        console.log(
          `[tradeExecutor] basket_refresh ladder sync signal=${signal.id} anchor=${anchorSignalId}`
          + ` updated=${ladderSync.updated} inserted=${ladderSync.inserted}`
          + ` skip_consumed=${ladderSync.skippedConsumed} skip_cap=${ladderSync.skippedCap}`,
        )
      }
    }

    const refreshedSl = typeof effectiveParsed.sl === 'number' && effectiveParsed.sl > 0
      ? effectiveParsed.sl
      : null
    const shouldSyncPendingStops =
      refreshedSl != null
      || refreshTpLevels.length > 0
      || (channelParamsForLadder != null
        && (channelParamsForLadder.stoploss != null || channelParamsForLadder.tpLevels.length > 0))
    if (shouldSyncPendingStops) {
      if (signal.channel_id && !channelParamsForLadder) {
        channelParamsForLadder = await loadChannelActiveTradeParamsForSymbol(
          ctx.supabase,
          signal.user_id,
          signal.channel_id,
          symbol,
        )
      }
      let pendingPatched = 0
      const explicitPendingChannelParams: ChannelActiveTradeParams | null =
        refreshedSl != null || refreshTpLevels.length > 0
          ? {
              symbol,
              stoploss: refreshedSl ?? channelParamsForLadder?.stoploss ?? null,
              tpLevels: refreshTpLevels.length > 0
                ? refreshTpLevels
                : (channelParamsForLadder?.tpLevels ?? []),
            }
          : channelParamsForLadder
      if (refreshedSl != null || refreshTpLevels.length > 0) {
        pendingPatched = await patchActiveRangePendingLegStops({
          supabase: ctx.supabase,
          scope: { signalId: anchorSignalId, brokerAccountId: broker.id, symbol },
          stoploss: refreshedSl,
          channelParams: explicitPendingChannelParams,
          tpLots: manual.tp_lots,
          plannedRangeLegs: virtualPendings.length,
        })
      } else if (
        signal.channel_id
        && channelParamsForLadder
        && (channelParamsForLadder.stoploss != null || channelParamsForLadder.tpLevels.length > 0)
      ) {
        const openLegCountByBasket = new Map<string, number>()
        for (const tr of familyTrades) {
          const key = `${tr.signal_id}|${broker.id}`
          openLegCountByBasket.set(key, (openLegCountByBasket.get(key) ?? 0) + 1)
        }
        pendingPatched = await reapplyChannelParamsToPendingLegs({
          supabase: ctx.supabase,
          userId: signal.user_id,
          channelId: signal.channel_id,
          brokerAccountIds: [broker.id],
          symbolHint: symbol,
          signalIds: [anchorSignalId],
          tpLotsByBroker: new Map([[broker.id, manual.tp_lots]]),
          openLegCountByBasket,
          paramsOverride: channelParamsForLadder,
        })
      }
      if (pendingPatched > 0) {
        console.log(
          `[tradeExecutor] basket_refresh pending SL/TP sync signal=${signal.id} anchor=${anchorSignalId}`
          + ` broker=${broker.id} updated=${pendingPatched}`,
        )
      }
    }

    let mergeFailed = basketLegModifyMergeFailed(summary)
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

    const alreadySyncedNoBrokerWork =
      !mergeFailed
      && summary.openLegs > 0
      && summary.modified >= summary.openLegs
      && summary.attempted === 0

    console.log(
      `[tradeExecutor] merge_modify_summary signal=${signal.id} broker=${broker.id} anchor=${anchorSignalId}`
      + ` open=${summary.openLegs} attempted=${summary.attempted} modified=${summary.modified}`
      + ` failed=${summary.failed} no_ticket=${summary.skippedNoTicket}`
      + `${alreadySyncedNoBrokerWork ? ' already_synced' : ''}`,
    )

    if (!alreadySyncedNoBrokerWork) {
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
            modify_only: logAction === 'merge_routed_modify_only',
            user_message: partialMsg,
            ...summary,
            virtual_pendings: virtualPendings.length,
            leg_errors: legErrors.slice(0, 10),
            ...(mergeLinkMeta ?? {}),
          } as unknown as Record<string, unknown>,
        })
      } catch { /* best-effort */ }
    }

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
