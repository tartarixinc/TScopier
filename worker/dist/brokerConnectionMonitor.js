"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrokerConnectionMonitor = void 0;
const metatraderapi_1 = require("./metatraderapi");
const brokerConnectionStatus_1 = require("./brokerConnectionStatus");
const monitorIdleGate_1 = require("./monitorIdleGate");
function isMtUuid(s) {
    if (!s)
        return false;
    const v = s.trim();
    if (!v || v.includes('|'))
        return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
const BACKOFF_BASE_MS = 60000;
const BACKOFF_MAX_MS = 600000;
function nextBackoffMs(fails) {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.min(fails - 1, 8)), BACKOFF_MAX_MS);
}
/**
 * Keeps MetatraderAPI sessions alive with lightweight CheckConnect pings.
 * Actively reconnects downed sessions via ConnectByToken with exponential backoff.
 */
const RECONNECT_ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('BROKER_RECONNECT_INTERVAL_MS', Math.max(60000, Number(process.env.BROKER_RECONNECT_INTERVAL_MS ?? 300000) || 300000));
const RECONNECT_IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('BROKER_RECONNECT_IDLE_MS', 300000);
class BrokerConnectionMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.reconnectLoop = null;
        this.backoff = new Map();
    }
    start() {
        if (!this.reconnectLoop) {
            this.reconnectLoop = (0, monitorIdleGate_1.startMonitorLoop)({
                name: 'brokerConnectionReconnect',
                supabase: this.supabase,
                activeIntervalMs: RECONNECT_ACTIVE_MS,
                idleIntervalMs: RECONNECT_IDLE_MS,
                hasWork: sb => (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'broker_accounts', q => q.eq('is_active', true)),
                tick: () => this.reconnectTick(),
            });
            console.log(`[brokerConnection] reconnect sweep active=${RECONNECT_ACTIVE_MS}ms idle=${RECONNECT_IDLE_MS}ms`);
        }
    }
    stop() {
        this.reconnectLoop?.stop();
        this.reconnectLoop = null;
    }
    getLoopHandles() {
        return [this.reconnectLoop].filter(Boolean);
    }
    resetBackoff(brokerId) {
        this.backoff.delete(brokerId);
    }
    clientFor(platform) {
        return (0, metatraderapi_1.getMetatraderApi)((0, metatraderapi_1.mtPlatformFrom)(platform));
    }
    async reconnectTick() {
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)())
            return;
        const brokersQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('broker_accounts')
            .select('id,platform,metaapi_account_id,connection_status')
            .eq('is_active', true));
        if (!brokersQ)
            return;
        const { data, error } = await brokersQ;
        if (error) {
            console.warn('[brokerConnection] load brokers failed:', error.message);
            return;
        }
        const rows = (data ?? []);
        const now = Date.now();
        let ok = 0;
        let reconnected = 0;
        let skipped = 0;
        for (const row of rows) {
            const uuid = row.metaapi_account_id?.trim();
            if (!isMtUuid(uuid))
                continue;
            const api = this.clientFor(row.platform);
            if (!api)
                continue;
            const entry = this.backoff.get(row.id);
            if (entry && now < entry.nextEligibleAt) {
                skipped++;
                continue;
            }
            const alive = await api.keepSessionAlive(uuid);
            if (alive) {
                if (this.backoff.has(row.id)) {
                    console.log(`[brokerConnection] broker=${row.id} recovered after backoff`);
                }
                this.backoff.delete(row.id);
                ok++;
                if (row.connection_status !== 'connected') {
                    await (0, brokerConnectionStatus_1.writeBrokerConnectionStatus)(this.supabase, row.id, 'connected');
                }
            }
            else {
                const prev = this.backoff.get(row.id);
                const fails = (prev?.fails ?? 0) + 1;
                const delay = nextBackoffMs(fails);
                this.backoff.set(row.id, { fails, lastAttemptAt: now, nextEligibleAt: now + delay });
                if (fails >= 2 && row.connection_status !== 'error') {
                    await (0, brokerConnectionStatus_1.writeBrokerConnectionStatus)(this.supabase, row.id, 'error');
                }
                if (fails <= 3 || fails % 10 === 0) {
                    console.warn(`[brokerConnection] broker=${row.id} down (fails=${fails}, next retry in ${Math.round(delay / 1000)}s)`);
                }
                reconnected++;
            }
        }
        if (ok > 0 || reconnected > 0 || skipped > 0) {
            console.log(`[brokerConnection] tick: ${ok} alive, ${reconnected} failed, ${skipped} in backoff`);
        }
    }
}
exports.BrokerConnectionMonitor = BrokerConnectionMonitor;
