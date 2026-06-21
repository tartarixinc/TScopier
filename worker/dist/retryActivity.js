"use strict";
/**
 * Re-run failed trade_execution_logs from the Activities page.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETRY_ELIGIBLE_LOG_ACTIONS = exports.ACTIVITY_RETRY_DISPATCH_SOURCE = void 0;
exports.retryTradeActivity = retryTradeActivity;
const signalRevision_1 = require("./signalRevision");
exports.ACTIVITY_RETRY_DISPATCH_SOURCE = 'activity_retry';
exports.RETRY_ELIGIBLE_LOG_ACTIONS = new Set([
    'mgmt_breakeven',
    'mgmt_close',
    'mgmt_close_worse_entries',
    'mgmt_modify',
    'mgmt_partial_breakeven',
    'mgmt_partial_profit',
    'merge_modify_summary',
    'merge_routed_modify_only',
    'cwe_close',
    'auto_be',
    'trailing_stop',
    'order_send',
    'virtual_pending_fired',
    'virtual_pending_inserted',
    'signal_entry_pending_filled',
    'opposite_signal_close',
    'partial_tp_fired',
    'basket_leg_modify',
]);
function isRetryEligibleLogAction(action) {
    return exports.RETRY_ELIGIBLE_LOG_ACTIONS.has(action.trim().toLowerCase());
}
async function resetSignalForRetry(supabase, args) {
    const { data, error } = await supabase
        .from('signals')
        .update({ status: 'parsed', skip_reason: null })
        .eq('id', args.signalId)
        .eq('user_id', args.userId)
        .in('status', ['executed', 'skipped', 'failed', 'pending'])
        .select('id');
    if (error) {
        console.warn(`[retryActivity] signal reset failed id=${args.signalId}: ${error.message}`);
        return false;
    }
    return (data?.length ?? 0) > 0;
}
function toDispatchRow(signal) {
    return {
        id: signal.id,
        user_id: signal.user_id,
        channel_id: signal.channel_id,
        parsed_data: signal.parsed_data,
        status: 'parsed',
        parent_signal_id: signal.parent_signal_id,
        is_modification: signal.is_modification,
        telegram_message_id: signal.telegram_message_id,
        reply_to_message_id: signal.reply_to_message_id,
        created_at: signal.created_at,
        user_override: signal.user_override,
    };
}
async function retryTradeActivity(executor, args) {
    const supabase = executor.supabase;
    const { data: log, error: logErr } = await supabase
        .from('trade_execution_logs')
        .select('id,user_id,signal_id,action,status')
        .eq('id', args.logId)
        .eq('user_id', args.userId)
        .maybeSingle();
    if (logErr) {
        return { ok: false, reason: logErr.message };
    }
    if (!log) {
        return { ok: false, reason: 'activity_not_found' };
    }
    if (String(log.status).toLowerCase() !== 'failed') {
        return { ok: false, reason: 'activity_not_failed' };
    }
    if (!isRetryEligibleLogAction(String(log.action ?? ''))) {
        return { ok: false, reason: 'not_retry_eligible' };
    }
    const signalId = log.signal_id?.trim();
    if (!signalId) {
        return { ok: false, reason: 'missing_signal_id' };
    }
    const existing = await (0, signalRevision_1.loadSignalById)(supabase, signalId);
    if (!existing || existing.user_id !== args.userId) {
        return { ok: false, reason: 'signal_not_found' };
    }
    if (existing.status !== 'parsed') {
        const reset = await resetSignalForRetry(supabase, { userId: args.userId, signalId });
        if (!reset && existing.status !== 'parsed') {
            return { ok: false, reason: 'signal_not_retryable' };
        }
    }
    const fresh = await (0, signalRevision_1.loadSignalById)(supabase, signalId);
    if (!fresh?.parsed_data?.action) {
        return { ok: false, reason: 'signal_not_found' };
    }
    const accepted = await executor.acceptDispatchSignalAwait(toDispatchRow(fresh), {
        source: exports.ACTIVITY_RETRY_DISPATCH_SOURCE,
        priority: 'high',
    });
    if (!accepted) {
        return { ok: false, accepted: false, reason: 'dispatch_not_accepted' };
    }
    return { ok: true, accepted: true };
}
