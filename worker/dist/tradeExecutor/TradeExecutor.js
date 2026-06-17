"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeExecutor = void 0;
const fxsocketClient_1 = require("../fxsocketClient");
const manualPlanner_1 = require("../manualPlanner");
const normalizeManualSettings_1 = require("../manualPlanning/normalizeManualSettings");
const effectiveBrokerBalance_1 = require("../effectiveBrokerBalance");
const channelTradingConfig_1 = require("../channelTradingConfig");
const brokerChannelTradingConfigs_1 = require("../brokerChannelTradingConfigs");
const helpers_1 = require("./basketMerge/helpers");
const signalBrokerDispatchClaim_1 = require("./signalBrokerDispatchClaim");
const signalRevision_1 = require("../signalRevision");
const tradeSignalActions_1 = require("../tradeSignalActions");
const workerConfig_1 = require("../workerConfig");
const monitorIdleGate_1 = require("../monitorIdleGate");
const brokerChannelFilter_1 = require("../brokerChannelFilter");
const brokerSignalReplay_1 = require("../brokerSignalReplay");
const channelTradingConfig_2 = require("../channelTradingConfig");
const copyLimitTypes_1 = require("../copyLimitTypes");
const pipelineTimestamps_1 = require("../pipelineTimestamps");
const channelKeywordsCache_1 = require("../channelKeywordsCache");
const helpers_2 = require("./helpers");
const types_1 = require("./types");
const brokerSymbolCache = __importStar(require("./brokerSymbolCache"));
const dispatch = __importStar(require("./dispatch"));
const basketMerge = __importStar(require("./basketMerge"));
const managementExecutor = __importStar(require("./managementExecutor"));
const singleEntryExecutor_1 = require("./singleEntryExecutor");
const rangeTradeExecutor_1 = require("./rangeTradeExecutor");
const copierPause_1 = require("../copierPause");
class TradeExecutor {
    constructor(supabase, sessionManager) {
        this.supabase = supabase;
        this.sessionManager = sessionManager;
        this.sweepLoop = null;
        /** Cancels TSCopier broker pendings past `pending_expiry_hours` (1–24) when env enabled. */
        this.brokerPendingSweepTimer = null;
        this.sessionHeartbeatTimer = null;
        this.sessionHeartbeatInFlight = false;
        this.sessionHeartbeatSkipped = 0;
        this.symbolCacheKeepaliveTimer = null;
        this.signalsChannel = null;
        this.brokersChannel = null;
        this.channelTradingConfigsChannel = null;
        this.channelsChannel = null;
        this.userProfilesChannel = null;
        this.brokersByUser = new Map();
        this.brokersById = new Map();
        this.inflight = new Set();
        /** Prevents overlapping sendOrder for the same signal+broker (live-fast race). */
        this.entryBrokerInflight = new Set();
        this.queuedIds = new Set();
        this.highPriorityQueue = [];
        this.normalPriorityQueue = [];
        this.queueDrainScheduled = false;
        this.queueDraining = false;
        this.symbolCache = new Map();
        /** Per-broker `/Symbols` cache used to map signal symbols (e.g. BTCUSD) to broker variants (BTCUSDm). */
        this.symbolListCache = new Map();
        /** Cached channel rows keyed by `telegram_channels.id` — refreshed on demand. */
        this.channelMetaCache = new Map();
        this.sessionPingAt = new Map();
        /** Coalesce concurrent session checks per MT uuid (burst fan-out). */
        this.sessionCheckInflight = new Map();
        /** Coalesce concurrent /Symbols fetches per MT uuid. */
        this.symbolListInflight = new Map();
        /** Coalesce concurrent /SymbolParams fetches per `${uuid}:${symbol}` key. */
        this.symbolParamsInflight = new Map();
        /** After OrderSend "Not connected", block re-trading until user reconnects. */
        this.sessionOrderBlocked = new Set();
        /**
         * Per-broker "last reactivated" wall time. Set whenever `is_active` flips
         * to true (including the initial load when the broker is already active).
         * Signals whose `created_at` is older than this timestamp are treated as
         * stale-after-outage and skipped, so the 5-minute sweep can't fire trades
         * that piled up while the broker was disabled.
         */
        this.brokerActivatedAt = new Map();
        this.userTimezoneById = new Map();
        this.copyLimitStateCache = new Map();
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)()) {
            console.warn('[tradeExecutor] MT4API_BASIC_USER/PASSWORD missing — trade execution disabled.');
        }
    }
    apiFor(broker) {
        return (0, fxsocketClient_1.getFxsocketClient)();
    }
    apiForUuid(uuid) {
        for (const b of this.brokersById.values()) {
            if (b.metaapi_account_id === uuid)
                return this.apiFor(b);
        }
        console.error(`[tradeExecutor] apiForUuid: unknown broker uuid=${uuid}`);
        return null;
    }
    async start() {
        await this.loadBrokers();
        this.subscribeSignals();
        this.subscribeBrokers();
        this.subscribeChannelTradingConfigs();
        this.subscribeChannelKeywords();
        this.subscribeUserProfilesCopierPause();
        const replaySince = () => new Date(Date.now() - types_1.EXECUTOR_REPLAY_MAX_AGE_MS).toISOString();
        this.sweepLoop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'tradeExecutorSweep',
            supabase: this.supabase,
            activeIntervalMs: types_1.EXECUTOR_PARSED_SWEEP_MS,
            idleIntervalMs: types_1.EXECUTOR_SWEEP_IDLE_MS,
            hasWork: sb => (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'signals', q => q.eq('status', 'parsed').gte('created_at', replaySince())),
            tick: () => this.sweep(),
        });
        this.brokerPendingSweepTimer = setInterval(() => {
            this.sweepExpiredTscopierBrokerPendings().catch(err => console.error('[tradeExecutor] broker pending TTL sweep failed:', err));
        }, 5 * 60000);
        this.brokerPendingSweepTimer.unref?.();
        console.log(`[tradeExecutor] started mode=${workerConfig_1.workerConfig.tradeExecutorMode} role=${workerConfig_1.workerConfig.role}`
            + ` realtime=${workerConfig_1.workerConfig.tradeExecutorRealtime}`);
        if (String(process.env.WORKER_LEGACY_PENDING_CLEANUP ?? '').toLowerCase() === 'true') {
            this.cleanupLegacyBrokerPendings().catch(err => console.error('[tradeExecutor] legacy pending cleanup failed:', err));
        }
        void this.prewarmBrokerCaches();
        this.sessionHeartbeatTimer = setInterval(() => {
            void this.runSessionHeartbeatTick();
        }, types_1.BROKER_SESSION_HEARTBEAT_MS);
        this.sessionHeartbeatTimer.unref?.();
        // Re-fetch every cached symbol list / params entry before its TTL expires
        // so the live-entry hot path always finds a warm cache. Without this,
        // signal symbols outside `symbol_to_trade` fall back to a cold broker
        // round-trip (~1.5s) each time and inflate `send_order_prep_ms`.
        this.symbolCacheKeepaliveTimer = setInterval(() => {
            void this.symbolCacheKeepaliveTick();
        }, types_1.SYMBOL_CACHE_KEEPALIVE_MS);
        this.symbolCacheKeepaliveTimer.unref?.();
    }
    stop() {
        this.sweepLoop?.stop();
        this.sweepLoop = null;
        if (this.brokerPendingSweepTimer)
            clearInterval(this.brokerPendingSweepTimer);
        this.brokerPendingSweepTimer = null;
        if (this.sessionHeartbeatTimer)
            clearInterval(this.sessionHeartbeatTimer);
        this.sessionHeartbeatTimer = null;
        if (this.symbolCacheKeepaliveTimer)
            clearInterval(this.symbolCacheKeepaliveTimer);
        this.symbolCacheKeepaliveTimer = null;
        if (this.signalsChannel) {
            void this.supabase.removeChannel(this.signalsChannel);
            this.signalsChannel = null;
        }
        if (this.brokersChannel) {
            void this.supabase.removeChannel(this.brokersChannel);
            this.brokersChannel = null;
        }
        if (this.channelTradingConfigsChannel) {
            void this.supabase.removeChannel(this.channelTradingConfigsChannel);
            this.channelTradingConfigsChannel = null;
        }
        if (this.channelsChannel) {
            void this.supabase.removeChannel(this.channelsChannel);
            this.channelsChannel = null;
        }
        if (this.userProfilesChannel) {
            void this.supabase.removeChannel(this.userProfilesChannel);
            this.userProfilesChannel = null;
        }
    }
    // ── caches ────────────────────────────────────────────────────────────
    normalizeBrokerRow(row) {
        const healedConfigs = (0, channelTradingConfig_1.healChannelTradingConfigsMap)(row);
        const accountBalance = (0, effectiveBrokerBalance_1.resolveBrokerTotalBalance)(row) || null;
        const normalizedConfigs = {};
        for (const [channelId, cfg] of Object.entries(healedConfigs)) {
            normalizedConfigs[channelId] = {
                ...cfg,
                manual_settings: (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(cfg.manual_settings, {
                    accountBalance,
                }),
            };
        }
        const sessionId = (0, helpers_2.brokerSessionUuid)(row);
        return {
            ...row,
            metaapi_account_id: sessionId ?? row.metaapi_account_id,
            manual_settings: (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(row.manual_settings, {
                accountBalance,
            }),
            channel_trading_configs: normalizedConfigs,
        };
    }
    getSweepLoopHandle() {
        return this.sweepLoop;
    }
    async loadBrokers() {
        const brokersQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase.from('broker_accounts').select('*').or('fxsocket_account_id.neq.,metaapi_account_id.neq.'));
        if (!brokersQ) {
            this.brokersByUser.clear();
            this.brokersById.clear();
            return;
        }
        const { data, error } = await brokersQ;
        if (error) {
            console.error('[tradeExecutor] loadBrokers failed:', error.message);
            return;
        }
        const brokerRows = (data ?? []);
        const brokerIds = brokerRows.map(row => row.id);
        const tableConfigRows = await (0, brokerChannelTradingConfigs_1.fetchBrokerChannelTradingConfigRows)(this.supabase, brokerIds);
        const configsByBroker = new Map();
        for (const cfgRow of tableConfigRows) {
            const list = configsByBroker.get(cfgRow.broker_account_id) ?? [];
            list.push(cfgRow);
            configsByBroker.set(cfgRow.broker_account_id, list);
        }
        this.brokersByUser.clear();
        this.brokersById.clear();
        this.brokerActivatedAt.clear();
        this.userTimezoneById.clear();
        const userIds = [...new Set(brokerRows.map(r => r.user_id).filter(Boolean))];
        if (userIds.length) {
            const { data: profiles } = await this.supabase
                .from('user_profiles')
                .select('user_id,timezone,copier_paused')
                .in('user_id', userIds);
            (0, copierPause_1.primeCopierPauseCache)(profiles ?? []);
            for (const p of profiles ?? []) {
                const uid = String(p.user_id ?? '');
                const tz = String(p.timezone ?? 'UTC').trim() || 'UTC';
                if (uid)
                    this.userTimezoneById.set(uid, tz);
            }
        }
        for (const row of brokerRows) {
            if (!(0, helpers_2.brokerHasLinkedSession)(row))
                continue;
            const tableRows = configsByBroker.get(row.id) ?? [];
            const mergedRow = tableRows.length
                ? {
                    ...row,
                    channel_trading_configs: (0, brokerChannelTradingConfigs_1.mergeChannelTradingConfigsFromTable)(row.channel_trading_configs, tableRows),
                }
                : row;
            const normalized = this.normalizeBrokerRow(mergedRow);
            this.brokersById.set(row.id, normalized);
            if (normalized.is_active) {
                const arr = this.brokersByUser.get(row.user_id) ?? [];
                arr.push(normalized);
                this.brokersByUser.set(row.user_id, arr);
                this.trackBrokerActivation(normalized);
            }
        }
        const api = (0, fxsocketClient_1.getFxsocketClient)();
        if (api) {
            for (const broker of this.brokersById.values()) {
                const sessionId = (0, helpers_2.brokerSessionUuid)(broker);
                if (sessionId)
                    api.seedPlatformCache(sessionId, (0, fxsocketClient_1.mtPlatformFrom)(broker.platform));
            }
        }
        console.log(`[tradeExecutor] cached ${this.brokersById.size} broker accounts across ${this.brokersByUser.size} users`);
        const pingOnStart = String(process.env.BROKER_PING_ON_WORKER_START ?? 'true').toLowerCase();
        if (pingOnStart !== 'false' && pingOnStart !== '0') {
            await this.reconnectCachedBrokers();
        }
    }
    prewarmSymbolsEnabled() {
        return brokerSymbolCache.prewarmSymbolsEnabled(this);
    }
    async prewarmBrokerCaches() {
        return await brokerSymbolCache.prewarmBrokerCaches(this);
    }
    async sessionHeartbeatTick() {
        return await brokerSymbolCache.sessionHeartbeatTick(this);
    }
    async runSessionHeartbeatTick() {
        if (this.sessionHeartbeatInFlight) {
            this.sessionHeartbeatSkipped += 1;
            if (this.sessionHeartbeatSkipped <= 3 || this.sessionHeartbeatSkipped % 20 === 0) {
                console.warn(`[tradeExecutor] heartbeat tick skipped; previous sweep still running (skipped=${this.sessionHeartbeatSkipped})`);
            }
            return;
        }
        this.sessionHeartbeatInFlight = true;
        try {
            await this.sessionHeartbeatTick();
        }
        finally {
            this.sessionHeartbeatInFlight = false;
            this.sessionHeartbeatSkipped = 0;
        }
    }
    /**
     * Re-fetch every entry currently in `symbolListCache` and `symbolCache` so
     * the next live signal hits a warm cache. Force-bypasses the TTL guard by
     * clearing `loadedAt`; the on-demand fetch will repopulate. Background
     * only — never blocks a signal.
     */
    async symbolCacheKeepaliveTick() {
        return await brokerSymbolCache.symbolCacheKeepaliveTick(this);
    }
    async reconnectCachedBrokers() {
        return await brokerSymbolCache.reconnectCachedBrokers(this);
    }
    applyBrokerCacheRow(row) {
        const normalized = this.normalizeBrokerRow(row);
        const sessionId = (0, helpers_2.brokerSessionUuid)(normalized);
        if (sessionId)
            (0, fxsocketClient_1.getFxsocketClient)()?.seedPlatformCache(sessionId, (0, fxsocketClient_1.mtPlatformFrom)(normalized.platform));
        const previous = this.brokersById.get(row.id);
        const wasSessionDown = Boolean(previous
            && (previous.connection_status === 'error'
                || this.sessionOrderBlocked.has(row.id)));
        this.brokersById.set(row.id, normalized);
        if (normalized.connection_status === 'connected') {
            this.sessionOrderBlocked.delete(row.id);
            if (wasSessionDown) {
                void (0, brokerSignalReplay_1.replayParsedSignalsForBroker)(this, normalized);
            }
        }
        this.trackBrokerActivation(normalized, previous);
        const userId = row.user_id;
        const list = (this.brokersByUser.get(userId) ?? []).filter(b => b.id !== row.id);
        if (normalized.is_active)
            list.push(normalized);
        this.brokersByUser.set(userId, list);
        if (previous && previous.user_id !== userId) {
            const prev = (this.brokersByUser.get(previous.user_id) ?? []).filter(b => b.id !== row.id);
            this.brokersByUser.set(previous.user_id, prev);
        }
    }
    async mergeBrokerRowWithTableConfigs(row) {
        const tableRows = await (0, brokerChannelTradingConfigs_1.fetchBrokerChannelTradingConfigRows)(this.supabase, [row.id]);
        if (!tableRows.length)
            return row;
        return {
            ...row,
            channel_trading_configs: (0, brokerChannelTradingConfigs_1.mergeChannelTradingConfigsFromTable)(row.channel_trading_configs, tableRows),
        };
    }
    upsertBrokerCache(row) {
        if (!(0, workerConfig_1.userBelongsToShard)(row.user_id))
            return;
        void this.mergeBrokerRowWithTableConfigs(row)
            .then(merged => this.applyBrokerCacheRow(merged))
            .catch(err => {
            console.error('[tradeExecutor] upsertBrokerCache table config merge failed:', err);
            this.applyBrokerCacheRow(row);
        });
    }
    removeBrokerCache(id) {
        const row = this.brokersById.get(id);
        if (!row)
            return;
        this.brokersById.delete(id);
        const list = (this.brokersByUser.get(row.user_id) ?? []).filter(b => b.id !== id);
        this.brokersByUser.set(row.user_id, list);
        this.brokerActivatedAt.delete(id);
    }
    /**
     * Maintain `brokerActivatedAt` so the executor can reject signals that
     * pre-date a reactivation. Prefers the DB-persisted `last_activated_at`
     * column (set by the `broker_accounts_stamp_activated_at` trigger) so the
     * value survives worker restarts. Falls back to `Date.now()` if the row
     * lacks the field but is currently active.
     */
    trackBrokerActivation(current, previous) {
        if (!current.is_active)
            return;
        const dbStampMs = current.last_activated_at
            ? Date.parse(current.last_activated_at)
            : NaN;
        if (Number.isFinite(dbStampMs)) {
            this.brokerActivatedAt.set(current.id, dbStampMs);
            return;
        }
        // Trigger missing (e.g. older DB): treat any false→true flip as a fresh
        // activation and otherwise leave any existing memory value intact.
        if (previous && previous.is_active === false) {
            this.brokerActivatedAt.set(current.id, Date.now());
        }
        else if (!this.brokerActivatedAt.has(current.id)) {
            this.brokerActivatedAt.set(current.id, Date.now());
        }
    }
    /** True iff the signal was created AFTER this broker was last reactivated. */
    brokerEligibleForSignal(broker, signal) {
        return dispatch.brokerEligibleForSignal(this, broker, signal);
    }
    // ── realtime ──────────────────────────────────────────────────────────
    subscribeSignals() {
        if (!workerConfig_1.workerConfig.tradeExecutorRealtime) {
            return;
        }
        if (this.signalsChannel)
            return;
        this.signalsChannel = this.supabase
            .channel('trade_executor_signals')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'signals' }, (payload) => {
            const row = payload.new;
            if (!row)
                return;
            if (!(0, workerConfig_1.userBelongsToShard)(row.user_id))
                return;
            if (!types_1.PARSED_STATUSES.has(row.status))
                return;
            this.enqueueSignal(row, { source: 'realtime' });
        })
            .subscribe();
    }
    subscribeBrokers() {
        if (this.brokersChannel)
            return;
        this.brokersChannel = this.supabase
            .channel('trade_executor_brokers')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'broker_accounts' }, (payload) => {
            const evt = payload.eventType;
            if (evt === 'DELETE') {
                const id = (payload.old?.id ?? '');
                if (id)
                    this.removeBrokerCache(id);
                return;
            }
            const row = payload.new;
            if (!row)
                return;
            if (!(0, workerConfig_1.userBelongsToShard)(row.user_id))
                return;
            if (!(0, helpers_2.brokerHasLinkedSession)(row)) {
                this.removeBrokerCache(row.id);
                return;
            }
            this.upsertBrokerCache(row);
            if (row.is_active) {
                void this.pingBrokerSession(row);
            }
        })
            .subscribe();
    }
    subscribeUserProfilesCopierPause() {
        if (this.userProfilesChannel)
            return;
        this.userProfilesChannel = this.supabase
            .channel('trade_executor_user_profiles_copier_pause')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_profiles' }, (payload) => {
            const row = payload.new;
            if (!row)
                return;
            const userId = String(row.user_id ?? '');
            if (!userId || !(0, workerConfig_1.userBelongsToShard)(userId))
                return;
            const copierPaused = row.copier_paused === true;
            const previousPaused = payload.old?.copier_paused === true;
            (0, copierPause_1.applyCopierPauseProfileUpdate)(userId, copierPaused, previousPaused);
        })
            .subscribe();
    }
    subscribeChannelTradingConfigs() {
        if (this.channelTradingConfigsChannel)
            return;
        this.channelTradingConfigsChannel = this.supabase
            .channel('trade_executor_broker_channel_configs')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'broker_channel_trading_configs' }, (payload) => {
            const evt = payload.eventType;
            if (evt === 'DELETE') {
                const brokerId = String(payload.old?.broker_account_id ?? '');
                if (!brokerId)
                    return;
                const cached = this.brokersById.get(brokerId);
                if (!cached)
                    return;
                void this.mergeBrokerRowWithTableConfigs(cached)
                    .then(merged => this.applyBrokerCacheRow(merged))
                    .catch(err => {
                    console.error('[tradeExecutor] channel config delete refresh failed:', err);
                });
                return;
            }
            const row = payload.new;
            if (!row?.broker_account_id)
                return;
            const cached = this.brokersById.get(row.broker_account_id);
            if (!cached)
                return;
            this.applyBrokerCacheRow((0, brokerChannelTradingConfigs_1.applyBrokerChannelTradingConfigRow)(cached, row));
        })
            .subscribe();
    }
    subscribeChannelKeywords() {
        if (this.channelsChannel)
            return;
        this.channelsChannel = this.supabase
            .channel('trade_executor_channels')
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'telegram_channels' }, (payload) => {
            const row = payload.new;
            if (!row?.id)
                return;
            // Drop cache so the next signal refetches display name + keywords.
            this.channelMetaCache.delete(row.id);
            (0, channelKeywordsCache_1.invalidateChannelParseCache)(row.id);
        })
            .subscribe();
    }
    async sweep() {
        const since = new Date(Date.now() - types_1.EXECUTOR_REPLAY_MAX_AGE_MS).toISOString();
        const signalsQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('signals')
            .select('id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id')
            .eq('status', 'parsed')
            .gte('created_at', since)
            .limit(50));
        if (!signalsQ)
            return;
        const { data } = await signalsQ;
        for (const row of (data ?? [])) {
            if (this.inflight.has(row.id))
                continue;
            if (await this.signalAlreadyHandled(row.id)) {
                await this.markSignalExecuted(row.id);
                continue;
            }
            this.enqueueSignal(row, { source: 'sweep' });
        }
    }
    /**
     * HTTP push from listener (split deploy) or in-process callback after parse.
     */
    acceptDispatchSignal(row, opts) {
        if (!types_1.PARSED_STATUSES.has(row.status))
            return false;
        if (!(0, tradeSignalActions_1.signalMatchesExecutorMode)(row.parsed_data, workerConfig_1.workerConfig.tradeExecutorMode)) {
            return false;
        }
        const source = opts?.source ?? 'dispatch';
        const receivedAt = Date.now();
        const rowWithTs = {
            ...row,
            pipeline_ts: {
                ...((0, pipelineTimestamps_1.parsePipelineTimestamps)(row.pipeline_ts) ?? {}),
                t_dispatch_received: receivedAt,
            },
        };
        // Start broker caches warming the instant we accept dispatch — even before
        // we know which brokers will actually trade this signal. With SWR caches
        // this is sub-ms for warm symbols and starts the broker round-trip
        // immediately for cold ones, so sendOrder's Promise.all is mostly a
        // cache hit by the time it runs.
        this.prewarmForDispatch(rowWithTs);
        const entryFast = this.shouldUseEntryFastPath(rowWithTs);
        const mgmtFast = dispatch.shouldUseMgmtFastPath(rowWithTs, source);
        const useFastPath = entryFast || mgmtFast;
        if (entryFast)
            this.kickLiveEntryPrewarm(rowWithTs);
        const listenerTs = (0, pipelineTimestamps_1.parsePipelineTimestamps)(rowWithTs.pipeline_ts);
        if (source === 'listener_push'
            && !listenerTs?.t_listener_received) {
            console.warn(`[tradeExecutor] listener_push missing pipeline_ts listener stamps signal=${row.id}`
                + ' — redeploy listener service (LISTENER_INLINE_PARSE + pipeline_ts on dispatch)');
        }
        if (!useFastPath) {
            void this.logPipelineStage(rowWithTs, 'dispatch_received', { source, priority: opts?.priority ?? null });
        }
        if (useFastPath) {
            if (this.inflight.has(row.id) || this.queuedIds.has(row.id))
                return true;
            void this.handleSignal(rowWithTs, {
                liveDispatch: true,
                dispatchSource: source,
                dispatchReceivedAt: receivedAt,
                lightIdempotency: true,
            });
            return true;
        }
        this.enqueueSignal(rowWithTs, {
            liveDispatch: true,
            priority: opts?.priority,
            source,
            dispatchReceivedAt: receivedAt,
        });
        return true;
    }
    /**
     * Redis Streams consumer path: await execution before XACK (at-least-once safety).
     * Bypasses the in-process priority queue — the stream is the queue.
     */
    async acceptDispatchSignalAwait(row, opts) {
        if (!types_1.PARSED_STATUSES.has(row.status))
            return false;
        if (!(0, tradeSignalActions_1.signalMatchesExecutorMode)(row.parsed_data, workerConfig_1.workerConfig.tradeExecutorMode)) {
            return false;
        }
        const source = opts?.source ?? 'queue';
        const receivedAt = Date.now();
        const rowWithTs = {
            ...row,
            pipeline_ts: {
                ...((0, pipelineTimestamps_1.parsePipelineTimestamps)(row.pipeline_ts) ?? {}),
                t_dispatch_received: receivedAt,
            },
        };
        this.prewarmForDispatch(rowWithTs);
        const entryFast = this.shouldUseEntryFastPath(rowWithTs);
        const mgmtFast = dispatch.shouldUseMgmtFastPath(rowWithTs, source);
        const useFastPath = entryFast || mgmtFast;
        if (entryFast)
            this.kickLiveEntryPrewarm(rowWithTs);
        if (!useFastPath) {
            await this.logPipelineStage(rowWithTs, 'dispatch_received', { source, priority: opts?.priority ?? null });
        }
        if (this.inflight.has(row.id)) {
            if (source === signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE) {
                await dispatch.waitForSignalInflightClear(this, row.id, dispatch.revisionInflightWaitMs(rowWithTs, source));
            }
            else {
                return true;
            }
        }
        await this.handleSignal(rowWithTs, {
            liveDispatch: true,
            dispatchSource: source,
            dispatchReceivedAt: receivedAt,
            lightIdempotency: useFastPath,
        });
        return true;
    }
    /**
     * In-process fast path (monolith). Live buy/sell bypass the queue when role allows.
     */
    dispatchParsedSignal(row) {
        return this.acceptDispatchSignal(row, {
            priority: (0, tradeSignalActions_1.dispatchPriorityForAction)((0, tradeSignalActions_1.parsedAction)(row.parsed_data)),
            source: 'in_process',
        });
    }
    shouldUseMgmtFastPath(row, source) {
        return dispatch.shouldUseMgmtFastPath(row, source);
    }
    shouldUseEntryFastPath(row) {
        return dispatch.shouldUseEntryFastPath(this, row);
    }
    enqueueSignal(row, opts) {
        return dispatch.enqueueSignal(this, row, opts);
    }
    scheduleQueueDrain() {
        return dispatch.scheduleQueueDrain(this);
    }
    dequeueQueuedSignal() {
        return dispatch.dequeueQueuedSignal(this);
    }
    async drainSignalQueues() {
        return await dispatch.drainSignalQueues(this);
    }
    async logPipelineStage(signal, action, payload) {
        return await dispatch.logPipelineStage(this, signal, action, payload);
    }
    /** Visible in Channel Worker when trade dispatch is skipped (no silent failures). */
    async logDispatchSkipped(signal, skipReason, extra) {
        return await dispatch.logDispatchSkipped(this, signal, skipReason, extra);
    }
    logPipelineSummaryBackground(signal, extra) {
        return dispatch.logPipelineSummaryBackground(this, signal, extra);
    }
    async markSignalExecuted(signalId) {
        return await dispatch.markSignalExecuted(this, signalId);
    }
    /**
     * Live entry idempotency: must include virtual range ladder state, not only trades.
     * A re-dispatch while legs are still `pending` would insert duplicate rungs (fired
     * rows no longer block the partial unique index) and machine-gun market orders.
     */
    async signalLiveDispatchAlreadyHandled(signalId) {
        return await dispatch.signalLiveDispatchAlreadyHandled(this, signalId);
    }
    /** True when this signal row already drove execution (trades, virtuals, or success logs). */
    async signalAlreadyHandled(signalId) {
        return await dispatch.signalAlreadyHandled(this, signalId);
    }
    signalTooOldForReplay(row) {
        return dispatch.signalTooOldForReplay(this, row);
    }
    // ── execution ─────────────────────────────────────────────────────────
    claimSignalExecution(signalId) {
        return dispatch.claimSignalExecution(this, signalId);
    }
    async handleSignal(row, opts) {
        return await dispatch.handleSignal(this, row, opts);
    }
    async getChannelMeta(channelId) {
        return await dispatch.getChannelMeta(this, channelId);
    }
    async hasOpenTradeForSymbol(brokerId, symbol) {
        return await basketMerge.hasOpenTradeForSymbol(this, brokerId, symbol);
    }
    /**
     * When DB shows open legs but /OpenedOrders has none of their tickets, close stale rows
     * so merge/modify paths do not block new OrderSend.
     */
    async reconcileGhostBasketLegs(args) {
        return await basketMerge.reconcileGhostBasketLegs(this, args);
    }
    /**
     * Walk `signals.parent_signal_id` from the merge row's immediate parent upward.
     * True if `anchorSignalId` appears (multi-hop Telegram reply threads where
     * `parent_signal_id` points at an intermediate signal, not the basket anchor).
     */
    async parentSignalIdChainContainsAnchor(startParentId, anchorSignalId) {
        return await basketMerge.parentSignalIdChainContainsAnchor(this, startParentId, anchorSignalId);
    }
    /**
     * Resolve which `signals.id` owns open `trades` for management and implicit merge.
     * Walks `parent_signal_id` upward first; falls back to same-channel + symbol disambiguation.
     */
    async resolveBasketAnchorSignalIdForOpenTrades(args) {
        return await basketMerge.resolveBasketAnchorSignalIdForOpenTrades(this, args);
    }
    async manualDispatchAlreadyMaterialized(signalId, brokerAccountId) {
        return await basketMerge.manualDispatchAlreadyMaterialized(this, signalId, brokerAccountId);
    }
    async cancelSignalEntryBrokerRowsForScope(scope, userId, logSignalId, reason) {
        return await basketMerge.cancelSignalEntryBrokerRowsForScope(this, scope, userId, logSignalId, reason);
    }
    async cancelRangePendingLegsForScopes(userId, logSignalId, scopes, reason) {
        return await basketMerge.cancelRangePendingLegsForScopes(this, userId, logSignalId, scopes, reason);
    }
    /**
     * Persist virtual ladder rows. Batch `upsert` can fail against a partial unique
     * index if PostgREST's conflict target does not match Postgres; fall back to
     * per-row `insert` and treat duplicate-key as success (idempotent retries).
     */
    async persistRangePendingLegRows(rows, context) {
        return await basketMerge.persistRangePendingLegRows(this, rows, context);
    }
    /**
     * Manual mode: when enabled, close every open trade on this symbol that faces
     * the opposite way from the **channel** buy/sell (before reverse / planner flip).
     */
    async closeOppositeDirectionTrades(signal, parsed, broker, symbol) {
        return await basketMerge.closeOppositeDirectionTrades(this, signal, parsed, broker, symbol);
    }
    /** Realtime payloads may omit reply/parent fields — load authoritative signal row for merge linking. */
    async loadMergeSignalForLinking(signal) {
        return await basketMerge.loadMergeSignalForLinking(this, signal);
    }
    async resolveBasketMergeLinkContext(args) {
        return await basketMerge.resolveBasketMergeLinkContext(this, args);
    }
    /**
     * Parameter follow-up (SL/TP on a linked prior entry): refresh the latest open basket.
     * Fresh one-shot entries with SL/TP skip this path and use OrderSend.
     */
    async tryParameterFollowUpMergeModifyOnly(args) {
        return await basketMerge.tryParameterFollowUpMergeModifyOnly(this, args);
    }
    async tryTeaserCompletionMerge(args) {
        return await basketMerge.tryTeaserCompletionMerge(this, args);
    }
    /**
     * After parallel multi immediates, re-apply per-leg TPs (Targets %) in case the
     * broker accepted orders but normalized every leg to the same TP.
     */
    async syncMultiBasketLegTakeProfits(args) {
        return await basketMerge.syncMultiBasketLegTakeProfits(this, args);
    }
    /**
     * OrderModify every open leg in the basket + refresh range ladder rows. No OrderSend.
     */
    async applyBasketSlTpRefresh(args) {
        return await basketMerge.applyBasketSlTpRefresh(this, args);
    }
    /**
     * When `add_new_trades_to_existing` is on, apply a same-direction follow-up
     * (Telegram reply to the anchor entry, reply to a thread whose parent chain
     * reaches the anchor, or time window with direct `parent_signal_id` → anchor)
     * as SL/TP refresh on all open legs of the basket (`signal_id` family).
     */
    async tryMergeSignalIntoExistingOpenTrade(args) {
        return await basketMerge.tryMergeSignalIntoExistingOpenTrade(this, args);
    }
    async sweepExpiredTscopierBrokerPendings() {
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
            return;
        if (String(process.env.WORKER_BROKER_PENDING_EXPIRY_SWEEP ?? '').toLowerCase() !== 'true')
            return;
        const brokers = Array.from(this.brokersById.values()).filter(b => b.is_active && (0, helpers_2.isMtUuid)(b.metaapi_account_id) && (b.copier_mode ?? 'ai') === 'manual');
        if (!brokers.length)
            return;
        const now = Date.now();
        for (const broker of brokers) {
            const manual = (broker.manual_settings ?? {});
            const ttlH = (0, manualPlanner_1.clampPendingExpiryHours)(manual.pending_expiry_hours);
            if (ttlH <= 0)
                continue;
            const uuid = broker.metaapi_account_id;
            const api = this.apiFor(broker);
            if (!api)
                continue;
            let orders;
            try {
                orders = await api.openedOrders(uuid);
            }
            catch (err) {
                console.warn(`[tradeExecutor] TTL sweep /OpenedOrders failed broker=${broker.id}: ${err.message}`);
                continue;
            }
            const cutoff = now - ttlH * 3600000;
            for (const raw of orders ?? []) {
                if (!raw || typeof raw !== 'object')
                    continue;
                const o = raw;
                const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '');
                const comment = String(o.comment ?? o.Comment ?? '');
                const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0);
                if (!operation.includes('Limit') && !operation.includes('Stop'))
                    continue;
                if (!comment.startsWith('TSCopier:'))
                    continue;
                if (!Number.isFinite(ticket) || ticket <= 0)
                    continue;
                const openMs = (0, helpers_2.brokerOrderOpenMs)(o);
                if (openMs == null || openMs > cutoff)
                    continue;
                try {
                    await api.orderClose(uuid, { ticket });
                    console.log(`[tradeExecutor] TTL sweep closed ticket=${ticket} broker=${broker.id} op=${operation} ttl_hours=${ttlH}`);
                }
                catch (err) {
                    console.warn(`[tradeExecutor] TTL sweep close failed ticket=${ticket} broker=${broker.id}: ${err.message}`);
                }
            }
        }
    }
    async markBrokerSessionDown(broker, uuid, reason) {
        return await brokerSymbolCache.markBrokerSessionDown(this, broker, uuid, reason);
    }
    async pingBrokerSession(row) {
        return await brokerSymbolCache.pingBrokerSession(this, row);
    }
    async ensureBrokerSession(api, uuid, broker, opts) {
        return await brokerSymbolCache.ensureBrokerSession(this, api, uuid, broker, opts);
    }
    /** Live entry: CheckConnect only (not AccountSummary+OpenedOrders). Deduped per uuid. */
    async ensureBrokerSessionLiveFast(api, uuid, broker) {
        return await brokerSymbolCache.ensureBrokerSessionLiveFast(this, api, uuid, broker);
    }
    /**
     * Synchronous warm-cache check used to decide whether to block on prewarm.
     * Returns true only when every broker has a recent session ping AND both
     * the broker's symbol list and the requested symbol's params are cached.
     * Inflight-but-not-yet-resolved entries count as cold so we still kick
     * off prewarm (in the background).
     */
    brokersWarmForLiveEntry(brokers, signalSymbol) {
        return brokerSymbolCache.brokersWarmForLiveEntry(this, brokers, signalSymbol);
    }
    /**
     * Fire-and-forget warm-up issued the instant a dispatch is accepted.
     * Touches `getSymbolParams` / `getSymbolList` for every broker that could
     * possibly handle the signal so by the time `sendOrder` runs the broker
     * round-trip is already in flight (or done). With SWR caches this is a
     * no-op for warm symbols.
     *
     * Scalability: bounded by `brokersByUser[userId].length`, which is the user's
     * own connected MT count. It does NOT scale with the total number of users
     * or channels in the system — every signal touches only its own user's
     * brokers.
     */
    prewarmForDispatch(row) {
        return brokerSymbolCache.prewarmForDispatch(this, row);
    }
    /** Session + symbol cache warmup for channel-matched brokers on the live fast path. */
    kickLiveEntryPrewarm(row) {
        const parsed = row.parsed_data;
        const signalSymbol = parsed?.symbol?.trim();
        if (!signalSymbol)
            return;
        const warmBrokers = (this.brokersByUser.get(row.user_id) ?? []).filter(b => b.is_active && (0, helpers_2.isMtUuid)(b.metaapi_account_id) && (0, brokerChannelFilter_1.channelMatchesBrokerSignal)(b, row.channel_id));
        if (warmBrokers.length > 0) {
            void this.prewarmBrokersForLiveEntry(warmBrokers, signalSymbol);
        }
    }
    /** Warm session + symbol caches once per live signal before OrderSend. */
    async prewarmBrokersForLiveEntry(brokers, signalSymbol) {
        return await brokerSymbolCache.prewarmBrokersForLiveEntry(this, brokers, signalSymbol);
    }
    async sendOrder(signal, parsed, op, broker, channelKeywords, pipelineT0, sendOpts) {
        const configReady = (0, channelTradingConfig_1.channelConfigReadyForExecution)(broker, signal.channel_id);
        if (!configReady.ready) {
            console.warn(`[tradeExecutor] sendOrder blocked signal=${signal.id} broker=${broker.id}`
                + ` channel=${signal.channel_id ?? 'none'} reason=${configReady.reason}`);
            await this.logSendSkipped(signal, broker, configReady.reason, {
                channel_id: signal.channel_id ?? null,
            });
            return { openedOrMerged: false, finalizeSkipReason: configReady.reason };
        }
        let executionBroker = broker;
        if (signal.channel_id) {
            const fresh = await (0, brokerChannelTradingConfigs_1.fetchFreshBrokerForChannel)(this.supabase, broker, signal.channel_id);
            if (fresh.channel_trading_configs !== broker.channel_trading_configs) {
                this.applyBrokerCacheRow(fresh);
                executionBroker = this.brokersById.get(broker.id) ?? fresh;
            }
        }
        const effectiveBroker = (0, channelTradingConfig_1.withChannelTradingConfig)(executionBroker, signal.channel_id);
        const resolved = (0, channelTradingConfig_1.resolveChannelTradingConfig)(executionBroker, signal.channel_id);
        const entryKey = `${signal.id}:${effectiveBroker.id}`;
        const liveFast = sendOpts?.liveEntryFast === true;
        if (!liveFast) {
            if (await (0, helpers_1.manualDispatchAlreadyMaterialized)(this, signal.id, effectiveBroker.id)) {
                console.warn(`[tradeExecutor] skip already materialized signal=${signal.id} broker=${effectiveBroker.id}`);
                return { openedOrMerged: true };
            }
        }
        const isRevisionRefresh = sendOpts?.sameSignalRefresh === true;
        if (this.entryBrokerInflight.has(entryKey)) {
            if (isRevisionRefresh) {
                const deadline = Date.now() + 60000;
                while (this.entryBrokerInflight.has(entryKey) && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            else {
                const materialized = liveFast
                    ? true
                    : await (0, helpers_1.manualDispatchAlreadyMaterialized)(this, signal.id, effectiveBroker.id);
                console.warn(`[tradeExecutor] skip duplicate in-flight sendOrder signal=${signal.id} broker=${effectiveBroker.id}`
                    + ` materialized=${materialized}`);
                return { openedOrMerged: materialized };
            }
        }
        this.entryBrokerInflight.add(entryKey);
        try {
            if (!isRevisionRefresh) {
                const claimed = await (0, signalBrokerDispatchClaim_1.claimSignalBrokerDispatch)(this.supabase, signal.id, effectiveBroker.id);
                if (!claimed) {
                    const materialized = await (0, helpers_1.manualDispatchAlreadyMaterialized)(this, signal.id, effectiveBroker.id);
                    console.warn(`[tradeExecutor] skip duplicate dispatch claim signal=${signal.id} broker=${effectiveBroker.id}`
                        + ` materialized=${materialized}`);
                    return { openedOrMerged: materialized };
                }
            }
            const ms = resolved.manual_settings;
            console.log(`[tradeExecutor] sendOrder signal=${signal.id} broker=${effectiveBroker.id}`
                + ` channel=${signal.channel_id ?? 'none'} source=${resolved.config_source}`
                + ` style=${String(ms.trade_style ?? 'single')} fixed_lot=${String(ms.fixed_lot ?? 'missing')}`
                + ` range_trading=${ms.range_trading === true}`);
            const isManual = (effectiveBroker.copier_mode ?? 'ai') === 'manual';
            const manual = (effectiveBroker.manual_settings ?? {});
            if (isManual && manual.trade_style === 'multi') {
                return await (0, rangeTradeExecutor_1.runRangeEntry)(this, { signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0, sendOpts });
            }
            return await (0, singleEntryExecutor_1.runSingleEntry)(this, { signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0, sendOpts });
        }
        finally {
            this.entryBrokerInflight.delete(entryKey);
        }
    }
    async logSendSkipped(signal, broker, reason, extra) {
        return await managementExecutor.logSendSkipped(this, signal, broker, reason, extra);
    }
    async skipMgmtSignal(signalId, reason) {
        return await managementExecutor.skipMgmtSignal(this, signalId, reason);
    }
    async applyManagement(signal, parsed, brokers, mgmtOpts) {
        return await managementExecutor.applyManagement(this, signal, parsed, brokers, mgmtOpts);
    }
    /**
     * Telegram "Close worse entries": close open basket legs whose entry is within
     * `close_worse_entries_pips` of the live quote at instruction time.
     */
    async applyCloseWorseEntriesInstruction(signal, parsed, rows, byBroker, mgmtOpts) {
        return await managementExecutor.applyCloseWorseEntriesInstruction(this, signal, parsed, rows, byBroker, mgmtOpts);
    }
    /**
     * One-time cleanup of broker-side BuyLimit/SellLimit orders left over from
     * the pre-virtual-pendings era. Filters by our `TSCopier:` comment prefix so
     * we never touch orders placed by the user manually or other systems.
     *
     * Gated by env flag `WORKER_LEGACY_PENDING_CLEANUP=true`. Safe to leave on
     * indefinitely — it becomes a no-op once the legacy pendings are gone.
     */
    async cleanupLegacyBrokerPendings() {
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
            return;
        const brokers = Array.from(this.brokersById.values()).filter(b => b.is_active && (0, helpers_2.isMtUuid)(b.metaapi_account_id));
        if (!brokers.length)
            return;
        console.log(`[tradeExecutor] legacy pending cleanup: scanning ${brokers.length} brokers...`);
        let totalClosed = 0;
        let totalFailed = 0;
        for (const broker of brokers) {
            const uuid = broker.metaapi_account_id;
            const api = this.apiFor(broker);
            if (!api)
                continue;
            let orders;
            try {
                orders = await api.openedOrders(uuid);
            }
            catch (err) {
                console.warn(`[tradeExecutor] legacy cleanup /OpenedOrders failed broker=${broker.id}: ${err.message}`);
                continue;
            }
            for (const raw of orders ?? []) {
                if (!raw || typeof raw !== 'object')
                    continue;
                const o = raw;
                const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '');
                const comment = String(o.comment ?? o.Comment ?? '');
                const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0);
                if (!operation.includes('Limit') && !operation.includes('Stop'))
                    continue;
                if (!comment.startsWith('TSCopier:'))
                    continue;
                if (!Number.isFinite(ticket) || ticket <= 0)
                    continue;
                try {
                    await api.orderClose(uuid, { ticket });
                    totalClosed += 1;
                    console.log(`[tradeExecutor] legacy cleanup closed ticket=${ticket} broker=${broker.id} op=${operation}`);
                }
                catch (err) {
                    totalFailed += 1;
                    console.warn(`[tradeExecutor] legacy cleanup close failed ticket=${ticket} broker=${broker.id}: ${err.message}`);
                }
            }
        }
        console.log(`[tradeExecutor] legacy pending cleanup done: closed=${totalClosed} failed=${totalFailed}`);
    }
    async getSymbolParams(uuid, symbol) {
        return await brokerSymbolCache.getSymbolParams(this, uuid, symbol);
    }
    /**
     * Force-refresh a single symbol params entry. Coalesces concurrent callers
     * (background refreshers + live-path lookups) via `symbolParamsInflight` so
     * we never duplicate broker API calls for the same `(uuid, symbol)` pair.
     */
    async refreshSymbolParams(uuid, symbol, key) {
        return await brokerSymbolCache.refreshSymbolParams(this, uuid, symbol, key);
    }
    /**
     * Load (and cache) the broker's full symbol list. Returns null if unavailable.
     * Stale-while-revalidate: live path returns the cached value immediately if
     * present and kicks off a background refresh when stale.
     */
    async getSymbolList(uuid) {
        return await brokerSymbolCache.getSymbolList(this, uuid);
    }
    async fetchSymbolList(uuid) {
        return await brokerSymbolCache.fetchSymbolList(this, uuid);
    }
    resolveBrokerSymbolFromInventory(inventory, requested, opts) {
        return brokerSymbolCache.resolveBrokerSymbolFromInventory(this, inventory, requested, opts);
    }
    async resolveBrokerSymbolForLiveEntry(uuid, requested, opts) {
        return await brokerSymbolCache.resolveBrokerSymbolForLiveEntry(this, uuid, requested, opts);
    }
    async deferredVirtualPendingMaterialize(args) {
        const { signal, broker, uuid, api, symbol, virtualPendings, parsed, plan, params, strictEntryPrefetch, } = args;
        let anchor = plan.anchor?.value ?? plan.strictEntry?.entryPrice ?? null;
        const parsedEntry = (0, manualPlanner_1.resolvedParsedEntryPrice)(parsed);
        if (parsedEntry != null && parsedEntry > 0) {
            anchor = parsedEntry;
        }
        else {
            try {
                const q = strictEntryPrefetch ?? await api.quote(uuid, symbol);
                anchor = plan.isBuy === false ? q.bid : q.ask;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[tradeExecutor] deferred virtual /Quote failed signal=${signal.id} broker=${broker.id}: ${msg}`);
                return;
            }
        }
        if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) {
            console.warn(`[tradeExecutor] deferred virtual: no anchor signal=${signal.id} broker=${broker.id}`);
            return;
        }
        const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5));
        const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0);
        const zoneHi = safe > 0 ? anchor + (safe + 2) * (params?.point ?? 0) : null;
        const zoneLo = safe > 0 ? anchor - (safe + 2) * (params?.point ?? 0) : null;
        const signalRangeBoundary = plan.rangeLayering?.signalRangeBoundary ?? null;
        const nowMs = Date.now();
        const insertRows = [];
        for (const v of virtualPendings) {
            const triggerPrice = (0, helpers_2.triggerPriceFor)(v, anchor, digits);
            if (!(0, helpers_2.virtualPendingTriggerAllowed)({
                triggerPrice,
                signalRangeBoundary,
                isBuy: v.isBuy,
                stopsZoneLo: zoneLo,
                stopsZoneHi: zoneHi,
            })) {
                continue;
            }
            const expiresAt = v.expiryHours && v.expiryHours > 0
                ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
                : null;
            insertRows.push({
                signal_id: signal.id,
                user_id: signal.user_id,
                broker_account_id: broker.id,
                metaapi_account_id: uuid,
                symbol,
                step_idx: v.stepIdx,
                is_buy: v.isBuy,
                volume: (0, helpers_2.roundLot)(v.volume, params),
                anchor_price: anchor,
                trigger_price: triggerPrice,
                stoploss: v.stoploss,
                takeprofit: v.takeprofit,
                slippage: v.slippage,
                comment: v.comment,
                expert_id: v.expertID ?? null,
                expires_at: expiresAt,
                status: 'pending',
                cwe_close_price: v.cweClosePrice ?? null,
            });
        }
        if (insertRows.length === 0)
            return;
        const persist = await this.persistRangePendingLegRows(insertRows, `deferred live signal=${signal.id} broker=${broker.id}`);
        if (!persist.ok) {
            console.error(`[tradeExecutor] deferred virtual persist failed signal=${signal.id} broker=${broker.id}: ${persist.lastError ?? 'unknown'}`);
        }
    }
    /**
     * Map a generic symbol (e.g. 'BTCUSD') to the exact instrument name the broker
     * exposes (e.g. 'BTCUSDm', 'BTCUSD.r', 'BTCUSD_i'). Strategy:
     *   1. Honour an explicit manual mapping when one exists for this symbol.
     *   2. Fall back to fuzzy matching against `/Symbols` using common broker suffixes
     *      and prefix/suffix substitution. Picks the shortest match (closest variant).
     */
    async resolveBrokerSymbol(uuid, requested, opts) {
        return await brokerSymbolCache.resolveBrokerSymbol(this, uuid, requested, opts);
    }
    async fetchCopyLimitState(brokerId, channelId) {
        const key = `${brokerId}:${(0, channelTradingConfig_2.normalizeChannelUuid)(channelId) ?? channelId}`;
        const hit = this.copyLimitStateCache.get(key);
        if (hit && Date.now() - hit.at < 20000)
            return hit.state;
        const channelKey = (0, channelTradingConfig_2.normalizeChannelUuid)(channelId);
        if (!channelKey)
            return { paused_period_keys: [], periods: {} };
        const { data, error } = await this.supabase
            .from('broker_channel_trading_configs')
            .select('copy_limit_state')
            .eq('broker_account_id', brokerId)
            .eq('channel_id', channelKey)
            .maybeSingle();
        if (error) {
            console.warn(`[tradeExecutor] fetchCopyLimitState failed: ${error.message}`);
        }
        const state = (0, copyLimitTypes_1.normalizeCopyLimitState)(data?.copy_limit_state);
        this.copyLimitStateCache.set(key, { state, at: Date.now() });
        return state;
    }
}
exports.TradeExecutor = TradeExecutor;
