"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.flattenChannelTradesForCopyLimit = flattenChannelTradesForCopyLimit;
const managementScope_1 = require("./managementScope");
const metatraderapi_1 = require("./metatraderapi");
const rangePendingLegDelete_1 = require("./rangePendingLegDelete");
const signalEntryPendingHelpers_1 = require("./signalEntryPendingHelpers");
async function closeBrokerTicket(api, uuid, ticket) {
    if (!Number.isFinite(ticket) || ticket <= 0)
        return false;
    try {
        const result = await api.orderClose(uuid, { ticket, slippage: 50 });
        if (result.state && /^(rejected|cancelled|expired)/i.test(result.state))
            return false;
        return true;
    }
    catch {
        return false;
    }
}
async function flattenChannelTradesForCopyLimit(args) {
    const result = {
        closed: 0,
        failed: 0,
        pendingCancelled: 0,
        virtualLegsDeleted: 0,
    };
    if (!(0, metatraderapi_1.hasMetatraderApiConfigured)())
        return result;
    const api = (0, metatraderapi_1.getMetatraderApi)((0, metatraderapi_1.mtPlatformFrom)(args.platform));
    if (!api || !args.metaapiAccountId || args.metaapiAccountId.includes('|'))
        return result;
    const trades = await (0, managementScope_1.loadOpenTradesForManagement)(args.supabase, {
        userId: args.userId,
        channelId: args.channelId,
        brokerAccountIds: [args.brokerAccountId],
    });
    const now = new Date().toISOString();
    const basketScopes = new Map();
    for (const trade of trades) {
        basketScopes.set(`${trade.signal_id}|${trade.broker_account_id}`, {
            signalId: trade.signal_id,
            brokerAccountId: trade.broker_account_id,
        });
        const ticket = Number(trade.metaapi_order_id);
        if (!Number.isFinite(ticket) || ticket <= 0)
            continue;
        const ok = await closeBrokerTicket(api, args.metaapiAccountId, ticket);
        if (!ok) {
            result.failed += 1;
            continue;
        }
        result.closed += 1;
        const terminalStatus = trade.status === 'pending' ? 'cancelled' : 'closed';
        await args.supabase
            .from('trades')
            .update({ status: terminalStatus, closed_at: now })
            .eq('id', trade.id)
            .in('status', ['open', 'pending']);
    }
    const { data: channelSignals } = await args.supabase
        .from('signals')
        .select('id')
        .eq('user_id', args.userId)
        .eq('channel_id', args.channelId)
        .limit(5000);
    const signalIds = (channelSignals ?? []).map((r) => r.id);
    if (signalIds.length) {
        const { data: seRows } = await args.supabase
            .from('signal_entry_pending_orders')
            .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy')
            .in('signal_id', signalIds)
            .eq('broker_account_id', args.brokerAccountId)
            .eq('status', 'broker_pending');
        for (const row of (seRows ?? [])) {
            const cancelled = await (0, signalEntryPendingHelpers_1.cancelSignalEntryRowAtBroker)(args.supabase, api, row, args.reason);
            if (cancelled.ok)
                result.pendingCancelled += 1;
        }
        const { data: virtualLegs } = await args.supabase
            .from('range_pending_legs')
            .select('signal_id,broker_account_id')
            .in('signal_id', signalIds)
            .eq('broker_account_id', args.brokerAccountId)
            .in('status', ['pending', 'claimed']);
        for (const leg of virtualLegs ?? []) {
            const signalId = String(leg.signal_id);
            basketScopes.set(`${signalId}|${args.brokerAccountId}`, {
                signalId,
                brokerAccountId: args.brokerAccountId,
            });
        }
    }
    for (const scope of basketScopes.values()) {
        result.virtualLegsDeleted += await (0, rangePendingLegDelete_1.deleteRangePendingLegsForBasket)(args.supabase, scope, args.reason);
    }
    console.log(`[copyLimitFlatten] broker=${args.brokerAccountId} channel=${args.channelId}`
        + ` closed=${result.closed} failed=${result.failed}`
        + ` pending_cancelled=${result.pendingCancelled} virtual_deleted=${result.virtualLegsDeleted}`
        + ` reason=${args.reason}`);
    return result;
}
