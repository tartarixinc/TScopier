"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyBasketSlTpRefresh = applyBasketSlTpRefresh;
const basketModFollowUp_1 = require("../../basketModFollowUp");
const basketSlTpReconcile_1 = require("../../basketSlTpReconcile");
const channelActiveTradeParams_1 = require("../../channelActiveTradeParams");
const manualPlanner_1 = require("../../manualPlanner");
const brokerConnectError_1 = require("../../brokerConnectError");
const multiTradeMerge_1 = require("../../multiTradeMerge");
const rangeLayerTillClose_1 = require("../../rangeLayerTillClose");
const rangePendingLadderSync_1 = require("../../rangePendingLadderSync");
const helpers_1 = require("../helpers");
const helpers_2 = require("./helpers");
async function applyBasketSlTpRefresh(ctx, args) {
    const { signal, parsed, broker, channelKeywords, baseLot, params, symbol, uuid, strictEntryPrefetch, commentPrefix, anchorSignalId, direction, logAction, mergeLinkMeta, sameSignalRefresh, } = args;
    const api = ctx.apiFor(broker);
    if (!api) {
        return {
            success: false,
            summary: { openLegs: 0, attempted: 0, modified: 0, failed: 0, skippedNoTicket: 0 },
        };
    }
    const manual = (broker.manual_settings ?? {});
    const loadFamilyTrades = async () => {
        const { data: familyRows, error: famErr } = await ctx.supabase
            .from('trades')
            .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
            .eq('broker_account_id', broker.id)
            .eq('signal_id', anchorSignalId)
            .eq('status', 'open')
            .order('opened_at', { ascending: true })
            .limit(500);
        if (famErr) {
            console.warn(`[tradeExecutor] basket refresh load trades failed signal=${signal.id} anchor=${anchorSignalId}: ${famErr.message}`);
            return [];
        }
        const symHint = parsed.symbol ?? symbol;
        return (familyRows ?? []).filter(tr => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symHint, tr.symbol)
            || (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symbol, tr.symbol));
    };
    let familyTrades = await loadFamilyTrades();
    if (!familyTrades.length) {
        return {
            success: false,
            summary: { openLegs: 0, attempted: 0, modified: 0, failed: 0, skippedNoTicket: 0 },
        };
    }
    const newest = familyTrades[familyTrades.length - 1];
    const rpe0 = (0, manualPlanner_1.resolvedParsedEntryPrice)(parsed);
    const rzo0 = (0, manualPlanner_1.resolvedParsedEntryZone)(parsed);
    let plannerParsed = {
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
    };
    let channelParamsForLadder = null;
    let anchorCreatedAt = null;
    if (anchorSignalId) {
        const { data: anchorRow } = await ctx.supabase
            .from('signals')
            .select('created_at')
            .eq('id', anchorSignalId)
            .maybeSingle();
        anchorCreatedAt = anchorRow?.created_at ?? null;
    }
    if (signal.channel_id) {
        channelParamsForLadder = await (0, channelActiveTradeParams_1.loadChannelActiveTradeParamsForSymbol)(ctx.supabase, signal.user_id, signal.channel_id, symbol);
        if (sameSignalRefresh
            && (0, channelActiveTradeParams_1.shouldPreferParsedStopsOnEntry)(plannerParsed)) {
            channelParamsForLadder = null;
        }
        if (channelParamsForLadder
            && (0, channelActiveTradeParams_1.channelParamsPredateBasket)(channelParamsForLadder, anchorCreatedAt)) {
            console.log(`[tradeExecutor] skip stale channel memory on basket refresh signal=${signal.id}`
                + ` anchor=${anchorSignalId} memory_updated=${channelParamsForLadder.updatedAt}`);
            channelParamsForLadder = null;
        }
        if (channelParamsForLadder
            && (0, channelActiveTradeParams_1.shouldOverlayChannelParamsOnBasketRefresh)(plannerParsed, logAction)) {
            plannerParsed = (0, channelActiveTradeParams_1.mergeParsedWithChannelParams)(plannerParsed, channelParamsForLadder, {
                overlay: true,
            });
        }
        else if ((0, channelActiveTradeParams_1.shouldPreferParsedStopsOnEntry)(plannerParsed)) {
            const refreshTpLevels = (plannerParsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
            await (0, channelActiveTradeParams_1.upsertChannelActiveTradeParams)(ctx.supabase, {
                userId: signal.user_id,
                channelId: signal.channel_id,
                symbols: [symbol],
                stoploss: plannerParsed.sl,
                tpLevels: refreshTpLevels,
                replace: true,
            });
            channelParamsForLadder = await (0, channelActiveTradeParams_1.loadChannelActiveTradeParamsForSymbol)(ctx.supabase, signal.user_id, signal.channel_id, symbol);
        }
    }
    const effectiveParsed = {
        ...parsed,
        sl: plannerParsed.sl,
        tp: plannerParsed.tp,
    };
    if (!(0, manualPlanner_1.parsedHasExplicitEntryAnchor)(plannerParsed)) {
        const ep = Number(newest.entry_price);
        if (Number.isFinite(ep) && ep > 0)
            plannerParsed.entry_price = ep;
    }
    if (!(0, manualPlanner_1.parsedHasExplicitEntryAnchor)(plannerParsed)) {
        try {
            const q = strictEntryPrefetch ?? await api.quote(uuid, symbol);
            plannerParsed.entry_price = direction === 'buy' ? q.ask : q.bid;
        }
        catch {
            console.warn(`[tradeExecutor] basket refresh skipped: no entry anchor signal=${signal.id}`);
            return {
                success: false,
                summary: {
                    openLegs: familyTrades.length,
                    attempted: 0,
                    modified: 0,
                    failed: 0,
                    skippedNoTicket: familyTrades.length,
                },
            };
        }
    }
    const mergeBaseOp = direction === 'buy' ? 'Buy' : 'Sell';
    const plan = (0, manualPlanner_1.planManualOrders)({
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
    });
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
        };
    }
    const refreshTpLevels = (effectiveParsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
    if (signal.channel_id
        && (typeof effectiveParsed.sl === 'number' && effectiveParsed.sl > 0 || refreshTpLevels.length > 0)
        && (logAction === 'merge_routed_modify_only'
            || (0, channelActiveTradeParams_1.shouldPreferParsedStopsOnEntry)(plannerParsed)
            || (0, channelActiveTradeParams_1.shouldPreferSignalStopsOverChannelMemory)(plannerParsed))) {
        await (0, channelActiveTradeParams_1.upsertChannelActiveTradeParams)(ctx.supabase, {
            userId: signal.user_id,
            channelId: signal.channel_id,
            symbols: [symbol],
            stoploss: effectiveParsed.sl,
            tpLevels: refreshTpLevels,
            replace: (0, channelActiveTradeParams_1.shouldPreferParsedStopsOnEntry)(plannerParsed)
                || (0, channelActiveTradeParams_1.shouldPreferSignalStopsOverChannelMemory)(plannerParsed)
                || logAction === 'merge_routed_modify_only',
        });
        channelParamsForLadder = await (0, channelActiveTradeParams_1.loadChannelActiveTradeParamsForSymbol)(ctx.supabase, signal.user_id, signal.channel_id, symbol);
    }
    if (plan.delay_ms > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(plan.delay_ms, 30000)));
    }
    let virtualPendings = (plan.virtualPendings ?? []).slice(0, 500);
    const { data: activePendingRows } = await ctx.supabase
        .from('range_pending_legs')
        .select('step_idx')
        .eq('signal_id', anchorSignalId)
        .eq('broker_account_id', broker.id)
        .in('status', ['pending', 'claimed'])
        .limit(500);
    const activePendingCount = activePendingRows?.length ?? 0;
    const maxPendingStepIdx = Math.max(0, ...(activePendingRows ?? []).map(r => Number(r.step_idx) || 0));
    const basketTotalPlannedLegs = Math.max((0, channelActiveTradeParams_1.estimateBasketTotalPlannedLegs)({
        openLegCount: familyTrades.length,
        activePendingCount,
        maxPendingStepIdx,
    }), familyTrades.length + virtualPendings.length);
    if (signal.channel_id && virtualPendings.length > 0) {
        if (!channelParamsForLadder) {
            channelParamsForLadder = await (0, channelActiveTradeParams_1.loadChannelActiveTradeParamsForSymbol)(ctx.supabase, signal.user_id, signal.channel_id, symbol);
        }
        if (channelParamsForLadder) {
            const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount);
            const immediateEstimate = Math.max(0, familyTrades.length - firedPendingApprox);
            virtualPendings = (0, channelActiveTradeParams_1.applyChannelParamsToVirtualPendingList)(virtualPendings, channelParamsForLadder, immediateEstimate, manual.tp_lots, basketTotalPlannedLegs);
        }
    }
    // Modify-only refreshes (message edits on an existing basket) must spread TPs
    // across every open leg. Using the entry-plan instant/range split after extra
    // range legs have fired leaves trailing legs with takeprofit=0 and can crash
    // the MT bridge when OrderModify sends TP=0 on a ticket that already has TP.
    const refreshImmediateLegCount = sameSignalRefresh || logAction === 'merge_routed_modify_only'
        ? familyTrades.length
        : Math.max((0, multiTradeMerge_1.mergePlanImmediateOrders)(plan).length, Math.max(0, familyTrades.length - Math.max(0, maxPendingStepIdx - activePendingCount)));
    // Single-mode partial schedule comes from planManualOrders (uses derived finalTps,
    // predefined TP pips, Targets %, single_tp_target — not raw parsed.tp alone).
    const singlePartialPartials = manual.trade_style !== 'multi' ? (plan.partialTps ?? []) : [];
    const singleBrokerTpRaw = manual.trade_style !== 'multi' ? plan.orders[0]?.takeprofit : undefined;
    const singleBrokerTp = typeof singleBrokerTpRaw === 'number' && Number.isFinite(singleBrokerTpRaw) && singleBrokerTpRaw > 0
        ? singleBrokerTpRaw
        : null;
    let perLegTargets = (0, multiTradeMerge_1.buildPerLegStopTargets)({
        plan,
        parsed: effectiveParsed,
        openLegCount: familyTrades.length,
        totalPlannedLegCount: basketTotalPlannedLegs,
        immediateLegCount: refreshImmediateLegCount,
        tpLots: manual.tp_lots,
    });
    if (manual.trade_style !== 'multi' && singleBrokerTp != null) {
        perLegTargets = perLegTargets.map(target => ({ ...target, takeprofit: singleBrokerTp }));
    }
    let anchor = plan.anchor?.value ?? null;
    if ((virtualPendings.length > 0 || !!plan.closeWorseEntries) && (anchor == null || anchor <= 0)) {
        try {
            const q = strictEntryPrefetch ?? await api.quote(uuid, symbol);
            anchor = plan.isBuy === false ? q.bid : q.ask;
        }
        catch { /* drop virtuals below */ }
    }
    // An existing ladder keeps its original anchor. The re-planned anchor above can fall
    // back to the newest fill or the live quote, which — when the basket is in profit —
    // would re-anchor new rungs in the favorable direction and fire fresh layers on tiny
    // pullbacks. Layering must only average against the basket's original entry.
    let ladderAnchor = anchor;
    if (virtualPendings.length > 0) {
        const existingLadderAnchor = await (0, rangePendingLadderSync_1.resolveExistingRangeLadderAnchor)(ctx.supabase, {
            signalId: anchorSignalId,
            brokerAccountId: broker.id,
            symbol,
        });
        if (existingLadderAnchor != null)
            ladderAnchor = existingLadderAnchor;
    }
    const overrideTp = (0, helpers_1.computeCweTp)(plan, anchor, params);
    let nImmCwe = 0;
    if (overrideTp != null && plan.closeWorseEntries) {
        nImmCwe = Math.max(0, Math.min(perLegTargets.length, plan.closeWorseEntries.immediates));
        for (let i = 0; i < nImmCwe; i++) {
            if (perLegTargets[i])
                perLegTargets[i].takeprofit = 0;
        }
    }
    const basketParams = params
        ? {
            digits: params.digits,
            point: params.point,
            minLot: params.minLot,
            lotStep: params.lotStep,
            contractSize: params.contractSize,
            stopsLevel: params.stopsLevel,
            freezeLevel: params.freezeLevel,
        }
        : null;
    let openedTickets = null;
    try {
        openedTickets = await (0, basketSlTpReconcile_1.fetchOpenBrokerTickets)(api, uuid);
    }
    catch { /* preflight optional */ }
    const modifiedTradeIds = new Set();
    let legErrors = [];
    let summary = {
        openLegs: familyTrades.length,
        attempted: 0,
        modified: 0,
        failed: 0,
        skippedNoTicket: 0,
        skippedNotOnBroker: 0,
    };
    const stragglerRounds = Math.min(12, Math.max(3, Number(process.env.BASKET_REFRESH_STRAGGLER_ROUNDS ?? 8)));
    for (let round = 0; round < stragglerRounds; round++) {
        if (round > 0) {
            await new Promise(r => setTimeout(r, Math.min(round, 4) * 200));
            familyTrades = await loadFamilyTrades();
            summary.openLegs = familyTrades.length;
            const refreshedTargets = (0, multiTradeMerge_1.buildPerLegStopTargets)({
                plan,
                parsed: effectiveParsed,
                openLegCount: familyTrades.length,
                totalPlannedLegCount: basketTotalPlannedLegs,
                immediateLegCount: refreshImmediateLegCount,
                tpLots: manual.tp_lots,
            });
            if (manual.trade_style !== 'multi' && singleBrokerTp != null) {
                for (let i = 0; i < refreshedTargets.length; i++) {
                    refreshedTargets[i] = { ...refreshedTargets[i], takeprofit: singleBrokerTp };
                }
            }
            if (refreshedTargets.length) {
                perLegTargets.length = 0;
                perLegTargets.push(...refreshedTargets);
            }
            if (round === 1) {
                try {
                    openedTickets = await (0, basketSlTpReconcile_1.fetchOpenBrokerTickets)(api, uuid);
                }
                catch { /* optional */ }
            }
        }
        const pending = familyTrades.filter(tr => !modifiedTradeIds.has(tr.id));
        if (!pending.length)
            break;
        if (round > 0 && pending.every(tr => {
            const t = Number(tr.metaapi_order_id);
            return !Number.isFinite(t) || t <= 0;
        })) {
            break;
        }
        const pass = await (0, basketSlTpReconcile_1.runBasketLegModifies)({
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
            signalTps: (effectiveParsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0),
            tpLots: manual.tp_lots,
            nImmCwe,
            overrideTp,
            strictEntryPrefetch,
            openedTickets,
            alreadyModified: modifiedTradeIds,
            skipAlreadySynced: true,
        });
        for (const id of pass.modifiedTradeIds)
            modifiedTradeIds.add(id);
        summary = pass.summary;
        legErrors = pass.legErrors.map(e => ({ error: e.error, leg_index: e.leg_index }));
        if (modifiedTradeIds.size >= familyTrades.length)
            break;
        const pendingErrors = pass.legErrors.filter(e => e.error && !e.skip_reason);
        if (pendingErrors.length > 0
            && pendingErrors.every(e => (0, brokerConnectError_1.isMtBridgeGlitchMessage)(e.error))
            && modifiedTradeIds.size === 0) {
            console.warn(`[tradeExecutor] basket refresh bridge glitch — deferring straggler rounds`
                + ` signal=${signal.id} broker=${broker.id} legs=${familyTrades.length}`);
            break;
        }
    }
    const stillMissingTicket = familyTrades.filter(tr => {
        const t = Number(tr.metaapi_order_id);
        return !Number.isFinite(t) || t <= 0;
    }).length;
    summary.skippedNoTicket = stillMissingTicket;
    if (manual.trade_style !== 'multi' && modifiedTradeIds.size > 0) {
        for (const tradeId of modifiedTradeIds) {
            try {
                await ctx.supabase.from('partial_tp_legs').delete().eq('trade_id', tradeId);
            }
            catch { /* best-effort */ }
        }
        if (singlePartialPartials.length > 0) {
            const partialRows = [...modifiedTradeIds].flatMap(tradeId => singlePartialPartials.map(p => ({
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
            })));
            if (partialRows.length > 0) {
                const { error: partialErr } = await ctx.supabase
                    .from('partial_tp_legs')
                    .insert(partialRows);
                if (partialErr) {
                    console.warn(`[tradeExecutor] basket_refresh partial_tp_legs insert failed signal=${signal.id} broker=${broker.id}: ${partialErr.message}`);
                }
            }
        }
    }
    if (virtualPendings.length > 0 && ladderAnchor != null && Number.isFinite(ladderAnchor) && ladderAnchor > 0) {
        const insertAnchor = ladderAnchor;
        if (overrideTp != null && plan.closeWorseEntries) {
            const nVirt = virtualPendings.length;
            for (let i = 0; i < nVirt; i++) {
                virtualPendings[i] = {
                    ...virtualPendings[i],
                    takeprofit: null,
                    comment: `${virtualPendings[i].comment}.cw`,
                    cweClosePrice: overrideTp,
                };
            }
        }
        const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5));
        const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0);
        const zoneHi = safe > 0 ? insertAnchor + (safe + 2) * (params?.point ?? 0) : null;
        const zoneLo = safe > 0 ? insertAnchor - (safe + 2) * (params?.point ?? 0) : null;
        const nowMs = Date.now();
        const plannedImmediateLegs = Math.max((0, multiTradeMerge_1.mergePlanImmediateOrders)(plan).length, plan.closeWorseEntries?.immediates ?? 0);
        const ladderSync = await (0, rangePendingLadderSync_1.syncRangePendingLadderOnBasketRefresh)({
            supabase: ctx.supabase,
            scope: { signalId: anchorSignalId, brokerAccountId: broker.id, symbol },
            virtualPendings,
            openTradeCount: familyTrades.length,
            plannedImmediateLegs,
            plannedRangeLegs: virtualPendings.length,
            channelParams: channelParamsForLadder,
            tpLots: manual.tp_lots,
            buildInsertRow: (v) => {
                const triggerPrice = (0, helpers_1.triggerPriceFor)(v, insertAnchor, digits);
                if (zoneHi != null && zoneLo != null && triggerPrice > zoneLo && triggerPrice < zoneHi) {
                    return null;
                }
                const expiresAt = v.expiryHours && v.expiryHours > 0
                    ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
                    : null;
                return {
                    signal_id: anchorSignalId,
                    user_id: signal.user_id,
                    broker_account_id: broker.id,
                    metaapi_account_id: uuid,
                    symbol,
                    step_idx: v.stepIdx,
                    is_buy: v.isBuy,
                    volume: (0, helpers_1.roundLot)(v.volume, params),
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
                };
            },
            persistRows: (rows, persistCtx) => (0, helpers_2.persistRangePendingLegRows)(ctx, rows, persistCtx),
            context: `basket_refresh signal=${signal.id} anchor=${anchorSignalId}`,
            layerTillClose: (0, rangeLayerTillClose_1.isRangeLayerTillCloseEnabled)(manual),
        });
        if (ladderSync.skippedConsumed > 0 || ladderSync.skippedCap > 0) {
            console.log(`[tradeExecutor] basket_refresh ladder sync signal=${signal.id} anchor=${anchorSignalId}`
                + ` updated=${ladderSync.updated} inserted=${ladderSync.inserted}`
                + ` skip_consumed=${ladderSync.skippedConsumed} skip_cap=${ladderSync.skippedCap}`);
        }
    }
    const refreshedSl = typeof effectiveParsed.sl === 'number' && effectiveParsed.sl > 0
        ? effectiveParsed.sl
        : null;
    const shouldSyncPendingStops = refreshedSl != null
        || refreshTpLevels.length > 0
        || (channelParamsForLadder != null
            && (channelParamsForLadder.stoploss != null || channelParamsForLadder.tpLevels.length > 0));
    if (shouldSyncPendingStops) {
        if (signal.channel_id && !channelParamsForLadder) {
            channelParamsForLadder = await (0, channelActiveTradeParams_1.loadChannelActiveTradeParamsForSymbol)(ctx.supabase, signal.user_id, signal.channel_id, symbol);
        }
        let pendingPatched = 0;
        const explicitPendingChannelParams = refreshedSl != null || refreshTpLevels.length > 0
            ? {
                symbol,
                stoploss: refreshedSl ?? channelParamsForLadder?.stoploss ?? null,
                tpLevels: refreshTpLevels.length > 0
                    ? refreshTpLevels
                    : (channelParamsForLadder?.tpLevels ?? []),
            }
            : channelParamsForLadder;
        if (refreshedSl != null || refreshTpLevels.length > 0) {
            pendingPatched = await (0, rangePendingLadderSync_1.patchActiveRangePendingLegStops)({
                supabase: ctx.supabase,
                scope: { signalId: anchorSignalId, brokerAccountId: broker.id, symbol },
                stoploss: refreshedSl,
                channelParams: explicitPendingChannelParams,
                tpLots: manual.tp_lots,
                plannedRangeLegs: virtualPendings.length,
            });
        }
        else if (signal.channel_id
            && channelParamsForLadder
            && (channelParamsForLadder.stoploss != null || channelParamsForLadder.tpLevels.length > 0)) {
            const openLegCountByBasket = new Map();
            for (const tr of familyTrades) {
                const key = `${tr.signal_id}|${broker.id}`;
                openLegCountByBasket.set(key, (openLegCountByBasket.get(key) ?? 0) + 1);
            }
            pendingPatched = await (0, channelActiveTradeParams_1.reapplyChannelParamsToPendingLegs)({
                supabase: ctx.supabase,
                userId: signal.user_id,
                channelId: signal.channel_id,
                brokerAccountIds: [broker.id],
                symbolHint: symbol,
                signalIds: [anchorSignalId],
                tpLotsByBroker: new Map([[broker.id, manual.tp_lots]]),
                openLegCountByBasket,
                paramsOverride: channelParamsForLadder,
            });
        }
        if (pendingPatched > 0) {
            console.log(`[tradeExecutor] basket_refresh pending SL/TP sync signal=${signal.id} anchor=${anchorSignalId}`
                + ` broker=${broker.id} updated=${pendingPatched}`);
        }
    }
    let mergeFailed = summary.modified < summary.openLegs;
    const skippedBroker = summary.skippedNotOnBroker ?? 0;
    const allLegsGhostOnBroker = summary.openLegs > 0
        && skippedBroker >= summary.openLegs
        && summary.modified === 0
        && stillMissingTicket === 0;
    if (allLegsGhostOnBroker) {
        const closedCount = await (0, basketSlTpReconcile_1.closeStaleOpenTrades)(ctx.supabase, familyTrades.map(tr => tr.id));
        await (0, basketSlTpReconcile_1.markBasketReconcileDoneForAnchor)(ctx.supabase, broker.id, anchorSignalId);
        mergeFailed = true;
        console.log(`[tradeExecutor] ghost basket closed after modify signal=${signal.id} broker=${broker.id}`
            + ` anchor=${anchorSignalId} closed=${closedCount}`);
    }
    let partialMsg = mergeFailed
        ? `Not all trades were modified (${summary.modified}/${summary.openLegs} open legs`
            + `${stillMissingTicket > 0 ? `; ${stillMissingTicket} still waiting for broker ticket` : ''}`
            + `${skippedBroker > 0 ? `; ${skippedBroker} not on broker` : ''}`
            + `${summary.failed > 0 ? `; ${summary.failed} broker modify errors` : ''})`
        : null;
    if (allLegsGhostOnBroker) {
        partialMsg = basketSlTpReconcile_1.GHOST_BASKET_CLOSED_USER_MESSAGE;
    }
    if (mergeFailed && !allLegsGhostOnBroker) {
        await (0, basketSlTpReconcile_1.upsertBasketReconcileJob)(ctx.supabase, {
            userId: signal.user_id,
            brokerAccountId: broker.id,
            anchorSignalId,
            sourceSignalId: signal.id,
            channelId: signal.channel_id,
            symbol,
            direction,
            perLegTargets,
            familyTrades,
            signalTps: (effectiveParsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0),
            tpLots: manual.tp_lots,
            virtualPendingsSnapshot: virtualPendings.length > 0 ? virtualPendings : null,
            nImmCwe,
            overrideTp,
            lastError: partialMsg,
        });
    }
    else {
        const { data: existingJob } = await ctx.supabase
            .from('basket_reconcile_jobs')
            .select('id')
            .eq('broker_account_id', broker.id)
            .eq('anchor_signal_id', anchorSignalId)
            .maybeSingle();
        if (existingJob?.id) {
            await (0, basketSlTpReconcile_1.markBasketReconcileDone)(ctx.supabase, existingJob.id);
        }
    }
    const alreadySyncedNoBrokerWork = !mergeFailed
        && summary.openLegs > 0
        && summary.modified >= summary.openLegs
        && summary.attempted === 0;
    console.log(`[tradeExecutor] merge_modify_summary signal=${signal.id} broker=${broker.id} anchor=${anchorSignalId}`
        + ` open=${summary.openLegs} attempted=${summary.attempted} modified=${summary.modified}`
        + ` failed=${summary.failed} no_ticket=${summary.skippedNoTicket}`
        + `${alreadySyncedNoBrokerWork ? ' already_synced' : ''}`);
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
                },
            });
        }
        catch { /* best-effort */ }
    }
    if (!mergeFailed) {
        try {
            await ctx.supabase
                .from('signals')
                .update({ status: 'executed' })
                .eq('id', signal.id)
                .eq('status', 'parsed');
        }
        catch { /* best-effort */ }
    }
    return { success: !mergeFailed, summary };
}
