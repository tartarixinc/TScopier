"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PartialTpMonitor = void 0;
exports.isPartialTpTriggered = isPartialTpTriggered;
const node_os_1 = __importDefault(require("node:os"));
const metatraderapi_1 = require("./metatraderapi");
const monitorIdleGate_1 = require("./monitorIdleGate");
const mtApiByAccount_1 = require("./mtApiByAccount");
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('PARTIAL_TP_TICK_MS', 1500);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('PARTIAL_TP_IDLE_MS', 60000);
const STALE_CLAIM_AFTER_MS = 30000;
/**
 * Pure trigger check. Same direction-aware comparison as virtualPendingMonitor's
 * `isTriggered`, just with the buy/sell sides inverted because here we're
 * watching for a profitable level (early TP) rather than an averaging-down
 * level (range pending).
 *
 *   buy  → close when bid  >= triggerPrice
 *   sell → close when ask  <= triggerPrice
 *
 * Returns false on NaN / non-positive inputs so a flaky /Quote can never
 * cause a spurious partial close.
 */
function isPartialTpTriggered(isBuy, triggerPrice, bid, ask) {
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0)
        return false;
    if (!Number.isFinite(bid) || !Number.isFinite(ask))
        return false;
    return isBuy ? bid >= triggerPrice : ask <= triggerPrice;
}
class PartialTpMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.loop = null;
        this.platformByUuid = new Map();
        this.ticking = false;
        this.firstTickLogged = false;
        /** Heartbeat counter so we log one summary line every ~30s when there's
         *  work waiting but no triggers crossing. */
        this.quietTicks = 0;
        this.hostId = `worker:${node_os_1.default.hostname()}:${process.pid}`;
    }
    start() {
        if (this.loop)
            return;
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
            console.warn('[partialTpMonitor] MT4API_BASIC_USER/PASSWORD missing — partial TP monitor disabled');
            return;
        }
        const staleCutoff = () => new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString();
        this.loop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'partialTpMonitor',
            supabase: this.supabase,
            activeIntervalMs: ACTIVE_MS,
            idleIntervalMs: IDLE_MS,
            hasWork: async (sb) => {
                const pending = await (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'partial_tp_legs', q => q.eq('status', 'pending'));
                if (pending)
                    return true;
                return (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'partial_tp_legs', q => q.eq('status', 'claimed').lt('claimed_at', staleCutoff()));
            },
            tick: () => this.runTick(),
        });
        console.log(`[partialTpMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`);
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
        // Re-claim stuck rows so a crashed worker can't strand a partial. Same
        // 30s threshold as virtualPendingMonitor.
        const staleCutoff = new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString();
        await this.supabase
            .from('partial_tp_legs')
            .update({ status: 'pending', claimed_at: null, claimed_by: null })
            .eq('status', 'claimed')
            .lt('claimed_at', staleCutoff);
        const legsQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('partial_tp_legs')
            .select('id,trade_id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,is_buy,tp_idx,trigger_price,close_lots,status')
            .eq('status', 'pending')
            .limit(500));
        if (!legsQ)
            return;
        const { data, error } = await legsQ;
        if (error) {
            console.error('[partialTpMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? []);
        if (!this.firstTickLogged) {
            this.firstTickLogged = true;
            console.log(`[partialTpMonitor] first tick ok pending_rows=${rows.length}`);
        }
        if (!rows.length) {
            this.quietTicks = 0;
            return;
        }
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByMetaapiId)(this.supabase, rows.map(r => r.metaapi_account_id));
        // Group by (metaapi_account_id, symbol) → at most ONE /Quote per group
        // per tick. Same shape as the other monitors for consistency.
        const groups = new Map();
        for (const r of rows) {
            const key = `${r.metaapi_account_id}|${r.symbol}`;
            const list = groups.get(key) ?? [];
            list.push(r);
            groups.set(key, list);
        }
        let triggeredTotal = 0;
        let firedOkTotal = 0;
        let firedErrTotal = 0;
        const distances = [];
        await Promise.all(Array.from(groups.entries()).map(async ([key, partials]) => {
            const [uuid, symbol] = key.split('|');
            if (!uuid || !symbol)
                return;
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, uuid);
            if (!api)
                return;
            let q;
            try {
                q = await api.quote(uuid, symbol);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[partialTpMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`);
                return;
            }
            let nearestGap = Number.POSITIVE_INFINITY;
            for (const partial of partials) {
                const ref = partial.is_buy ? q.bid : q.ask;
                // For buys: positive gap = bid still BELOW trigger (waiting for rise).
                // For sells: positive gap = ask still ABOVE trigger (waiting for fall).
                const gap = partial.is_buy ? partial.trigger_price - ref : ref - partial.trigger_price;
                if (Number.isFinite(gap) && gap < nearestGap)
                    nearestGap = gap;
                if (!isPartialTpTriggered(partial.is_buy, partial.trigger_price, q.bid, q.ask))
                    continue;
                triggeredTotal += 1;
                const ok = await this.firePartial(partial, api, q.bid, q.ask);
                if (ok)
                    firedOkTotal += 1;
                else
                    firedErrTotal += 1;
            }
            distances.push({ symbol, bid: q.bid, ask: q.ask, gap: nearestGap, legs: partials.length });
        }));
        if (triggeredTotal > 0) {
            console.log(`[partialTpMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} fired=${firedOkTotal}_ok ${firedErrTotal}_err`);
            this.quietTicks = 0;
        }
        else {
            this.quietTicks += 1;
            if (this.quietTicks % 20 === 1) {
                const summary = distances
                    .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gap) ? d.gap.toFixed(5) : 'n/a'} (${d.legs} legs)`)
                    .join('; ');
                console.log(`[partialTpMonitor] heartbeat rows=${rows.length} groups=${groups.size} no triggers crossed yet — ${summary}`);
            }
        }
    }
    /**
     * Close one partial slice. Returns true on success (or when the broker
     * reports the trade is already gone — same outcome). Failures roll the
     * row back to 'pending' so the next tick can retry.
     *
     * Order of operations (CAS-first so duplicate workers can't both fire):
     *   1. CAS UPDATE status: 'pending' → 'claimed'. Lose ⇒ bail.
     *   2. Look up the parent trade's ticket. If the parent is closed
     *      already (SL hit, manual close, etc.), skip the partial and mark
     *      it 'cancelled'.
     *   3. /OrderClose with `lots = close_lots`.
     *   4. UPDATE status: 'claimed' → 'fired' (or 'failed' on error).
     */
    async firePartial(partial, api, bid, ask) {
        // CAS claim.
        const { data: claimed, error: claimErr } = await this.supabase
            .from('partial_tp_legs')
            .update({ status: 'claimed', claimed_at: new Date().toISOString(), claimed_by: this.hostId })
            .eq('id', partial.id)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle();
        if (claimErr) {
            console.warn(`[partialTpMonitor] CAS claim error partial=${partial.id}: ${claimErr.message}`);
            return false;
        }
        if (!claimed)
            return false; // another worker won the race
        // Parent trade lookup — if it's already closed we cancel this partial
        // (no position to slice) so the row doesn't keep retrying forever.
        const { data: parent } = await this.supabase
            .from('trades')
            .select('id,metaapi_order_id,status')
            .eq('id', partial.trade_id)
            .maybeSingle();
        const parentRow = (parent ?? null);
        if (!parentRow || parentRow.status !== 'open') {
            await this.supabase
                .from('partial_tp_legs')
                .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: 'parent trade not open' })
                .eq('id', partial.id);
            return false;
        }
        const ticketNum = Number(parentRow.metaapi_order_id);
        if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
            await this.supabase
                .from('partial_tp_legs')
                .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: 'parent ticket missing' })
                .eq('id', partial.id);
            return false;
        }
        const t0 = Date.now();
        const refPrice = partial.is_buy ? bid : ask;
        try {
            const result = await api.orderClose(partial.metaapi_account_id, {
                ticket: ticketNum,
                lots: partial.close_lots,
                // price=0 lets the broker fill at market (same as a manual partial
                // close from the terminal). refPrice is reported in logs only.
            });
            const latencyMs = Date.now() - t0;
            console.log(`[partialTpMonitor] partial fired signal=${partial.signal_id} symbol=${partial.symbol} ticket=${ticketNum}`
                + ` TP${partial.tp_idx}@${partial.trigger_price} ref=${refPrice} close=${partial.close_lots} latency=${latencyMs}ms`);
            await this.supabase
                .from('partial_tp_legs')
                .update({ status: 'fired', fired_at: new Date().toISOString() })
                .eq('id', partial.id);
            await this.supabase.from('trade_execution_logs').insert({
                user_id: partial.user_id,
                signal_id: partial.signal_id,
                broker_account_id: partial.broker_account_id,
                action: 'partial_tp_fired',
                status: 'success',
                request_payload: {
                    partial_id: partial.id,
                    trade_id: partial.trade_id,
                    tp_idx: partial.tp_idx,
                    trigger_price: partial.trigger_price,
                    close_lots: partial.close_lots,
                    ref_price: refPrice,
                },
                response_payload: { ticket: result.ticket, latency_ms: latencyMs, claimed_by: this.hostId },
            });
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // "trade not found" / "position already closed" — the parent trade
            // closed under us (SL, broker TP, manual). Cancel the partial; the
            // remaining slice rode to broker TP already, nothing left to do.
            const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg);
            if (benign) {
                console.log(`[partialTpMonitor] parent gone signal=${partial.signal_id} ticket=${ticketNum}: ${msg}`);
                await this.supabase
                    .from('partial_tp_legs')
                    .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: msg })
                    .eq('id', partial.id);
                return true;
            }
            console.error(`[partialTpMonitor] fire failed partial=${partial.id} ticket=${ticketNum}: ${msg}`);
            // Roll back to 'pending' so the next tick retries.
            await this.supabase
                .from('partial_tp_legs')
                .update({ status: 'pending', claimed_at: null, claimed_by: null, error_message: msg })
                .eq('id', partial.id);
            await this.supabase.from('trade_execution_logs').insert({
                user_id: partial.user_id,
                signal_id: partial.signal_id,
                broker_account_id: partial.broker_account_id,
                action: 'partial_tp_fired',
                status: 'failed',
                request_payload: {
                    partial_id: partial.id,
                    trade_id: partial.trade_id,
                    tp_idx: partial.tp_idx,
                    trigger_price: partial.trigger_price,
                    close_lots: partial.close_lots,
                    ref_price: refPrice,
                },
                error_message: msg,
            });
            return false;
        }
    }
}
exports.PartialTpMonitor = PartialTpMonitor;
