"use strict";
/**
 * Apply channel management "modify" (Adjust SL/TP) across multi-leg baskets with
 * per-leg broker validation, clamping, and reconcile retries for missed legs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyMgmtModifyToBasketGroups = applyMgmtModifyToBasketGroups;
const fxsocketClient_1 = require("./fxsocketClient");
const basketSlTpReconcile_1 = require("./basketSlTpReconcile");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const channelMessageFilters_1 = require("./channelMessageFilters");
const helpers_1 = require("./tradeExecutor/helpers");
function sanitizeLevel(v) {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function mgmtRowToBasketLeg(row) {
    return {
        id: row.id,
        signal_id: row.signal_id,
        metaapi_order_id: row.metaapi_order_id,
        opened_at: row.opened_at ?? '',
        lot_size: row.lot_size,
        sl: row.sl,
        tp: row.tp,
        entry_price: row.entry_price,
        direction: row.direction,
        symbol: row.symbol,
    };
}
function inferBasketDirection(rows) {
    const sample = String(rows[0]?.direction ?? '').toLowerCase();
    return sample.includes('sell') ? 'sell' : 'buy';
}
function buildMgmtModifyTargets(args) {
    const { familyTrades, hasNewSl, newSl, hasNewTp, parsedTpLevels, multiBasket, tpLots, } = args;
    return familyTrades.map((tr, legIndex) => {
        const stoploss = hasNewSl ? newSl : sanitizeLevel(tr.sl);
        let takeprofit = sanitizeLevel(tr.tp);
        if (hasNewTp) {
            if (multiBasket) {
                const distributed = (0, tpBucketDistribution_1.takeProfitForLegIndex)({
                    legIndex,
                    openLegCount: familyTrades.length,
                    finalTps: parsedTpLevels,
                    tpLots,
                });
                if (distributed > 0)
                    takeprofit = distributed;
            }
            else {
                takeprofit = parsedTpLevels[0] ?? takeprofit;
            }
        }
        return { stoploss, takeprofit };
    });
}
async function applyMgmtModifyToBasketGroups(args) {
    const { supabase, apiFor, signal, parsed, rowsByBrokerSignal, brokersById, hasNewSl, hasNewTp, parsedTpLevels, liveMgmtFast, } = args;
    if (!hasNewSl && !hasNewTp)
        return;
    const newSl = hasNewSl ? parsed.sl : 0;
    for (const [basketKey, brokerRows] of rowsByBrokerSignal) {
        const broker = brokersById.get(basketKey.split('|')[0]);
        if (!broker)
            continue;
        const uuid = (0, helpers_1.brokerSessionUuid)(broker);
        if (!uuid || uuid.includes('|'))
            continue;
        if ((0, channelMessageFilters_1.isChannelManagementBlocked)((0, channelMessageFilters_1.normalizeChannelMessageFiltersMap)(broker.channel_message_filters), signal.channel_id, 'modify', { hasNewSl, hasNewTp })) {
            continue;
        }
        const api = apiFor(broker);
        if (!api)
            continue;
        const familyTrades = brokerRows
            .filter(r => {
            const ticket = Number(r.metaapi_order_id);
            return Number.isFinite(ticket) && ticket > 0;
        })
            .sort((a, b) => {
            const ta = a.opened_at ? new Date(a.opened_at).getTime() : 0;
            const tb = b.opened_at ? new Date(b.opened_at).getTime() : 0;
            return ta - tb;
        })
            .map(mgmtRowToBasketLeg);
        if (!familyTrades.length)
            continue;
        const anchorSignalId = familyTrades[0].signal_id;
        const symbol = familyTrades[0].symbol;
        const direction = inferBasketDirection(brokerRows);
        const manual = (broker.manual_settings ?? {});
        const multiBasket = manual.trade_style === 'multi'
            && familyTrades.length > 1
            && parsedTpLevels.length >= 2;
        let params = null;
        try {
            const sp = await api.symbolParams(uuid, symbol);
            const n = (0, fxsocketClient_1.normalizeSymbolParams)(sp);
            params = {
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
            // optional — runBasketLegModifies still attempts modify
        }
        let openedTickets = null;
        try {
            openedTickets = await (0, basketSlTpReconcile_1.fetchOpenBrokerTickets)(api, uuid);
        }
        catch {
            openedTickets = null;
        }
        const perLegTargets = buildMgmtModifyTargets({
            familyTrades,
            hasNewSl,
            newSl,
            hasNewTp,
            parsedTpLevels,
            multiBasket,
            tpLots: manual.tp_lots,
        });
        const nImmCwe = brokerRows.filter(r => r.cwe_close_price != null).length;
        const overrideTp = brokerRows.find(r => r.cwe_close_price != null)?.cwe_close_price ?? null;
        const modifiedTradeIds = new Set();
        let summary = {
            openLegs: familyTrades.length,
            attempted: 0,
            modified: 0,
            failed: 0,
            skippedNoTicket: 0,
            skippedNotOnBroker: 0,
        };
        let legErrors = [];
        const stragglerRounds = liveMgmtFast
            ? Math.min(4, Math.max(1, Number(process.env.BASKET_MGMT_STRAGGLER_ROUNDS ?? 3)))
            : Math.min(8, Math.max(2, Number(process.env.BASKET_MGMT_STRAGGLER_ROUNDS ?? 4)));
        for (let round = 0; round < stragglerRounds; round++) {
            if (round > 0) {
                const sleepMs = liveMgmtFast ? Math.min(round, 2) * 100 : Math.min(round, 3) * 200;
                await new Promise(resolve => setTimeout(resolve, sleepMs));
                if (round === 1) {
                    try {
                        openedTickets = await (0, basketSlTpReconcile_1.fetchOpenBrokerTickets)(api, uuid);
                    }
                    catch {
                        openedTickets = null;
                    }
                }
            }
            const pendingLegs = familyTrades.filter(tr => !modifiedTradeIds.has(tr.id));
            if (!pendingLegs.length)
                break;
            const pass = await (0, basketSlTpReconcile_1.runBasketLegModifies)({
                supabase,
                api,
                uuid,
                symbol,
                direction,
                baseLot: Number(broker.default_lot_size ?? 0.01),
                params,
                signalId: signal.id,
                userId: signal.user_id,
                brokerAccountId: broker.id,
                familyTrades,
                perLegTargets,
                signalTps: parsedTpLevels,
                tpLots: manual.tp_lots,
                nImmCwe,
                overrideTp: typeof overrideTp === 'number' ? overrideTp : null,
                strictEntryPrefetch: null,
                openedTickets,
                skipAlreadySynced: round > 0,
                alreadyModified: modifiedTradeIds,
                liveMgmtFast,
                orderCommentsEnabled: manual.order_comments_enabled !== false,
            });
            for (const id of pass.modifiedTradeIds)
                modifiedTradeIds.add(id);
            summary = pass.summary;
            legErrors = pass.legErrors;
            if (modifiedTradeIds.size >= familyTrades.length)
                break;
        }
        const mergeFailed = summary.modified < summary.openLegs;
        const partialMsg = mergeFailed
            ? `Mgmt modify: ${summary.modified}/${summary.openLegs} legs on broker=${broker.id} anchor=${anchorSignalId}`
                + (summary.failed > 0 ? `; ${summary.failed} broker errors` : '')
                + (summary.skippedNotOnBroker > 0 ? `; ${summary.skippedNotOnBroker} not on broker` : '')
            : null;
        if (mergeFailed) {
            console.warn(`[tradeExecutor] mgmt modify partial broker=${broker.id} anchor=${anchorSignalId}: ${partialMsg}`);
            await (0, basketSlTpReconcile_1.upsertBasketReconcileJob)(supabase, {
                userId: signal.user_id,
                brokerAccountId: broker.id,
                anchorSignalId,
                sourceSignalId: signal.id,
                channelId: signal.channel_id,
                symbol,
                direction,
                perLegTargets,
                familyTrades,
                signalTps: parsedTpLevels,
                tpLots: manual.tp_lots,
                virtualPendingsSnapshot: null,
                nImmCwe,
                overrideTp: typeof overrideTp === 'number' ? overrideTp : null,
                lastError: partialMsg,
            });
        }
        else {
            await (0, basketSlTpReconcile_1.markBasketReconcileDoneForAnchor)(supabase, broker.id, anchorSignalId);
        }
    }
}
