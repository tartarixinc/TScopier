"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalEntryPendingMonitor = void 0;
const metatraderapi_1 = require("./metatraderapi");
const signalEntryPendingHelpers_1 = require("./signalEntryPendingHelpers");
const TICK_MS = 2000;
const MISSING_BEFORE_ASSUME_GONE = 6;
function parsePartialTpPlan(raw) {
    if (!Array.isArray(raw))
        return null;
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object')
            continue;
        const o = item;
        const tpIdx = Number(o.tpIdx ?? o.tp_idx);
        const triggerPrice = Number(o.triggerPrice ?? o.trigger_price);
        const closeLots = Number(o.closeLots ?? o.close_lots);
        if (!Number.isFinite(tpIdx) || !Number.isFinite(triggerPrice) || !Number.isFinite(closeLots))
            continue;
        out.push({ tpIdx, triggerPrice, closeLots });
    }
    return out.length ? out : null;
}
function extractOpenPrice(raw) {
    const num = (v) => {
        if (typeof v === 'number' && Number.isFinite(v))
            return v;
        if (typeof v === 'string' && v.trim()) {
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
    };
    const px = num(raw.openPrice ?? raw.OpenPrice ?? raw.price ?? raw.Price ?? raw.priceOpen ?? raw.PriceOpen);
    return px != null && px > 0 ? px : null;
}
/**
 * Polls broker + DB for "Use Signal Entry Price" limit orders: applies requested
 * cancels (basket flat), detects fills / manual deletes, and updates `trades`.
 */
class SignalEntryPendingMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.timer = null;
        this.ticking = false;
        /** row id → consecutive ticks where ticket was absent from /OpenedOrders */
        this.missingStreak = new Map();
        this.api = (0, metatraderapi_1.getMetatraderApi)();
    }
    start() {
        if (this.timer)
            return;
        if (!this.api) {
            console.warn('[signalEntryPendingMonitor] METATRADERAPI_KEY missing — signal entry pending monitor disabled');
            return;
        }
        this.timer = setInterval(() => {
            if (this.ticking)
                return;
            this.ticking = true;
            this.tick()
                .catch(err => console.error('[signalEntryPendingMonitor] tick failed:', err))
                .finally(() => { this.ticking = false; });
        }, TICK_MS);
        this.timer.unref?.();
        console.log(`[signalEntryPendingMonitor] started interval=${TICK_MS}ms`);
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    async tick() {
        if (!this.api)
            return;
        const { data, error } = await this.supabase
            .from('signal_entry_pending_orders')
            .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy,entry_price,cancel_requested_at,partial_tp_plan')
            .eq('status', 'broker_pending')
            .limit(200);
        if (error) {
            console.error('[signalEntryPendingMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? []);
        if (!rows.length) {
            this.missingStreak.clear();
            return;
        }
        const cancelRows = rows.filter(r => r.cancel_requested_at);
        const watchRows = rows.filter(r => !r.cancel_requested_at);
        for (const row of cancelRows) {
            await (0, signalEntryPendingHelpers_1.cancelSignalEntryRowAtBroker)(this.supabase, this.api, row, 'cancel_requested');
        }
        const byAccount = new Map();
        for (const r of watchRows) {
            const k = r.metaapi_account_id;
            const list = byAccount.get(k) ?? [];
            list.push(r);
            byAccount.set(k, list);
        }
        for (const [uuid, group] of byAccount) {
            let opened = [];
            try {
                opened = await this.api.openedOrders(uuid);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[signalEntryPendingMonitor] /OpenedOrders failed account=${uuid}: ${msg}`);
                continue;
            }
            const needClosed = [];
            for (const row of group) {
                const ticket = Number(row.broker_ticket);
                if (!Number.isFinite(ticket) || ticket <= 0)
                    continue;
                const hit = (0, signalEntryPendingHelpers_1.findOpenedRowByTicket)(opened, ticket);
                if (hit) {
                    if ((0, signalEntryPendingHelpers_1.isPendingEntryRow)(hit)) {
                        this.missingStreak.delete(row.id);
                        continue;
                    }
                    const px = extractOpenPrice(hit);
                    if (px != null) {
                        this.missingStreak.delete(row.id);
                        await (0, signalEntryPendingHelpers_1.markSignalEntryFilled)(this.supabase, row, px, {
                            partialTpPlan: parsePartialTpPlan(row.partial_tp_plan),
                        });
                        continue;
                    }
                }
                needClosed.push(row);
            }
            let closed = [];
            if (needClosed.length) {
                try {
                    closed = await this.api.closedOrders(uuid);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[signalEntryPendingMonitor] /ClosedOrders failed account=${uuid}: ${msg}`);
                }
            }
            for (const row of needClosed) {
                const ticket = Number(row.broker_ticket);
                const c = (0, signalEntryPendingHelpers_1.findClosedRowForTicket)(closed, ticket);
                if (c) {
                    const st = (c.state ?? '').toLowerCase();
                    if (st.includes('cancel') || st.includes('reject')) {
                        this.missingStreak.delete(row.id);
                        await (0, signalEntryPendingHelpers_1.markSignalEntryGoneFromBroker)(this.supabase, row, `closed_state=${c.state ?? 'unknown'}`);
                        continue;
                    }
                    const px = c.openPrice;
                    if (px != null && px > 0) {
                        this.missingStreak.delete(row.id);
                        await (0, signalEntryPendingHelpers_1.markSignalEntryFilled)(this.supabase, row, px, {
                            partialTpPlan: parsePartialTpPlan(row.partial_tp_plan),
                        });
                        continue;
                    }
                }
                const streak = (this.missingStreak.get(row.id) ?? 0) + 1;
                this.missingStreak.set(row.id, streak);
                if (streak >= MISSING_BEFORE_ASSUME_GONE) {
                    this.missingStreak.delete(row.id);
                    await (0, signalEntryPendingHelpers_1.markSignalEntryGoneFromBroker)(this.supabase, row, 'pending_order_absent_from_opened_orders');
                }
            }
        }
        const active = new Set(watchRows.map(r => r.id));
        for (const k of this.missingStreak.keys()) {
            if (!active.has(k))
                this.missingStreak.delete(k);
        }
    }
}
exports.SignalEntryPendingMonitor = SignalEntryPendingMonitor;
