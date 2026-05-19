"use strict";
/**
 * Guards against duplicate virtual range leg fires (same step_idx re-opened after
 * `fired`, stale claim reclaim, or duplicate pending rows from re-planning).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rangeStepAlreadyFired = rangeStepAlreadyFired;
exports.cancelDuplicateActiveLeg = cancelDuplicateActiveLeg;
exports.loadExistingRangeStepIndices = loadExistingRangeStepIndices;
exports.loadBasketLegCap = loadBasketLegCap;
exports.countOpenTradesForBasket = countOpenTradesForBasket;
exports.shouldBlockVirtualLegFire = shouldBlockVirtualLegFire;
exports.reconcileStaleClaimedLegs = reconcileStaleClaimedLegs;
/** True when this ladder rung already fired (broker market order was sent). */
async function rangeStepAlreadyFired(supabase, scope) {
    const { count, error } = await supabase
        .from('range_pending_legs')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
        .eq('symbol', scope.symbol)
        .eq('step_idx', scope.stepIdx)
        .eq('status', 'fired');
    if (error) {
        console.warn(`[rangePendingFireGuard] consumed check failed signal=${scope.signalId} step=${scope.stepIdx}: ${error.message}`);
        return false;
    }
    return (count ?? 0) > 0;
}
/** Cancel a duplicate active row when the same rung is already consumed. */
async function cancelDuplicateActiveLeg(supabase, legId, scope, reason = 'duplicate_pending_step_already_consumed') {
    if (!await rangeStepAlreadyFired(supabase, scope))
        return false;
    const { data } = await supabase
        .from('range_pending_legs')
        .update({ status: 'cancelled', error_message: reason })
        .eq('id', legId)
        .in('status', ['pending', 'claimed'])
        .select('id')
        .maybeSingle();
    return !!data;
}
/** step_idx values that already have any row (including fired) for this basket. */
async function loadExistingRangeStepIndices(supabase, signalId, brokerAccountId, symbol) {
    const { data, error } = await supabase
        .from('range_pending_legs')
        .select('step_idx')
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .eq('symbol', symbol)
        .limit(500);
    if (error) {
        console.warn(`[rangePendingFireGuard] load steps failed signal=${signalId}: ${error.message}`);
        return new Set();
    }
    return new Set((data ?? []).map(r => Number(r.step_idx)));
}
/**
 * Planned basket size from execution logs: range virtual rows + immediate order_send count.
 */
async function loadBasketLegCap(supabase, signalId, brokerAccountId) {
    const { data: ins } = await supabase
        .from('trade_execution_logs')
        .select('request_payload')
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .eq('action', 'virtual_pending_inserted')
        .eq('status', 'success')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    const payload = ins?.request_payload;
    const rangeRows = Number(payload?.rows ?? 0);
    if (!Number.isFinite(rangeRows) || rangeRows <= 0)
        return null;
    const { count: immCount } = await supabase
        .from('trade_execution_logs')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .eq('action', 'order_send')
        .eq('status', 'success');
    const imm = immCount ?? 0;
    return Math.max(1, rangeRows + imm);
}
async function countOpenTradesForBasket(supabase, signalId, brokerAccountId) {
    const { count, error } = await supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .eq('status', 'open');
    if (error)
        return 0;
    return count ?? 0;
}
/** True if this leg should not fire (already consumed or basket at cap). */
async function shouldBlockVirtualLegFire(supabase, leg) {
    const scope = {
        signalId: leg.signal_id,
        brokerAccountId: leg.broker_account_id,
        symbol: leg.symbol,
        stepIdx: leg.step_idx,
    };
    if (await rangeStepAlreadyFired(supabase, scope)) {
        await cancelDuplicateActiveLeg(supabase, leg.id, scope);
        return { block: true, reason: 'step_already_fired' };
    }
    const cap = await loadBasketLegCap(supabase, leg.signal_id, leg.broker_account_id);
    if (cap != null) {
        const open = await countOpenTradesForBasket(supabase, leg.signal_id, leg.broker_account_id);
        if (open >= cap) {
            await cancelDuplicateActiveLeg(supabase, leg.id, scope, 'basket_leg_cap_reached');
            return { block: true, reason: 'basket_leg_cap_reached' };
        }
    }
    return { block: false };
}
/** Reconcile stale `claimed` rows — never blindly reset to `pending` if already fired. */
async function reconcileStaleClaimedLegs(supabase, staleBeforeIso) {
    const stats = { cancelled: 0, failed: 0, reset: 0 };
    const { data, error } = await supabase
        .from('range_pending_legs')
        .select('id,signal_id,broker_account_id,symbol,step_idx,ticket')
        .eq('status', 'claimed')
        .lt('claimed_at', staleBeforeIso)
        .limit(200);
    if (error || !data?.length)
        return stats;
    for (const row of data) {
        const scope = {
            signalId: row.signal_id,
            brokerAccountId: row.broker_account_id,
            symbol: row.symbol,
            stepIdx: row.step_idx,
        };
        if (await rangeStepAlreadyFired(supabase, scope)) {
            const { data: dropped } = await supabase
                .from('range_pending_legs')
                .update({ status: 'cancelled', error_message: 'stale_claim_duplicate_consumed_step' })
                .eq('id', row.id)
                .eq('status', 'claimed')
                .select('id')
                .maybeSingle();
            if (dropped)
                stats.cancelled += 1;
            continue;
        }
        const { count: firedLogCount } = await supabase
            .from('trade_execution_logs')
            .select('id', { count: 'exact', head: true })
            .eq('action', 'virtual_pending_fired')
            .eq('status', 'success')
            .contains('request_payload', { leg_id: row.id });
        if ((firedLogCount ?? 0) > 0) {
            await supabase
                .from('range_pending_legs')
                .update({
                status: 'fired',
                fired_at: new Date().toISOString(),
                ticket: row.ticket,
                claimed_at: null,
                claimed_by: null,
                error_message: null,
            })
                .eq('id', row.id)
                .eq('status', 'claimed');
            stats.cancelled += 1;
            continue;
        }
        const { data: reset } = await supabase
            .from('range_pending_legs')
            .update({ status: 'pending', claimed_at: null, claimed_by: null })
            .eq('id', row.id)
            .eq('status', 'claimed')
            .select('id')
            .maybeSingle();
        if (reset)
            stats.reset += 1;
        else
            stats.failed += 1;
    }
    return stats;
}
