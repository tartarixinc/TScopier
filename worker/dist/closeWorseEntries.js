"use strict";
/**
 * Close-worse-entries helpers.
 *
 * Auto (cweCloseMonitor): legacy rows tagged with cwe_close_price at entry.
 *
 * Telegram (`close_worse_entries` management): close all open immediate legs;
 * range layering legs (fired from range_pending_legs) stay open.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEntryWithinPipsOfReference = isEntryWithinPipsOfReference;
exports.referencePriceForDirection = referencePriceForDirection;
exports.cweInstructionGroupKey = cweInstructionGroupKey;
exports.parseCweInstructionGroupKey = parseCweInstructionGroupKey;
exports.filterTradesWithinPipsOfReference = filterTradesWithinPipsOfReference;
exports.selectTradesForCweInstruction = selectTradesForCweInstruction;
exports.loadFiredRangeLayeringTickets = loadFiredRangeLayeringTickets;
exports.selectImmediateLegsForCweInstruction = selectImmediateLegsForCweInstruction;
exports.selectWorseImmediateLegsForCweInstruction = selectWorseImmediateLegsForCweInstruction;
const basketModFollowUp_1 = require("./basketModFollowUp");
function isEntryWithinPipsOfReference(entryPrice, referencePrice, pips, pipSize) {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0)
        return false;
    if (!Number.isFinite(referencePrice) || referencePrice <= 0)
        return false;
    if (!Number.isFinite(pips) || pips <= 0)
        return false;
    if (!Number.isFinite(pipSize) || pipSize <= 0)
        return false;
    const band = pips * pipSize;
    return Math.abs(referencePrice - entryPrice) <= band + 1e-12;
}
/** Quote side used to measure distance to entry (bid for longs, ask for shorts). */
function referencePriceForDirection(direction, bid, ask) {
    const isBuy = String(direction).toLowerCase() === 'buy';
    return isBuy ? bid : ask;
}
/** Stable group key for broker + symbol + direction (symbol may contain `|`). */
function cweInstructionGroupKey(trade) {
    return `${trade.broker_account_id}\x1f${trade.symbol}\x1f${String(trade.direction).toLowerCase()}`;
}
function parseCweInstructionGroupKey(key) {
    const parts = key.split('\x1f');
    if (parts.length !== 3)
        return null;
    const [brokerId, symbol, direction] = parts;
    if (!brokerId || !symbol || !direction)
        return null;
    return { brokerId, symbol, direction };
}
function filterTradesWithinPipsOfReference(args) {
    const { trades, referencePrice, pips, pipSize } = args;
    return trades.filter(t => {
        if (t.status !== 'open')
            return false;
        const entry = t.entry_price;
        if (entry == null || !Number.isFinite(entry) || entry <= 0)
            return false;
        return isEntryWithinPipsOfReference(entry, referencePrice, pips, pipSize);
    });
}
/** @deprecated Legacy auto-CWE selection; instruction path uses selectImmediateLegsForCweInstruction. */
function selectTradesForCweInstruction(args) {
    const { trades, referencePrice, pips, pipSize } = args;
    const byId = new Map();
    for (const t of filterTradesWithinPipsOfReference({ trades, referencePrice, pips, pipSize })) {
        byId.set(t.id, t);
    }
    for (const t of trades) {
        if (t.status !== 'open')
            continue;
        const thr = t.cwe_close_price;
        if (typeof thr === 'number' && Number.isFinite(thr) && thr > 0) {
            byId.set(t.id, t);
        }
    }
    return [...byId.values()];
}
async function loadFiredRangeLayeringTickets(supabase, args) {
    const signalIds = [...new Set(args.signalIds.map(id => id.trim()).filter(Boolean))];
    if (!signalIds.length)
        return new Set();
    const { data, error } = await supabase
        .from('range_pending_legs')
        .select('ticket, symbol')
        .in('signal_id', signalIds)
        .eq('broker_account_id', args.brokerAccountId)
        .eq('status', 'fired');
    if (error) {
        console.warn(`[closeWorseEntries] fired range pending lookup failed broker=${args.brokerAccountId} symbol=${args.symbol}: ${error.message}`);
        return new Set();
    }
    const tickets = new Set();
    for (const row of data ?? []) {
        const r = row;
        const rowSymbol = String(r.symbol ?? '').trim();
        if (rowSymbol && !(0, basketModFollowUp_1.symbolsCompatibleForBasket)(args.symbol, rowSymbol))
            continue;
        const ticket = String(r.ticket ?? '').trim();
        if (ticket)
            tickets.add(ticket);
    }
    return tickets;
}
/** Instruction CWE: all open immediates; exclude range layering legs that fired. */
function selectImmediateLegsForCweInstruction(trades, layeringTickets) {
    return trades.filter(t => {
        if (t.status !== 'open')
            return false;
        const ticket = String(t.metaapi_order_id ?? '').trim();
        if (!ticket)
            return false;
        return !layeringTickets.has(ticket);
    });
}
/**
 * Instruction CWE: immediate legs whose entry is within `pips` of the live quote
 * (worse/near-market fills). Range layering tickets stay open; better fills farther
 * from the quote are kept.
 */
function selectWorseImmediateLegsForCweInstruction(args) {
    const immediates = selectImmediateLegsForCweInstruction(args.trades, args.layeringTickets);
    return filterTradesWithinPipsOfReference({
        trades: immediates,
        referencePrice: args.referencePrice,
        pips: args.pips,
        pipSize: args.pipSize,
    });
}
