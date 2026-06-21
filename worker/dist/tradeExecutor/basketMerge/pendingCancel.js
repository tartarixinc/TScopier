"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelSignalEntryBrokerRowsForScope = cancelSignalEntryBrokerRowsForScope;
exports.cancelRangePendingLegsForScopes = cancelRangePendingLegsForScopes;
const rangePendingLegDelete_1 = require("../../rangePendingLegDelete");
const signalEntryPendingHelpers_1 = require("../../signalEntryPendingHelpers");
async function cancelSignalEntryBrokerRowsForScope(ctx, scope, userId, logSignalId, reason) {
    const { data: seRows, error } = await ctx.supabase
        .from('signal_entry_pending_orders')
        .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy')
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
        .eq('status', 'broker_pending');
    if (error) {
        console.warn(`[tradeExecutor] signal_entry_pending_orders cancel select failed signal=${scope.signalId} broker=${scope.brokerAccountId}: ${error.message}`);
        return;
    }
    for (const r of (seRows ?? [])) {
        const api = ctx.apiForUuid(r.metaapi_account_id);
        if (api) {
            await (0, signalEntryPendingHelpers_1.cancelSignalEntryRowAtBroker)(ctx.supabase, api, r, reason);
        }
        else {
            await ctx.supabase
                .from('signal_entry_pending_orders')
                .update({
                cancel_requested_at: new Date().toISOString(),
                cancel_reason: reason,
                updated_at: new Date().toISOString(),
            })
                .eq('id', r.id)
                .eq('status', 'broker_pending');
        }
    }
}
async function cancelRangePendingLegsForScopes(ctx, userId, logSignalId, scopes, reason) {
    const uniq = new Map();
    for (const s of scopes) {
        uniq.set(`${s.signalId}|${s.brokerAccountId}`, s);
    }
    await Promise.allSettled([...uniq.values()].map(async (scope) => {
        try {
            const rowsCancelled = await (0, rangePendingLegDelete_1.deleteRangePendingLegsForBasket)(ctx.supabase, { signalId: scope.signalId, brokerAccountId: scope.brokerAccountId }, reason);
            if (rowsCancelled > 0) {
                try {
                    await ctx.supabase.from('trade_execution_logs').insert({
                        user_id: userId,
                        signal_id: logSignalId,
                        broker_account_id: scope.brokerAccountId,
                        action: 'virtual_pending_cancelled',
                        status: 'success',
                        request_payload: {
                            reason,
                            parent_signal_id: scope.signalId,
                            rows: rowsCancelled,
                        },
                    });
                }
                catch {
                    // Logging failure is non-fatal.
                }
            }
            await ctx.cancelSignalEntryBrokerRowsForScope(scope, userId, logSignalId, reason);
        }
        catch {
            // best-effort
        }
    }));
}
