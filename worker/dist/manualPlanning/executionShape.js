"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flipOperation = flipOperation;
exports.strictSignalEntryQuoteAllowsImmediate = strictSignalEntryQuoteAllowsImmediate;
exports.resolveOpExecAndStrict = resolveOpExecAndStrict;
const manualSettings_1 = require("./manualSettings");
function flipOperation(op) {
    switch (op) {
        case 'Buy': return 'Sell';
        case 'Sell': return 'Buy';
        case 'BuyLimit': return 'SellLimit';
        case 'SellLimit': return 'BuyLimit';
        case 'BuyStop': return 'SellStop';
        case 'SellStop': return 'BuyStop';
        case 'BuyStopLimit': return 'SellStopLimit';
        case 'SellStopLimit': return 'BuyStopLimit';
        default: return op;
    }
}
/**
 * True when the live quote is already at or better than the signal entry for immediate
 * execution (buy: ask ≤ entry; sell: bid ≥ entry). Used by the executor after a post-delay /Quote.
 */
function strictSignalEntryQuoteAllowsImmediate(args) {
    const { isBuy, entryPrice, bid, ask } = args;
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(bid) || !Number.isFinite(ask))
        return false;
    return isBuy ? ask <= entryPrice : bid >= entryPrice;
}
/**
 * Owns the decision table for `opSplit` → `opExec`, `orderPrice`, `strictEntry`, and pending `expiration`.
 */
function resolveOpExecAndStrict(args) {
    const { opSplit, isBuy, entryAnchor, manualStrict, isMulti, hasExplicitEntry, roundPrice, resolvedSymbol, commentPrefix, expertId, slippage, now, pendingExpiryRaw, } = args;
    let opExec = opSplit;
    if (manualStrict && hasExplicitEntry && entryAnchor != null) {
        opExec = isBuy ? 'Buy' : 'Sell';
    }
    else if (!isMulti
        && !manualStrict
        && (opSplit.includes('Limit') || opSplit.includes('Stop'))) {
        opExec = isBuy ? 'Buy' : 'Sell';
    }
    const isMarketExec = opExec === 'Buy' || opExec === 'Sell';
    const roundedEntry = entryAnchor != null && Number.isFinite(entryAnchor) && entryAnchor > 0
        ? roundPrice(entryAnchor)
        : 0;
    let orderPrice = 0;
    if (!isMarketExec) {
        orderPrice = roundedEntry;
    }
    else if (manualStrict && roundedEntry > 0) {
        orderPrice = roundedEntry;
    }
    const orderBase = {
        symbol: resolvedSymbol,
        operation: opExec,
        price: orderPrice,
        slippage: slippage ?? 20,
        comment: commentPrefix,
        expertID: expertId,
    };
    const expirationFields = {};
    if (opExec.includes('Limit') || opExec.includes('Stop')) {
        const hours = (0, manualSettings_1.clampPendingExpiryHours)(pendingExpiryRaw);
        if (hours > 0) {
            const exp = new Date(now.getTime() + hours * 60 * 60 * 1000);
            expirationFields.expiration = exp.toISOString();
            expirationFields.expirationType = 'Specified';
        }
    }
    const strictEntry = manualStrict && hasExplicitEntry && roundedEntry > 0
        ? { entryPrice: roundedEntry, isBuy }
        : undefined;
    return { opExec, orderPrice, roundedEntry, expirationFields, strictEntry, orderBase };
}
