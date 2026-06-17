"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncMultiBasketLegTakeProfits = syncMultiBasketLegTakeProfits;
const rangeBasketTpSync_1 = require("../../rangeBasketTpSync");
const multiTradeMerge_1 = require("../../multiTradeMerge");
const basketSlTpReconcile_1 = require("../../basketSlTpReconcile");
async function syncMultiBasketLegTakeProfits(ctx, args) {
    const { signal, parsed, broker, plan, symbol, uuid, params, manual, direction } = args;
    const api = ctx.apiFor(broker);
    if (!api)
        return;
    await new Promise(r => setTimeout(r, 250));
    if (manual.range_trading === true) {
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
        await (0, rangeBasketTpSync_1.syncRangeBasketTakeProfits)({
            supabase: ctx.supabase,
            api,
            uuid,
            symbol,
            direction,
            baseLot: Number(broker.default_lot_size ?? 0.01),
            params: basketParams,
            signalId: signal.id,
            userId: signal.user_id,
            brokerAccountId: broker.id,
            manual,
            parsed: (0, rangeBasketTpSync_1.toRangeBasketParsedSlice)(parsed),
            plan,
        });
        return;
    }
    const { data: familyRows, error } = await ctx.supabase
        .from('trades')
        .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
        .eq('broker_account_id', broker.id)
        .eq('signal_id', signal.id)
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(500);
    if (error || !(familyRows ?? []).length)
        return;
    const familyTrades = (familyRows ?? []);
    const immediateLegCount = (0, multiTradeMerge_1.mergePlanImmediateOrders)(plan).length;
    const totalPlannedLegCount = immediateLegCount + (plan.virtualPendings?.length ?? 0);
    const perLegTargets = (0, multiTradeMerge_1.buildPerLegStopTargets)({
        plan,
        parsed,
        openLegCount: familyTrades.length,
        totalPlannedLegCount,
        immediateLegCount,
        tpLots: manual.tp_lots,
    });
    if (!perLegTargets.length)
        return;
    let openedTickets = null;
    try {
        openedTickets = await (0, basketSlTpReconcile_1.fetchOpenBrokerTickets)(api, uuid);
    }
    catch { /* optional */ }
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
    try {
        await (0, basketSlTpReconcile_1.runBasketLegModifies)({
            supabase: ctx.supabase,
            api,
            uuid,
            symbol,
            direction,
            baseLot: Number(broker.default_lot_size ?? 0.01),
            params: basketParams,
            signalId: signal.id,
            userId: signal.user_id,
            brokerAccountId: broker.id,
            familyTrades,
            perLegTargets,
            signalTps: (parsed.tp ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0),
            tpLots: manual.tp_lots,
            nImmCwe: 0,
            overrideTp: null,
            strictEntryPrefetch: null,
            openedTickets,
            skipAlreadySynced: true,
            orderCommentsEnabled: manual.order_comments_enabled !== false,
        });
    }
    catch (err) {
        console.warn(`[tradeExecutor] multi TP sync failed signal=${signal.id} broker=${broker.id}:`, err instanceof Error ? err.message : String(err));
    }
}
