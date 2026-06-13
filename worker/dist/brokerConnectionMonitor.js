"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrokerConnectionMonitor = void 0;
const metatraderapi_1 = require("./metatraderapi");
const brokerConnectionStatus_1 = require("./brokerConnectionStatus");
const brokerHardReconnect_1 = require("./brokerHardReconnect");
const mtServerSessionLock_1 = require("./mtServerSessionLock");
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
const BACKOFF_MAX_MS = Math.max(BACKOFF_BASE_MS, Math.min(30 * 60000, Number(process.env.BROKER_RECONNECT_BACKOFF_MAX_MS ?? 300000) || 300000));
const BACKOFF_RESET_AFTER_MS = Math.max(BACKOFF_BASE_MS, Math.min(6 * 60 * 60000, Number(process.env.BROKER_RECONNECT_BACKOFF_RESET_MS ?? 30 * 60000) || 30 * 60000));
function nextBackoffMs(fails) {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.min(fails - 1, 8)), BACKOFF_MAX_MS);
}
/**
 * Keeps MetatraderAPI sessions alive with lightweight CheckConnect pings.
 * Actively reconnects downed sessions via ConnectByToken with exponential backoff.
 */
const RECONNECT_ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('BROKER_RECONNECT_INTERVAL_MS', Math.max(30000, Number(process.env.BROKER_RECONNECT_INTERVAL_MS ?? 60000) || 60000));
const RECONNECT_IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('BROKER_RECONNECT_IDLE_MS', 120000);
const HARD_RECONNECT_SWEEP_MS = Math.max(60000, Math.min(6 * 60 * 60000, Number(process.env.BROKER_HARD_RECONNECT_SWEEP_MS ?? 5 * 60000) || 5 * 60000));
class BrokerConnectionMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.reconnectLoop = null;
        this.hardReconnectSweepTimer = null;
        this.hardReconnectSweepInFlight = false;
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
        if (!this.hardReconnectSweepTimer) {
            this.hardReconnectSweepTimer = setInterval(() => {
                void this.hardReconnectSweepTick();
            }, HARD_RECONNECT_SWEEP_MS);
            this.hardReconnectSweepTimer.unref?.();
            // One startup nudge so weekend-open recoveries don't wait for the full interval.
            setTimeout(() => {
                void this.hardReconnectSweepTick();
            }, 30000).unref?.();
            console.log(`[brokerConnection] hard reconnect sweep every ${HARD_RECONNECT_SWEEP_MS}ms`);
        }
    }
    stop() {
        this.reconnectLoop?.stop();
        this.reconnectLoop = null;
        if (this.hardReconnectSweepTimer)
            clearInterval(this.hardReconnectSweepTimer);
        this.hardReconnectSweepTimer = null;
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
            .select('id,platform,metaapi_account_id,connection_status,account_login,broker_server,auto_reconnect_enabled,mt_password_encrypted')
            .not('metaapi_account_id', 'is', null));
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
        let lastServerKey = null;
        for (const row of rows) {
            lastServerKey = await (0, mtServerSessionLock_1.pauseIfSameMtServer)(lastServerKey, row.platform, row.broker_server);
            const uuid = row.metaapi_account_id?.trim();
            if (!isMtUuid(uuid))
                continue;
            const api = this.clientFor(row.platform);
            if (!api)
                continue;
            const existing = this.backoff.get(row.id);
            if (existing && now - existing.lastAttemptAt >= BACKOFF_RESET_AFTER_MS) {
                this.backoff.delete(row.id);
            }
            const entry = this.backoff.get(row.id);
            if (entry && now < entry.nextEligibleAt) {
                skipped++;
                continue;
            }
            const keepalive = await api.keepSessionAliveDetailed(uuid);
            if (keepalive === 'alive') {
                if (this.backoff.has(row.id)) {
                    console.log(`[brokerConnection] broker=${row.id} recovered after backoff`);
                }
                this.backoff.delete(row.id);
                ok++;
                if (row.connection_status !== 'connected') {
                    await (0, brokerConnectionStatus_1.writeBrokerConnectionStatus)(this.supabase, row.id, 'connected');
                }
            }
            else if (row.auto_reconnect_enabled
                && row.mt_password_encrypted
                && row.account_login
                && row.broker_server) {
                const hardOk = await (0, brokerHardReconnect_1.hardReconnectBrokerSession)(this.supabase, api, {
                    id: row.id,
                    platform: row.platform,
                    metaapi_account_id: uuid,
                    account_login: row.account_login,
                    broker_server: row.broker_server,
                    auto_reconnect_enabled: row.auto_reconnect_enabled,
                    mt_password_encrypted: row.mt_password_encrypted,
                });
                if (hardOk) {
                    this.backoff.delete(row.id);
                    ok++;
                }
                else {
                    this.registerFailure(row, now, 'hard reconnect failed');
                    reconnected++;
                }
            }
            else {
                this.registerFailure(row, now, keepalive);
                reconnected++;
            }
        }
        if (ok > 0 || reconnected > 0 || skipped > 0) {
            console.log(`[brokerConnection] tick: ${ok} alive, ${reconnected} failed, ${skipped} in backoff`);
        }
    }
    registerFailure(row, now, reason) {
        const prev = this.backoff.get(row.id);
        const fails = (prev?.fails ?? 0) + 1;
        const delay = nextBackoffMs(fails);
        this.backoff.set(row.id, { fails, lastAttemptAt: now, nextEligibleAt: now + delay });
        const hasCreds = Boolean(row.auto_reconnect_enabled
            && row.mt_password_encrypted
            && row.account_login
            && row.broker_server);
        if (hasCreds) {
            if (row.connection_status !== 'recovering' && row.connection_status !== 'error') {
                void (0, brokerConnectionStatus_1.writeBrokerConnectionStatus)(this.supabase, row.id, 'recovering');
            }
        }
        else if (fails >= 4 && row.connection_status !== 'error') {
            void (0, brokerConnectionStatus_1.writeBrokerConnectionStatus)(this.supabase, row.id, 'error', {
                rawError: 'keepSessionAlive failed during reconnect sweep',
            });
        }
        if (fails <= 3 || fails % 10 === 0) {
            console.warn(`[brokerConnection] broker=${row.id} down reason=${reason} (fails=${fails}, next retry in ${Math.round(delay / 1000)}s)`);
        }
    }
    async hardReconnectSweepTick() {
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)())
            return;
        if (this.hardReconnectSweepInFlight)
            return;
        this.hardReconnectSweepInFlight = true;
        try {
            const brokersQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
                .from('broker_accounts')
                .select('id,platform,metaapi_account_id,connection_status,account_login,broker_server,auto_reconnect_enabled,mt_password_encrypted')
                .not('metaapi_account_id', 'is', null)
                .in('connection_status', ['error', 'recovering'])
                .eq('auto_reconnect_enabled', true)
                .not('mt_password_encrypted', 'is', null));
            if (!brokersQ)
                return;
            const { data, error } = await brokersQ;
            if (error) {
                console.warn('[brokerConnection] hard sweep load failed:', error.message);
                return;
            }
            const rows = (data ?? []);
            if (rows.length === 0)
                return;
            let recovered = 0;
            let failed = 0;
            let lastServerKey = null;
            const now = Date.now();
            for (const row of rows) {
                const uuid = row.metaapi_account_id?.trim();
                if (!isMtUuid(uuid))
                    continue;
                if (!row.account_login || !row.broker_server || !row.mt_password_encrypted)
                    continue;
                const api = this.clientFor(row.platform);
                if (!api)
                    continue;
                lastServerKey = await (0, mtServerSessionLock_1.pauseIfSameMtServer)(lastServerKey, row.platform, row.broker_server);
                const hardOk = await (0, brokerHardReconnect_1.hardReconnectBrokerSession)(this.supabase, api, {
                    id: row.id,
                    platform: row.platform,
                    metaapi_account_id: uuid,
                    account_login: row.account_login,
                    broker_server: row.broker_server,
                    auto_reconnect_enabled: row.auto_reconnect_enabled,
                    mt_password_encrypted: row.mt_password_encrypted,
                });
                if (hardOk) {
                    this.backoff.delete(row.id);
                    recovered += 1;
                }
                else {
                    failed += 1;
                    this.registerFailure(row, now, 'scheduled_hard_reconnect_failed');
                }
            }
            console.log(`[brokerConnection] hard sweep done: recovered=${recovered} failed=${failed}`);
        }
        finally {
            this.hardReconnectSweepInFlight = false;
        }
    }
}
exports.BrokerConnectionMonitor = BrokerConnectionMonitor;
