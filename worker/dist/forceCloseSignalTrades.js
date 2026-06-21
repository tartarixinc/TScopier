"use strict";
/**
 * User-initiated force-close of signal-attributed open positions on a broker account.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.forceCloseSignalTrades = forceCloseSignalTrades;
const channelActiveTradeParams_1 = require("./channelActiveTradeParams");
const brokerChannelFilter_1 = require("./brokerChannelFilter");
const fxsocketClient_1 = require("./fxsocketClient");
const managementClose_1 = require("./managementClose");
const managementBrokerClose_1 = require("./managementBrokerClose");
const managementScope_1 = require("./managementScope");
const rangePendingLegDelete_1 = require("./rangePendingLegDelete");
const tradeComment_1 = require("./tradeComment");
const helpers_1 = require("./tradeExecutor/helpers");
function isBenignCloseError(message) {
    return /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(message);
}
async function loadChannelCommentSlug(supabase, channelId) {
    const { data } = await supabase
        .from('telegram_channels')
        .select('display_name, channel_username')
        .eq('id', channelId)
        .maybeSingle();
    const row = data;
    const label = (0, tradeComment_1.resolveChannelLabelForComment)(row?.display_name, row?.channel_username);
    return label ? (0, tradeComment_1.sanitizeChannelCommentSlug)(label) : null;
}
async function resolveLogSignalId(supabase, userId, channelId, trades) {
    const fromTrade = trades.find(t => t.signal_id)?.signal_id;
    if (fromTrade)
        return fromTrade;
    const { data } = await supabase
        .from('signals')
        .select('id')
        .eq('user_id', userId)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data?.id ?? null;
}
async function discoverAttributedChannelIds(supabase, userId, brokerAccountId, linkedChannelIds) {
    const linked = new Set(linkedChannelIds.map(id => id.trim().toLowerCase()).filter(Boolean));
    const found = new Set();
    const { data: openTrades } = await supabase
        .from('trades')
        .select('telegram_channel_id, signal_id')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId)
        .in('status', ['open', 'pending']);
    const signalIds = new Set();
    for (const row of (openTrades ?? [])) {
        const ch = String(row.telegram_channel_id ?? '').trim();
        if (ch && (linked.size === 0 || linked.has(ch.toLowerCase())))
            found.add(ch);
        const sigId = String(row.signal_id ?? '').trim();
        if (sigId)
            signalIds.add(sigId);
    }
    if (signalIds.size > 0) {
        const { data: signalRows } = await supabase
            .from('signals')
            .select('id, channel_id')
            .eq('user_id', userId)
            .in('id', [...signalIds]);
        for (const row of (signalRows ?? [])) {
            const ch = String(row.channel_id ?? '').trim();
            if (ch && (linked.size === 0 || linked.has(ch.toLowerCase())))
                found.add(ch);
        }
    }
    const { data: attribRows } = await supabase
        .from('trade_channel_attributions')
        .select('channel_id, trade_id')
        .eq('user_id', userId)
        .eq('broker_account_id', brokerAccountId);
    const attribTradeIds = (attribRows ?? []).map((r) => r.trade_id).filter(Boolean);
    if (attribTradeIds.length > 0) {
        const { data: attribTrades } = await supabase
            .from('trades')
            .select('id')
            .eq('user_id', userId)
            .in('id', attribTradeIds)
            .in('status', ['open', 'pending']);
        const openAttribIds = new Set((attribTrades ?? []).map((r) => r.id));
        for (const row of (attribRows ?? [])) {
            if (!row.trade_id || !openAttribIds.has(row.trade_id))
                continue;
            const ch = String(row.channel_id ?? '').trim();
            if (ch && (linked.size === 0 || linked.has(ch.toLowerCase())))
                found.add(ch);
        }
    }
    return [...found];
}
async function insertForceCloseLog(supabase, args) {
    if (!args.signalId)
        return;
    const status = args.failed > 0 && args.closed === 0 ? 'failed' : 'success';
    await supabase.from('trade_execution_logs').insert({
        user_id: args.userId,
        signal_id: args.signalId,
        broker_account_id: args.brokerAccountId,
        action: 'user_force_close',
        status,
        request_payload: {
            scope: args.scope,
            channel_id: args.channelId,
            closed: args.closed,
            failed: args.failed,
            pending_cancelled: args.pendingCancelled,
            virtual_legs_deleted: args.virtualLegsDeleted,
        },
        ...(status === 'failed' ? { error_message: 'force_close_failed' } : {}),
    });
}
async function forceCloseChannelOnBroker(supabase, args) {
    const { broker } = args;
    const result = {
        closed: 0,
        failed: 0,
        pending_cancelled: 0,
        virtual_legs_deleted: 0,
    };
    const api = (0, fxsocketClient_1.getFxsocketClient)();
    const uuid = (0, helpers_1.brokerSessionUuid)(broker);
    if (!api || !uuid || uuid.includes('|'))
        return result;
    const trades = await (0, managementScope_1.loadOpenTradesForManagement)(supabase, {
        userId: args.userId,
        channelId: args.channelId,
        brokerAccountIds: [broker.id],
    });
    const now = new Date().toISOString();
    const basketScopes = new Map();
    for (const trade of trades) {
        if (trade.signal_id) {
            basketScopes.set(`${trade.signal_id}|${trade.broker_account_id}`, {
                signalId: trade.signal_id,
                brokerAccountId: trade.broker_account_id,
            });
        }
        const ticket = Number(trade.metaapi_order_id);
        if (!Number.isFinite(ticket) || ticket <= 0)
            continue;
        try {
            const closeResult = await (0, managementClose_1.closeWithVerification)(api, uuid, ticket, { liveFast: true });
            if (!closeResult.confirmed) {
                result.failed += 1;
                continue;
            }
            result.closed += 1;
            const terminalStatus = trade.status === 'pending' ? 'cancelled' : 'closed';
            await supabase
                .from('trades')
                .update({ status: terminalStatus, closed_at: now })
                .eq('id', trade.id)
                .in('status', ['open', 'pending']);
            await (0, channelActiveTradeParams_1.clearChannelActiveTradeParamsWhenFlat)(supabase, {
                userId: args.userId,
                channelId: args.channelId,
                symbolHint: trade.symbol,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (isBenignCloseError(msg)) {
                result.closed += 1;
                const terminalStatus = trade.status === 'pending' ? 'cancelled' : 'closed';
                await supabase
                    .from('trades')
                    .update({ status: terminalStatus, closed_at: now })
                    .eq('id', trade.id)
                    .in('status', ['open', 'pending']);
                await (0, channelActiveTradeParams_1.clearChannelActiveTradeParamsWhenFlat)(supabase, {
                    userId: args.userId,
                    channelId: args.channelId,
                    symbolHint: trade.symbol,
                });
            }
            else {
                result.failed += 1;
            }
        }
    }
    result.pending_cancelled = await (0, managementBrokerClose_1.cancelChannelBrokerPendingOrders)({
        supabase,
        userId: args.userId,
        channelId: args.channelId,
        brokerAccountIds: [broker.id],
        apiFor: () => api,
        reason: 'user_force_close',
    });
    const { data: channelSignals } = await supabase
        .from('signals')
        .select('id')
        .eq('user_id', args.userId)
        .eq('channel_id', args.channelId)
        .limit(5000);
    const signalIds = (channelSignals ?? []).map((r) => r.id);
    if (signalIds.length) {
        const { data: virtualLegs } = await supabase
            .from('range_pending_legs')
            .select('signal_id,broker_account_id')
            .in('signal_id', signalIds)
            .eq('broker_account_id', broker.id)
            .in('status', ['pending', 'claimed']);
        for (const leg of virtualLegs ?? []) {
            const signalId = String(leg.signal_id);
            basketScopes.set(`${signalId}|${broker.id}`, {
                signalId,
                brokerAccountId: broker.id,
            });
        }
    }
    for (const scope of basketScopes.values()) {
        result.virtual_legs_deleted += await (0, rangePendingLegDelete_1.deleteRangePendingLegsForBasket)(supabase, scope, 'user_force_close');
    }
    const logSignalId = await resolveLogSignalId(supabase, args.userId, args.channelId, trades);
    const commentSlug = await loadChannelCommentSlug(supabase, args.channelId);
    if (logSignalId) {
        const fallback = await (0, managementBrokerClose_1.tryBrokerFallbackClose)({
            supabase,
            api,
            signal: {
                id: logSignalId,
                user_id: args.userId,
                channel_id: args.channelId,
            },
            parsed: { symbol: null },
            brokers: [broker],
            channelDisplayName: commentSlug,
            channelUsername: null,
            closeWithVerification: (a, u, ticket) => (0, managementClose_1.closeWithVerification)(a, u, ticket, { liveFast: true }),
        });
        result.closed += fallback.closed;
        result.failed += fallback.failed;
    }
    await insertForceCloseLog(supabase, {
        userId: args.userId,
        brokerAccountId: broker.id,
        signalId: logSignalId,
        scope: args.scope,
        channelId: args.channelId,
        closed: result.closed,
        failed: result.failed,
        pendingCancelled: result.pending_cancelled,
        virtualLegsDeleted: result.virtual_legs_deleted,
    });
    console.log(`[forceCloseSignalTrades] broker=${broker.id} channel=${args.channelId}`
        + ` closed=${result.closed} failed=${result.failed}`
        + ` pending_cancelled=${result.pending_cancelled} virtual_deleted=${result.virtual_legs_deleted}`);
    return result;
}
async function forceCloseSignalTrades(supabase, args) {
    const empty = {
        ok: false,
        closed: 0,
        failed: 0,
        pending_cancelled: 0,
        virtual_legs_deleted: 0,
        channels_processed: 0,
    };
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)()) {
        return { ...empty, reason: 'broker_api_not_configured' };
    }
    const brokerAccountId = args.brokerAccountId.trim();
    const userId = args.userId.trim();
    if (!brokerAccountId || !userId) {
        return { ...empty, reason: 'missing_ids' };
    }
    const { data: broker, error: brokerErr } = await supabase
        .from('broker_accounts')
        .select('id,user_id,platform,fxsocket_account_id,metaapi_account_id,signal_channel_ids')
        .eq('id', brokerAccountId)
        .eq('user_id', userId)
        .maybeSingle();
    if (brokerErr || !broker) {
        return { ...empty, reason: 'broker_not_found' };
    }
    if (!(0, helpers_1.brokerHasLinkedSession)(broker)) {
        return { ...empty, reason: 'broker_not_connected' };
    }
    const linkedChannelIds = (0, brokerChannelFilter_1.normalizeSignalChannelIds)(broker.signal_channel_ids);
    const requestedChannelId = args.channelId?.trim() || null;
    let channelIds;
    if (requestedChannelId) {
        if (linkedChannelIds.length > 0
            && !linkedChannelIds.some(id => id.toLowerCase() === requestedChannelId.toLowerCase())) {
            return { ...empty, reason: 'channel_not_linked' };
        }
        channelIds = [requestedChannelId];
    }
    else {
        channelIds = await discoverAttributedChannelIds(supabase, userId, brokerAccountId, linkedChannelIds);
    }
    if (channelIds.length === 0) {
        return { ...empty, ok: true, reason: 'no_open_channels' };
    }
    let closed = 0;
    let failed = 0;
    let pending_cancelled = 0;
    let virtual_legs_deleted = 0;
    for (const channelId of channelIds) {
        const one = await forceCloseChannelOnBroker(supabase, {
            userId,
            broker: broker,
            channelId,
            scope: requestedChannelId ? 'channel' : 'all',
        });
        closed += one.closed;
        failed += one.failed;
        pending_cancelled += one.pending_cancelled;
        virtual_legs_deleted += one.virtual_legs_deleted;
    }
    return {
        ok: failed === 0 || closed > 0,
        closed,
        failed,
        pending_cancelled,
        virtual_legs_deleted,
        channels_processed: channelIds.length,
        ...(failed > 0 && closed === 0 ? { reason: 'close_failed' } : {}),
    };
}
