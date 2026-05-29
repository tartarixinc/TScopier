"use strict";
/**
 * Reconcile DB `trades.status = 'open'` against live broker positions.
 * Closes rows whose ticket no longer appears in /OpenedOrders (TP/SL/manual close).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findGhostOpenTradeIds = findGhostOpenTradeIds;
exports.reconcileOpenTradesForBroker = reconcileOpenTradesForBroker;
const basketSlTpReconcile_1 = require("./basketSlTpReconcile");
/** Open DB legs whose ticket is valid but absent from the broker snapshot. */
function findGhostOpenTradeIds(openTrades, brokerTickets) {
    const ghostIds = [];
    for (const trade of openTrades) {
        const ticket = Number(trade.metaapi_order_id);
        if (!Number.isFinite(ticket) || ticket <= 0)
            continue;
        if (!brokerTickets.has(ticket))
            ghostIds.push(trade.id);
    }
    return ghostIds;
}
async function reconcileOpenTradesForBroker(supabase, api, metaapiAccountId, openTrades) {
    if (!openTrades.length)
        return 0;
    const brokerTickets = await (0, basketSlTpReconcile_1.fetchOpenBrokerTicketsStrict)(api, metaapiAccountId);
    const ghostIds = findGhostOpenTradeIds(openTrades, brokerTickets);
    if (!ghostIds.length)
        return 0;
    return (0, basketSlTpReconcile_1.closeStaleOpenTrades)(supabase, ghostIds);
}
