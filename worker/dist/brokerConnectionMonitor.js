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
/**
 * Keeps MetatraderAPI sessions alive with lightweight CheckConnect pings.
 * Only calls ConnectByToken when the session is down; avoids flipping status on transient blips.
 */
const RECONNECT_ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('BROKER_RECONNECT_INTERVAL_MS', Math.max(60000, Number(process.env.BROKER_RECONNECT_INTERVAL_MS ?? 300000) || 300000));
const RECONNECT_IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('BROKER_RECONNECT_IDLE_MS', 300000);
class BrokerConnectionMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.reconnectLoop = null;
        this.failStreak = new Map();
    }
    start() {
        // Keepalive pings run in TradeExecutor.sessionHeartbeatTick (in-memory broker cache).
        // This monitor only handles reconnect sweeps and connection_status updates.
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
        let ok = 0;
        let failed = 0;
        for (const row of rows) {
            const uuid = row.metaapi_account_id?.trim();
            if (!isMtUuid(uuid))
                continue;
            const api = this.clientFor(row.platform);
            if (!api)
                continue;
            const ready = await api.verifyTradingReady(uuid);
            if (ready) {
                this.failStreak.delete(row.id);
                ok++;
            }
            else {
                const streak = (this.failStreak.get(row.id) ?? 0) + 1;
                this.failStreak.set(row.id, streak);
                failed++;
                if (streak >= 2 && row.connection_status !== 'error') {
                    console.warn(`[brokerConnection] session down broker=${row.id} (streak=${streak})`);
                    await (0, brokerConnectionStatus_1.writeBrokerConnectionStatus)(this.supabase, row.id, 'error');
                }
            }
        }
        if (ok > 0 || failed > 0) {
            console.log(`[brokerConnection] tick: ${ok} alive, ${failed} down`);
        }
    }
}
exports.BrokerConnectionMonitor = BrokerConnectionMonitor;
