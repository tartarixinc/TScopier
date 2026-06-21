"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchChannelRealizedPnl = fetchChannelRealizedPnl;
exports.fetchChannelFloatingPnl = fetchChannelFloatingPnl;
exports.buildChannelPnlSnapshot = buildChannelPnlSnapshot;
exports.resolveReferenceEquity = resolveReferenceEquity;
exports.fetchLiveAccountEquity = fetchLiveAccountEquity;
const copyLimitPeriods_1 = require("./copyLimitPeriods");
const fxsocketClient_1 = require("./fxsocketClient");
async function fetchChannelRealizedPnl(supabase, brokerAccountId, channelId, startIso, endIso) {
    const { data, error } = await supabase
        .from('trades')
        .select('profit')
        .eq('broker_account_id', brokerAccountId)
        .eq('telegram_channel_id', channelId)
        .eq('status', 'closed')
        .gte('closed_at', startIso)
        .lt('closed_at', endIso);
    if (error) {
        console.warn(`[copyLimitMetrics] realized pnl query failed: ${error.message}`);
        return 0;
    }
    let sum = 0;
    for (const row of data ?? []) {
        const p = Number(row.profit);
        if (Number.isFinite(p))
            sum += p;
    }
    return sum;
}
async function fetchChannelFloatingPnl(supabase, brokerAccountId, channelId, metaapiAccountId, platform) {
    const { data: openRows, error } = await supabase
        .from('trades')
        .select('metaapi_order_id,profit')
        .eq('broker_account_id', brokerAccountId)
        .eq('telegram_channel_id', channelId)
        .eq('status', 'open');
    if (error || !openRows?.length)
        return 0;
    const tickets = openRows
        .map(r => String(r.metaapi_order_id ?? '').trim())
        .filter(Boolean);
    if (!tickets.length)
        return 0;
    let sum = 0;
    const dbProfitByTicket = new Map();
    for (const row of openRows) {
        const ticket = String(row.metaapi_order_id ?? '').trim();
        const p = Number(row.profit);
        if (ticket && Number.isFinite(p))
            dbProfitByTicket.set(ticket, p);
    }
    if ((0, fxsocketClient_1.hasFxsocketConfigured)()) {
        try {
            const api = (0, fxsocketClient_1.getFxsocketClient)();
            if (api) {
                const orders = await api.openedOrders(metaapiAccountId);
                const ticketSet = new Set(tickets);
                for (const o of orders ?? []) {
                    const rec = o;
                    const ticket = String(rec.ticket ?? rec.Ticket ?? rec.order ?? rec.Order ?? '').trim();
                    if (!ticketSet.has(ticket))
                        continue;
                    const profit = Number(rec.profit ?? rec.Profit);
                    if (Number.isFinite(profit)) {
                        sum += profit;
                        continue;
                    }
                    const fromDb = dbProfitByTicket.get(ticket);
                    if (fromDb != null)
                        sum += fromDb;
                }
                return sum;
            }
        }
        catch (err) {
            console.warn('[copyLimitMetrics] openedOrders failed:', err instanceof Error ? err.message : String(err));
        }
    }
    for (const p of dbProfitByTicket.values())
        sum += p;
    return sum;
}
async function buildChannelPnlSnapshot(args) {
    const window = (0, copyLimitPeriods_1.periodWindowUtc)(args.period, args.timeZone, args.at);
    const realizedPnl = await fetchChannelRealizedPnl(args.supabase, args.brokerAccountId, args.channelId, window.startIso, window.endIso);
    const floatingPnl = await fetchChannelFloatingPnl(args.supabase, args.brokerAccountId, args.channelId, args.metaapiAccountId, args.platform);
    return {
        realizedPnl,
        floatingPnl,
        totalPnl: realizedPnl + floatingPnl,
    };
}
function resolveReferenceEquity(lastEquity, lastBalance) {
    const eq = Number(lastEquity);
    if (Number.isFinite(eq) && eq > 0)
        return eq;
    const bal = Number(lastBalance);
    if (Number.isFinite(bal) && bal > 0)
        return bal;
    return 0;
}
/**
 * Live broker account equity. Tries hard before falling back to the cached
 * broker row, because a stale equity here silently disables profit/risk
 * limits exactly when they matter (floating P/L running up):
 *   1. AccountSummary
 *   2. keepSessionAlive (token reconnect) + AccountSummary retry
 *   3. last_balance + live floating P/L from /OpenedOrders
 *   4. cached fallbackEquity
 */
async function fetchLiveAccountEquity(metaapiAccountId, platform, fallbackEquity, opts) {
    if (!metaapiAccountId || metaapiAccountId.includes('|'))
        return fallbackEquity;
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return fallbackEquity;
    const api = (0, fxsocketClient_1.getFxsocketClient)();
    if (!api)
        return fallbackEquity;
    const readEquity = async () => {
        const summary = await api.accountSummary(metaapiAccountId);
        const eq = Number(summary.equity);
        return Number.isFinite(eq) && eq > 0 ? eq : null;
    };
    try {
        const eq = await readEquity();
        if (eq != null)
            return eq;
    }
    catch (err) {
        console.warn('[copyLimitMetrics] accountSummary failed:', err instanceof Error ? err.message : String(err));
        try {
            const alive = await api.keepSessionAlive(metaapiAccountId);
            if (alive) {
                const eq = await readEquity();
                if (eq != null)
                    return eq;
            }
        }
        catch {
            /* fall through to balance + floating */
        }
    }
    const bal = Number(opts?.lastBalance);
    if (Number.isFinite(bal) && bal > 0) {
        try {
            const orders = await api.openedOrders(metaapiAccountId);
            let floating = 0;
            for (const o of orders ?? []) {
                const rec = o;
                const profit = Number(rec.profit ?? rec.Profit);
                if (Number.isFinite(profit))
                    floating += profit;
            }
            return bal + floating;
        }
        catch {
            /* fall through to cached */
        }
    }
    return fallbackEquity;
}
