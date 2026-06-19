"use strict";
/**
 * Apply user signal SL/TP overrides to open broker legs for a signal basket.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySignalOverride = applySignalOverride;
const channelActiveTradeParams_1 = require("./channelActiveTradeParams");
const basketSlTpReconcile_1 = require("./basketSlTpReconcile");
const fxsocketClient_1 = require("./fxsocketClient");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const orderModifyBenign_1 = require("./orderModifyBenign");
const signalOverride_1 = require("./signalOverride");
const helpers_1 = require("./tradeExecutor/helpers");
function num(v) {
    if (v == null)
        return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}
async function applySignalOverride(supabase, args) {
    const dryRun = args.dryRun === true;
    const errors = [];
    let appliedLegs = 0;
    let skippedLegs = 0;
    let failedLegs = 0;
    const { data: signal, error: sigErr } = await supabase
        .from('signals')
        .select('id,user_id,channel_id,parsed_data,user_override')
        .eq('id', args.signalId)
        .eq('user_id', args.userId)
        .maybeSingle();
    if (sigErr || !signal) {
        throw sigErr ?? new Error(`signal not found: ${args.signalId}`);
    }
    const effective = (0, signalOverride_1.effectiveParsedFromSignalRow)(signal);
    const targetSl = num(effective.sl);
    const targetTps = (effective.tp ?? []).filter((t) => num(t) != null);
    if (targetSl == null && targetTps.length === 0) {
        return { applied_legs: 0, skipped_legs: 0, failed_legs: 0, errors: ['no_sl_or_tp_in_override'] };
    }
    const { data: trades, error: trErr } = await supabase
        .from('trades')
        .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,sl,tp,opened_at,entry_price')
        .eq('user_id', args.userId)
        .eq('signal_id', args.signalId)
        .eq('status', 'open')
        .not('metaapi_order_id', 'is', null)
        .order('opened_at', { ascending: true });
    if (trErr)
        throw trErr;
    const rows = (trades ?? []);
    if (!rows.length) {
        return { applied_legs: 0, skipped_legs: 0, failed_legs: 0 };
    }
    if (!dryRun && !(0, fxsocketClient_1.hasFxsocketConfigured)()) {
        throw new Error('FXSOCKET_API_KEY not set — cannot call broker');
    }
    const brokerIds = [...new Set(rows.map(r => r.broker_account_id))];
    const { data: brokers } = await supabase
        .from('broker_accounts')
        .select('id,label,platform,fxsocket_account_id,metaapi_account_id,manual_settings')
        .in('id', brokerIds);
    const brokerById = new Map((brokers ?? []).map(b => [b.id, b]));
    const api = (0, fxsocketClient_1.getFxsocketClient)();
    for (const brokerId of brokerIds) {
        const broker = brokerById.get(brokerId);
        const uuid = broker ? (0, helpers_1.brokerSessionUuid)(broker) : null;
        if (!broker || !uuid || !(0, helpers_1.brokerHasLinkedSession)(broker)) {
            skippedLegs += rows.filter(r => r.broker_account_id === brokerId).length;
            continue;
        }
        const client = api;
        if (!client && !dryRun) {
            errors.push(`broker ${brokerId}: fxsocket client unavailable`);
            skippedLegs += rows.filter(r => r.broker_account_id === brokerId).length;
            continue;
        }
        client?.seedPlatformCache(uuid, (0, fxsocketClient_1.mtPlatformFrom)(broker.platform));
        const legs = rows
            .filter(r => r.broker_account_id === brokerId)
            .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
        const isBuy = String(legs[0]?.direction ?? '').toLowerCase() === 'buy';
        const tpLots = broker.manual_settings?.tp_lots ?? null;
        const tpMap = targetTps.length > 0
            ? (0, tpBucketDistribution_1.buildEntryQualityTakeProfitMap)({
                legs: legs.map(tr => ({
                    id: tr.id,
                    entryPrice: Number(tr.entry_price ?? 0),
                    openedAt: tr.opened_at,
                })),
                isBuy,
                slotLegCount: legs.length,
                finalTps: targetTps,
                tpLots: tpLots ?? null,
            })
            : new Map();
        let quoteRef = null;
        let symbolParams = null;
        const quoteSymbol = legs[0]?.symbol?.trim();
        if (client && quoteSymbol && !dryRun) {
            try {
                const q = await client.quote(uuid, quoteSymbol);
                const marketRef = isBuy ? q.bid : q.ask;
                if (Number.isFinite(marketRef) && marketRef > 0)
                    quoteRef = marketRef;
            }
            catch {
                /* optional — fall back to entry for side checks */
            }
            try {
                const sp = await client.symbolParams(uuid, quoteSymbol);
                const n = (0, fxsocketClient_1.normalizeSymbolParams)(sp);
                symbolParams = {
                    digits: n.digits ?? 5,
                    point: n.point ?? 0.00001,
                    minLot: n.minLot ?? 0.01,
                    lotStep: n.lotStep ?? 0.01,
                    contractSize: n.contractSize ?? null,
                    stopsLevel: n.stopsLevel ?? 0,
                    freezeLevel: n.freezeLevel ?? 0,
                };
            }
            catch {
                /* optional — modify without broker min-distance clamp */
            }
        }
        for (let i = 0; i < legs.length; i++) {
            const tr = legs[i];
            const ticket = Number(tr.metaapi_order_id);
            if (!Number.isFinite(ticket) || ticket <= 0) {
                skippedLegs++;
                continue;
            }
            const keepTp = num(tr.tp);
            const keepSl = num(tr.sl);
            let targetTp = targetTps.length > 0 ? (tpMap.get(tr.id) ?? keepTp) : keepTp;
            let targetSlForLeg = targetSl ?? keepSl;
            const ref = (quoteRef != null && quoteRef > 0) ? quoteRef : num(tr.entry_price);
            if (ref != null && ref > 0 && (targetSlForLeg != null || targetTp != null)) {
                const stripped = (0, channelActiveTradeParams_1.stripInvalidStopsForSide)({
                    stoploss: targetSlForLeg ?? 0,
                    takeprofit: targetTp ?? 0,
                    referencePrice: ref,
                    isBuy,
                });
                if (targetSlForLeg != null) {
                    targetSlForLeg = stripped.stoploss > 0 ? stripped.stoploss : null;
                }
                if (targetTp != null) {
                    targetTp = stripped.takeprofit > 0 ? stripped.takeprofit : null;
                }
            }
            if (ref != null && ref > 0 && symbolParams && (targetSlForLeg != null || targetTp != null)) {
                const clamped = (0, basketSlTpReconcile_1.clampBasketOrderStops)({
                    symbol: quoteSymbol ?? tr.symbol,
                    operation: isBuy ? 'Buy' : 'Sell',
                    volume: 0.01,
                    price: ref,
                    stoploss: targetSlForLeg ?? 0,
                    takeprofit: targetTp ?? 0,
                }, symbolParams);
                if (targetSlForLeg != null && clamped.args.stoploss && clamped.args.stoploss > 0) {
                    targetSlForLeg = clamped.args.stoploss;
                }
                if (targetTp != null && clamped.args.takeprofit && clamped.args.takeprofit > 0) {
                    targetTp = clamped.args.takeprofit;
                }
            }
            if (targetSlForLeg == null && targetTp == null) {
                skippedLegs++;
                continue;
            }
            if (targetSlForLeg != null
                && targetTp != null
                && (0, orderModifyBenign_1.stopsAlreadyMatchDb)({ sl: tr.sl, tp: tr.tp }, { stoploss: targetSlForLeg, takeprofit: targetTp }, 0, 0)) {
                skippedLegs++;
                continue;
            }
            if (dryRun) {
                appliedLegs++;
                continue;
            }
            try {
                const modifyArgs = { ticket };
                if (targetSlForLeg != null && targetSlForLeg > 0)
                    modifyArgs.stoploss = targetSlForLeg;
                if (targetTp != null && targetTp > 0)
                    modifyArgs.takeprofit = targetTp;
                if (modifyArgs.stoploss == null && modifyArgs.takeprofit == null) {
                    skippedLegs++;
                    continue;
                }
                await client.orderModify(uuid, modifyArgs);
                const dbPatch = {};
                if (targetSlForLeg != null)
                    dbPatch.sl = targetSlForLeg;
                if (targetTp != null)
                    dbPatch.tp = targetTp;
                if (Object.keys(dbPatch).length > 0) {
                    await supabase.from('trades').update(dbPatch).eq('id', tr.id);
                }
                await supabase.from('trade_execution_logs').insert({
                    user_id: args.userId,
                    signal_id: args.signalId,
                    broker_account_id: brokerId,
                    action: 'user_signal_override',
                    status: 'success',
                    request_payload: {
                        ticket,
                        target_sl: modifyArgs.stoploss ?? null,
                        target_tp: modifyArgs.takeprofit ?? null,
                        trade_id: tr.id,
                        leg_index: i + 1,
                    },
                });
                appliedLegs++;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if ((0, orderModifyBenign_1.isBenignOrderModifyError)(msg)) {
                    skippedLegs++;
                    continue;
                }
                failedLegs++;
                errors.push(`leg ${tr.id}: ${msg}`);
                try {
                    await supabase.from('trade_execution_logs').insert({
                        user_id: args.userId,
                        signal_id: args.signalId,
                        broker_account_id: brokerId,
                        action: 'user_signal_override',
                        status: 'failed',
                        error_message: msg,
                        request_payload: {
                            ticket,
                            trade_id: tr.id,
                            leg_index: i + 1,
                        },
                    });
                }
                catch {
                    // best-effort log
                }
            }
        }
    }
    return {
        applied_legs: appliedLegs,
        skipped_legs: skippedLegs,
        failed_legs: failedLegs,
        errors: errors.length ? errors : undefined,
    };
}
