"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeBasketForRevisionDirectionFlip = closeBasketForRevisionDirectionFlip;
exports.waitForSignalBasketFlat = waitForSignalBasketFlat;
const rangePendingLegDelete_1 = require("../rangePendingLegDelete");
const brokerChannelFilter_1 = require("../brokerChannelFilter");
const fxsocketClient_1 = require("../fxsocketClient");
const helpers_1 = require("./helpers");
async function closeWithVerification(api, uuid, ticket) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const slippage = 20 + (attempt - 1) * 50;
        const result = await api.orderClose(uuid, { ticket, slippage });
        if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) {
            if (attempt >= maxAttempts) {
                return { confirmed: false, reason: `orderClose state=${result.state}` };
            }
            await new Promise(r => setTimeout(r, 300));
            continue;
        }
        await new Promise(r => setTimeout(r, 400));
        try {
            const openOrders = await api.openedOrders(uuid);
            for (const raw of openOrders ?? []) {
                if (!raw || typeof raw !== 'object')
                    continue;
                const o = raw;
                const t = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0);
                if (t === ticket)
                    return { confirmed: false, reason: 'ticket_still_open' };
            }
        }
        catch {
            return { confirmed: true };
        }
        return { confirmed: true };
    }
    return { confirmed: false, reason: 'max_attempts' };
}
async function closeBasketForRevisionDirectionFlip(ctx, row, brokers) {
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return { closed: 0, failed: 0 };
    let closed = 0;
    let failed = 0;
    const purgeScopes = [];
    for (const broker of brokers) {
        if (!broker.is_active || !(0, helpers_1.brokerHasLinkedSession)(broker))
            continue;
        if (!(0, brokerChannelFilter_1.channelMatchesBrokerSignal)(broker, row.channel_id))
            continue;
        const uuid = (0, helpers_1.brokerSessionUuid)(broker);
        const api = ctx.apiFor(broker);
        if (!api)
            continue;
        const { data: openTrades, error } = await ctx.supabase
            .from('trades')
            .select('id,metaapi_order_id,symbol,signal_id')
            .eq('user_id', row.user_id)
            .eq('broker_account_id', broker.id)
            .eq('signal_id', row.id)
            .eq('status', 'open')
            .limit(500);
        if (error || !openTrades?.length)
            continue;
        for (const trade of openTrades) {
            const ticket = Number(trade.metaapi_order_id);
            if (!Number.isFinite(ticket) || ticket <= 0) {
                failed += 1;
                continue;
            }
            try {
                const result = await closeWithVerification(api, uuid, ticket);
                if (!result.confirmed) {
                    failed += 1;
                    await ctx.supabase.from('trade_execution_logs').insert({
                        user_id: row.user_id,
                        signal_id: row.id,
                        broker_account_id: broker.id,
                        action: 'message_revision_direction_flip_close',
                        status: 'failed',
                        request_payload: {
                            trade_id: trade.id,
                            ticket,
                            reason: result.reason ?? 'close_not_confirmed',
                            symbol: trade.symbol,
                        },
                    });
                    continue;
                }
                await ctx.supabase
                    .from('trades')
                    .update({ status: 'closed', closed_at: new Date().toISOString() })
                    .eq('id', trade.id);
                closed += 1;
                purgeScopes.push({ signalId: trade.signal_id, brokerAccountId: broker.id });
                await ctx.supabase.from('trade_execution_logs').insert({
                    user_id: row.user_id,
                    signal_id: row.id,
                    broker_account_id: broker.id,
                    action: 'message_revision_direction_flip_close',
                    status: 'success',
                    request_payload: {
                        trade_id: trade.id,
                        ticket,
                        symbol: trade.symbol,
                    },
                });
            }
            catch (err) {
                failed += 1;
                const msg = err instanceof Error ? err.message : String(err);
                await ctx.supabase.from('trade_execution_logs').insert({
                    user_id: row.user_id,
                    signal_id: row.id,
                    broker_account_id: broker.id,
                    action: 'message_revision_direction_flip_close',
                    status: 'failed',
                    request_payload: {
                        trade_id: trade.id,
                        ticket,
                        error: msg.slice(0, 300),
                        symbol: trade.symbol,
                    },
                });
            }
        }
    }
    if (purgeScopes.length) {
        const unique = new Map();
        for (const scope of purgeScopes) {
            unique.set(`${scope.signalId}:${scope.brokerAccountId}`, scope);
        }
        await (0, rangePendingLegDelete_1.purgeRangePendingLegsForBaskets)(ctx.supabase, [...unique.values()].map(s => ({
            signalId: s.signalId,
            brokerAccountId: s.brokerAccountId,
        })), 'message_revision_direction_flip');
    }
    return { closed, failed };
}
async function waitForSignalBasketFlat(ctx, row, brokers, deadlineMs = 3000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        let anyOpen = false;
        for (const broker of brokers) {
            if (!(0, brokerChannelFilter_1.channelMatchesBrokerSignal)(broker, row.channel_id))
                continue;
            const { count } = await ctx.supabase
                .from('trades')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', row.user_id)
                .eq('broker_account_id', broker.id)
                .eq('signal_id', row.id)
                .eq('status', 'open');
            if ((count ?? 0) > 0) {
                anyOpen = true;
                break;
            }
        }
        if (!anyOpen)
            return true;
        await new Promise(r => setTimeout(r, 150));
    }
    return false;
}
