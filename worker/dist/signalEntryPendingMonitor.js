"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalEntryPendingMonitor = void 0;
const metatraderapi_1 = require("./metatraderapi");
const mtApiByAccount_1 = require("./mtApiByAccount");
const monitorIdleGate_1 = require("./monitorIdleGate");
const signalEntryPendingHelpers_1 = require("./signalEntryPendingHelpers");
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('SIGNAL_ENTRY_PENDING_TICK_MS', 2000);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('SIGNAL_ENTRY_PENDING_IDLE_MS', 60000);
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
        this.loop = null;
        this.platformByUuid = new Map();
        this.ticking = false;
        /** row id → consecutive ticks where ticket was absent from /OpenedOrders */
        this.missingStreak = new Map();
    }
    start() {
        if (this.loop)
            return;
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
            console.warn('[signalEntryPendingMonitor] MT4API_BASIC_USER/PASSWORD missing — signal entry pending monitor disabled');
            return;
        }
        this.loop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'signalEntryPendingMonitor',
            supabase: this.supabase,
            activeIntervalMs: ACTIVE_MS,
            idleIntervalMs: IDLE_MS,
            hasWork: sb => (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'signal_entry_pending_orders', q => q.eq('status', 'broker_pending')),
            tick: () => this.runTick(),
        });
        console.log(`[signalEntryPendingMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`);
    }
    stop() {
        this.loop?.stop();
        this.loop = null;
    }
    getLoopHandle() {
        return this.loop;
    }
    async runTick() {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            await this.tick();
        }
        finally {
            this.ticking = false;
        }
    }
    async tick() {
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)())
            return;
        const rowsQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('signal_entry_pending_orders')
            .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy,entry_price,cancel_requested_at,expires_at,partial_tp_plan')
            .eq('status', 'broker_pending')
            .limit(200));
        if (!rowsQ)
            return;
        const { data, error } = await rowsQ;
        if (error) {
            console.error('[signalEntryPendingMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? []);
        if (!rows.length) {
            this.missingStreak.clear();
            return;
        }
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByMetaapiId)(this.supabase, rows.map(r => r.metaapi_account_id));
        const nowMs = Date.now();
        const expiredIds = new Set();
        for (const r of rows) {
            if (!r.expires_at)
                continue;
            const t = Date.parse(r.expires_at);
            if (Number.isFinite(t) && t <= nowMs)
                expiredIds.add(r.id);
        }
        const cancelRows = rows.filter(r => !expiredIds.has(r.id) && r.cancel_requested_at);
        const watchRows = rows.filter(r => !expiredIds.has(r.id) && !r.cancel_requested_at);
        for (const row of rows) {
            if (!expiredIds.has(row.id))
                continue;
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, row.metaapi_account_id);
            if (api)
                await (0, signalEntryPendingHelpers_1.cancelSignalEntryRowAtBroker)(this.supabase, api, row, 'expired');
        }
        for (const row of cancelRows) {
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, row.metaapi_account_id);
            if (api)
                await (0, signalEntryPendingHelpers_1.cancelSignalEntryRowAtBroker)(this.supabase, api, row, 'cancel_requested');
        }
        const byAccount = new Map();
        for (const r of watchRows) {
            const k = r.metaapi_account_id;
            const list = byAccount.get(k) ?? [];
            list.push(r);
            byAccount.set(k, list);
        }
        for (const [uuid, group] of byAccount) {
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, uuid);
            if (!api)
                continue;
            let opened = [];
            try {
                opened = await api.openedOrders(uuid);
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
                    // Do not infer a fill from ambiguous rows (would mark trade open, insert
                    // partial_tp_legs, then partialTpMonitor can /OrderClose the pending ticket).
                    if (!(0, signalEntryPendingHelpers_1.isLikelyMarketPositionRow)(hit)) {
                        this.missingStreak.delete(row.id);
                        continue;
                    }
                    const px = extractOpenPrice(hit);
                    if (px != null) {
                        this.missingStreak.delete(row.id);
                        const posTicket = (0, signalEntryPendingHelpers_1.rawOrderTicket)(hit);
                        await (0, signalEntryPendingHelpers_1.markSignalEntryFilled)(this.supabase, row, px, {
                            partialTpPlan: parsePartialTpPlan(row.partial_tp_plan),
                            brokerPositionTicket: posTicket > 0 ? String(posTicket) : undefined,
                        });
                        continue;
                    }
                }
                needClosed.push(row);
            }
            let closed = [];
            if (needClosed.length) {
                try {
                    closed = await api.closedOrders(uuid);
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
                            brokerPositionTicket: c.brokerTicket != null && c.brokerTicket > 0 ? String(c.brokerTicket) : undefined,
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
