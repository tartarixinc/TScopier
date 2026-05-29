"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenTradeReconcileMonitor = void 0;
const metatraderapi_1 = require("./metatraderapi");
const mtApiByAccount_1 = require("./mtApiByAccount");
const monitorIdleGate_1 = require("./monitorIdleGate");
const openTradeReconcile_1 = require("./openTradeReconcile");
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('OPEN_TRADE_RECONCILE_TICK_MS', 30000);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('OPEN_TRADE_RECONCILE_IDLE_MS', 120000);
const BATCH_LIMIT = 500;
class OpenTradeReconcileMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.loop = null;
        this.ticking = false;
        this.platformByUuid = new Map();
    }
    start() {
        if (this.loop)
            return;
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
            console.warn('[openTradeReconcileMonitor] MT4API_BASIC_USER/PASSWORD missing — disabled');
            return;
        }
        this.loop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'openTradeReconcileMonitor',
            supabase: this.supabase,
            activeIntervalMs: ACTIVE_MS,
            idleIntervalMs: IDLE_MS,
            hasWork: sb => (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'trades', q => q.eq('status', 'open')),
            tick: () => this.runTick(),
        });
        console.log(`[openTradeReconcileMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`);
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
        const tradesQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('trades')
            .select('id,broker_account_id,metaapi_order_id')
            .eq('status', 'open')
            .not('broker_account_id', 'is', null)
            .limit(BATCH_LIMIT));
        if (!tradesQ)
            return;
        const { data, error } = await tradesQ;
        if (error) {
            console.warn(`[openTradeReconcileMonitor] select failed: ${error.message}`);
            return;
        }
        const rows = (data ?? []);
        if (!rows.length)
            return;
        const byBroker = new Map();
        for (const row of rows) {
            const brokerId = row.broker_account_id;
            if (!brokerId)
                continue;
            const list = byBroker.get(brokerId) ?? [];
            list.push(row);
            byBroker.set(brokerId, list);
        }
        const brokerIds = [...byBroker.keys()];
        const { data: brokers, error: brokerErr } = await this.supabase
            .from('broker_accounts')
            .select('id,metaapi_account_id')
            .in('id', brokerIds);
        if (brokerErr) {
            console.warn(`[openTradeReconcileMonitor] broker load failed: ${brokerErr.message}`);
            return;
        }
        const uuids = (brokers ?? [])
            .map(b => String(b.metaapi_account_id ?? '').trim())
            .filter(uuid => uuid.length > 0 && !uuid.includes('|'));
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByMetaapiId)(this.supabase, uuids);
        let totalClosed = 0;
        for (const broker of (brokers ?? [])) {
            const uuid = String(broker.metaapi_account_id ?? '').trim();
            if (!uuid || uuid.includes('|'))
                continue;
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, uuid);
            if (!api)
                continue;
            const openForBroker = byBroker.get(broker.id) ?? [];
            if (!openForBroker.length)
                continue;
            try {
                try {
                    const alive = await api.keepSessionAlive(uuid);
                    if (!alive)
                        continue;
                }
                catch {
                    continue;
                }
                const closed = await (0, openTradeReconcile_1.reconcileOpenTradesForBroker)(this.supabase, api, uuid, openForBroker);
                if (closed > 0) {
                    totalClosed += closed;
                    console.log(`[openTradeReconcileMonitor] closed ${closed} stale open trade(s) broker=${broker.id}`);
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[openTradeReconcileMonitor] reconcile failed broker=${broker.id}: ${msg}`);
            }
        }
        if (totalClosed > 0) {
            console.log(`[openTradeReconcileMonitor] tick closed ${totalClosed} stale open trade(s)`);
        }
    }
}
exports.OpenTradeReconcileMonitor = OpenTradeReconcileMonitor;
