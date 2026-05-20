"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CweCloseMonitor = void 0;
exports.isCweTriggered = isCweTriggered;
const metatraderapi_1 = require("./metatraderapi");
const mtApiByAccount_1 = require("./mtApiByAccount");
const monitorIdleGate_1 = require("./monitorIdleGate");
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('CWE_CLOSE_TICK_MS', 1500);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('CWE_CLOSE_IDLE_MS', 60000);
/**
 * Pure trigger check. Exported so the unit test can lock the
 * direction-aware comparison without spinning up a Supabase client.
 *
 *   buy  → close when bid  >= threshold
 *   sell → close when ask  <= threshold
 *
 * Returns false on NaN / non-finite inputs so a flaky /Quote can't ever
 * cause a spurious close.
 */
function isCweTriggered(direction, threshold, bid, ask) {
    if (!Number.isFinite(threshold) || threshold <= 0)
        return false;
    if (!Number.isFinite(bid) || !Number.isFinite(ask))
        return false;
    const isBuy = String(direction).toLowerCase() === 'buy';
    return isBuy ? bid >= threshold : ask <= threshold;
}
class CweCloseMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.loop = null;
        this.ticking = false;
        this.firstTickLogged = false;
        /** Heartbeat: log one summary line every ~30s (20 ticks × 1.5s) when there
         *  are watched trades but none have triggered. Makes "alive but waiting"
         *  visible in worker logs vs. "dead". */
        this.quietTicks = 0;
    }
    start() {
        if (this.loop)
            return;
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
            console.warn('[cweCloseMonitor] MT4API_BASIC_USER/PASSWORD missing — close-worse-entries monitor disabled');
            return;
        }
        this.loop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'cweCloseMonitor',
            supabase: this.supabase,
            activeIntervalMs: ACTIVE_MS,
            idleIntervalMs: IDLE_MS,
            hasWork: sb => (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'trades', q => q.eq('status', 'open').not('cwe_close_price', 'is', null)),
            tick: () => this.runTick(),
        });
        console.log(`[cweCloseMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`);
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
        // Pull every open trade that has a CWE close threshold pinned to it.
        // The partial index `trades_cwe_open_idx` makes this a constant-time
        // probe even with millions of historical trades on the table.
        const tradesQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('trades')
            .select('id,user_id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,cwe_close_price')
            .eq('status', 'open')
            .not('cwe_close_price', 'is', null)
            .limit(500));
        if (!tradesQ)
            return;
        const { data, error } = await tradesQ;
        if (error) {
            console.error('[cweCloseMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? []);
        if (!this.firstTickLogged) {
            this.firstTickLogged = true;
            console.log(`[cweCloseMonitor] first tick ok watched_rows=${rows.length}`);
        }
        if (!rows.length) {
            this.quietTicks = 0;
            return;
        }
        // Resolve each broker_account_id once so we can call /Quote and
        // /OrderClose by metaapi_account_id (the platform's UUID). Trades that
        // reference a deleted broker silently skip.
        const brokerIds = Array.from(new Set(rows.map(r => r.broker_account_id).filter((x) => !!x)));
        const brokerMap = new Map(); // broker_account_id -> metaapi_account_id
        if (brokerIds.length > 0) {
            const { data: brokers, error: brokerErr } = await this.supabase
                .from('broker_accounts')
                .select('id,metaapi_account_id,platform')
                .in('id', brokerIds);
            if (brokerErr) {
                console.error('[cweCloseMonitor] broker lookup failed:', brokerErr.message);
                return;
            }
            for (const b of (brokers ?? [])) {
                if (b.metaapi_account_id)
                    brokerMap.set(b.id, b.metaapi_account_id);
            }
        }
        const platformByUuid = await (0, mtApiByAccount_1.loadPlatformByMetaapiId)(this.supabase, Array.from(brokerMap.values()));
        // Group by (metaapi_account_id, symbol) so we issue at most ONE /Quote per
        // group per tick. Same shape as virtualPendingMonitor for consistency.
        const groups = new Map();
        for (const r of rows) {
            const uuid = r.broker_account_id ? brokerMap.get(r.broker_account_id) : null;
            if (!uuid)
                continue;
            const key = `${uuid}|${r.symbol}`;
            const list = groups.get(key) ?? [];
            list.push(r);
            groups.set(key, list);
        }
        let triggeredTotal = 0;
        let closedOkTotal = 0;
        let closedErrTotal = 0;
        /** Per-group: nearest distance from live quote to any threshold (so the
         *  heartbeat shows "you're $0.40 from your nearest CWE close"). */
        const distances = [];
        await Promise.all(Array.from(groups.entries()).map(async ([key, trades]) => {
            const [uuid, symbol] = key.split('|');
            if (!uuid || !symbol)
                return;
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(platformByUuid, uuid);
            if (!api)
                return;
            let q;
            try {
                q = await api.quote(uuid, symbol);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[cweCloseMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`);
                return;
            }
            let nearestGap = Number.POSITIVE_INFINITY;
            for (const trade of trades) {
                const isBuy = String(trade.direction).toLowerCase() === 'buy';
                const ref = isBuy ? q.bid : q.ask;
                // For buys: positive gap means bid still BELOW threshold (waiting for rise).
                // For sells: positive gap means ask still ABOVE threshold (waiting for fall).
                const gap = isBuy ? trade.cwe_close_price - ref : ref - trade.cwe_close_price;
                if (Number.isFinite(gap) && gap < nearestGap)
                    nearestGap = gap;
                if (!isCweTriggered(trade.direction, trade.cwe_close_price, q.bid, q.ask))
                    continue;
                triggeredTotal += 1;
                const ok = await this.closeTrade(trade, uuid, api, q.bid, q.ask);
                if (ok)
                    closedOkTotal += 1;
                else
                    closedErrTotal += 1;
            }
            distances.push({ symbol, bid: q.bid, ask: q.ask, gap: nearestGap, legs: trades.length });
        }));
        if (triggeredTotal > 0) {
            console.log(`[cweCloseMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} closed=${closedOkTotal}_ok ${closedErrTotal}_err`);
            this.quietTicks = 0;
        }
        else {
            this.quietTicks += 1;
            if (this.quietTicks % 20 === 1) {
                const summary = distances
                    .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gap) ? d.gap.toFixed(5) : 'n/a'} (${d.legs} legs)`)
                    .join('; ');
                console.log(`[cweCloseMonitor] heartbeat rows=${rows.length} groups=${groups.size} no thresholds crossed yet — ${summary}`);
            }
        }
    }
    /**
     * Attempt to close one CWE-watched trade. Returns true on success (or when
     * the broker reports the trade is already gone — same outcome). Failures
     * leave the row in place so the next tick retries.
     *
     * Concurrency note: we CAS-update `cwe_close_price` to null BEFORE calling
     * /OrderClose. If a second tick (or a peer worker) grabs the same row, the
     * update returns no row and this function bails — only one /OrderClose
     * ever lands per ticket.
     */
    async closeTrade(trade, uuid, api, bid, ask) {
        const ticketNum = Number(trade.metaapi_order_id);
        if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
            // Missing ticket — nothing for us to close. Clear the watch so we
            // don't keep retrying on every tick.
            await this.supabase.from('trades').update({ cwe_close_price: null }).eq('id', trade.id);
            return false;
        }
        // CAS claim: clear the cwe_close_price so a second tick or a peer worker
        // can't issue a duplicate /OrderClose. The `.maybeSingle()` returns
        // null when the row already moved (another tick won the race).
        const { data: claimed, error: claimErr } = await this.supabase
            .from('trades')
            .update({ cwe_close_price: null })
            .eq('id', trade.id)
            .eq('status', 'open')
            .not('cwe_close_price', 'is', null)
            .select('id')
            .maybeSingle();
        if (claimErr) {
            console.warn(`[cweCloseMonitor] CAS claim error trade=${trade.id}: ${claimErr.message}`);
            return false;
        }
        if (!claimed) {
            // Someone else claimed it. Quiet — this is expected when multiple
            // workers are deployed for redundancy.
            return false;
        }
        const t0 = Date.now();
        const isBuy = String(trade.direction).toLowerCase() === 'buy';
        const refPrice = isBuy ? bid : ask;
        try {
            const result = await api.orderClose(uuid, {
                ticket: ticketNum,
                lots: trade.lot_size ?? 0,
                // Leaving price=0 lets the broker fill at market — same behavior as
                // a manual close from the terminal. We *report* refPrice in logs for
                // diagnostics only.
            });
            const latencyMs = Date.now() - t0;
            console.log(`[cweCloseMonitor] closed signal=${trade.signal_id ?? 'n/a'} symbol=${trade.symbol} ticket=${ticketNum}`
                + ` threshold=${trade.cwe_close_price} ref=${refPrice} latency=${latencyMs}ms`);
            await this.supabase
                .from('trades')
                .update({ status: 'closed', closed_at: new Date().toISOString() })
                .eq('id', trade.id);
            await this.supabase.from('trade_execution_logs').insert({
                user_id: trade.user_id,
                signal_id: trade.signal_id,
                broker_account_id: trade.broker_account_id,
                action: 'cwe_close',
                status: 'success',
                request_payload: {
                    ticket: ticketNum,
                    symbol: trade.symbol,
                    direction: trade.direction,
                    threshold: trade.cwe_close_price,
                    ref_price: refPrice,
                },
                response_payload: { ticket: result.ticket, latency_ms: latencyMs },
            });
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // "trade not found" / "position already closed" — treat as success,
            // the trade is gone either way. Conservative match list so we never
            // swallow a real error.
            const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg);
            if (benign) {
                console.log(`[cweCloseMonitor] trade already gone signal=${trade.signal_id ?? 'n/a'} ticket=${ticketNum}: ${msg}`);
                await this.supabase
                    .from('trades')
                    .update({ status: 'closed', closed_at: new Date().toISOString() })
                    .eq('id', trade.id);
                return true;
            }
            console.error(`[cweCloseMonitor] close failed signal=${trade.signal_id ?? 'n/a'} ticket=${ticketNum}: ${msg}`);
            // Restore the watch so a future tick can retry. Without this the trade
            // would stay open but un-watched forever after a transient /OrderClose
            // failure.
            await this.supabase
                .from('trades')
                .update({ cwe_close_price: trade.cwe_close_price })
                .eq('id', trade.id)
                .eq('status', 'open');
            await this.supabase.from('trade_execution_logs').insert({
                user_id: trade.user_id,
                signal_id: trade.signal_id,
                broker_account_id: trade.broker_account_id,
                action: 'cwe_close',
                status: 'failed',
                request_payload: {
                    ticket: ticketNum,
                    symbol: trade.symbol,
                    direction: trade.direction,
                    threshold: trade.cwe_close_price,
                    ref_price: refPrice,
                },
                error_message: msg,
            });
            return false;
        }
    }
}
exports.CweCloseMonitor = CweCloseMonitor;
