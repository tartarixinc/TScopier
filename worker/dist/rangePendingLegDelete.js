"use strict";
/**
 * Delete active `range_pending_legs` when a signal basket is flat.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteRangePendingLegsForBasket = deleteRangePendingLegsForBasket;
exports.purgeRangePendingLegsIfBasketFlat = purgeRangePendingLegsIfBasketFlat;
exports.purgeRangePendingLegsForBaskets = purgeRangePendingLegsForBaskets;
const rangePendingFireGuard_1 = require("./rangePendingFireGuard");
/** Delete all active virtual ladder rows for a basket (any symbol spelling). */
async function deleteRangePendingLegsForBasket(supabase, scope, reason) {
    const { data, error } = await supabase
        .from('range_pending_legs')
        .delete()
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
        .in('status', ['pending', 'claimed'])
        .select('id');
    if (error) {
        console.warn(`[rangePendingLegDelete] delete failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`);
        return 0;
    }
    const n = (data ?? []).length;
    if (n > 0) {
        console.log(`[rangePendingLegDelete] deleted ${n} range_pending_legs signal=${scope.signalId} broker=${scope.brokerAccountId} reason=${reason}`);
    }
    return n;
}
/** Delete pending/claimed legs when no open/pending trades remain in DB for the basket. */
async function purgeRangePendingLegsIfBasketFlat(supabase, scope, reason) {
    const { count, error } = await supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
        .in('status', ['open', 'pending']);
    if (error) {
        console.warn(`[rangePendingLegDelete] flat-check failed signal=${scope.signalId}: ${error.message}`);
        return 0;
    }
    if ((count ?? 0) > 0)
        return 0;
    const deleted = await deleteRangePendingLegsForBasket(supabase, scope, reason);
    if (deleted > 0) {
        await (0, rangePendingFireGuard_1.clearTpTouchedLock)(supabase, scope);
    }
    return deleted;
}
async function purgeRangePendingLegsForBaskets(supabase, scopes, reason) {
    const uniq = new Map();
    for (const s of scopes) {
        uniq.set(`${s.signalId}|${s.brokerAccountId}`, s);
    }
    let total = 0;
    for (const scope of uniq.values()) {
        total += await purgeRangePendingLegsIfBasketFlat(supabase, scope, reason);
    }
    return total;
}
