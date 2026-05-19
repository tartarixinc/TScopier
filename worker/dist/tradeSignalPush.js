"use strict";
/**
 * Listener → trade worker HTTP push (split deploy). Supabase Realtime remains fallback.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushParsedSignalToTradeWorker = pushParsedSignalToTradeWorker;
const tradeSignalActions_1 = require("./tradeSignalActions");
function tradePushEnabled() {
    const v = String(process.env.TRADE_SIGNAL_PUSH_ENABLED ?? 'true').toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no';
}
function internalToken() {
    return String(process.env.WORKER_INTERNAL_TOKEN ?? '').trim();
}
function pickTradeWorkerUrl(action) {
    const entryUrl = String(process.env.TRADE_WORKER_URL ?? '').trim().replace(/\/$/, '');
    const mgmtUrl = String(process.env.TRADE_MGMT_WORKER_URL ?? '').trim().replace(/\/$/, '');
    if ((0, tradeSignalActions_1.isManagementAction)(action)) {
        return mgmtUrl || entryUrl || null;
    }
    return entryUrl || null;
}
/**
 * Fire-and-forget POST to trade worker. Never throws; logs failures only.
 */
function pushParsedSignalToTradeWorker(row) {
    if (!tradePushEnabled())
        return;
    const token = internalToken();
    if (!token)
        return;
    const action = (0, tradeSignalActions_1.parsedAction)(row.parsed_data);
    const baseUrl = pickTradeWorkerUrl(action);
    if (!baseUrl)
        return;
    const timeoutMs = Math.max(500, Math.min(10000, Number(process.env.TRADE_SIGNAL_PUSH_TIMEOUT_MS ?? 4000)));
    const url = `${baseUrl}/internal/dispatch-signal`;
    const priority = (0, tradeSignalActions_1.dispatchPriorityForAction)(action);
    void (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('trade-push-timeout'), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-internal-token': token,
                },
                body: JSON.stringify({ signal: row, priority, source: 'listener_push' }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                console.warn(`[tradeSignalPush] push failed signal=${row.id} status=${res.status} url=${baseUrl} ${text.slice(0, 200)}`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[tradeSignalPush] push error signal=${row.id} url=${baseUrl}: ${msg}`);
        }
        finally {
            clearTimeout(timer);
        }
    })();
}
