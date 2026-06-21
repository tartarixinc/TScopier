"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalRangeEntryMonitor = void 0;
const fxsocketClient_1 = require("./fxsocketClient");
const pipCalculator_1 = require("./pipCalculator");
const mtApiByAccount_1 = require("./mtApiByAccount");
const copierPause_1 = require("./copierPause");
const monitorIdleGate_1 = require("./monitorIdleGate");
const signalRangeEntryHelpers_1 = require("./signalRangeEntryHelpers");
const signalRangeEntryService_1 = require("./signalRangeEntryService");
const channelTradingConfig_1 = require("./channelTradingConfig");
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('SIGNAL_RANGE_ENTRY_TICK_MS', 1000);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('SIGNAL_RANGE_ENTRY_IDLE_MS', 15000);
/**
 * Polls /Quote for virtual "Trade Signal Range Only" waits and re-dispatches when price
 * is inside the signal zone ± pip tolerance.
 */
class SignalRangeEntryMonitor {
    constructor(supabase, tradeExecutor) {
        this.supabase = supabase;
        this.tradeExecutor = tradeExecutor;
        this.loop = null;
        this.platformByUuid = new Map();
        this.ticking = false;
        this.wakeInflight = new Set();
    }
    start() {
        if (this.loop)
            return;
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)()) {
            console.warn('[signalRangeEntryMonitor] FxSocket not configured — monitor disabled');
            return;
        }
        this.loop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'signalRangeEntryMonitor',
            supabase: this.supabase,
            activeIntervalMs: ACTIVE_MS,
            idleIntervalMs: IDLE_MS,
            hasWork: sb => (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'signal_range_entry_waits', q => q.eq('status', 'waiting')),
            tick: () => this.runTick(),
        });
        console.log(`[signalRangeEntryMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`);
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
            await this.tickOnce();
        }
        finally {
            this.ticking = false;
        }
    }
    async tickOnce() {
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
            return;
        const rowsQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('signal_range_entry_waits')
            .select('*')
            .eq('status', 'waiting')
            .order('created_at', { ascending: true })
            .limit(200));
        if (!rowsQ)
            return;
        const { data, error } = await rowsQ;
        if (error) {
            console.error('[signalRangeEntryMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? []);
        if (!rows.length)
            return;
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByFxsocketId)(this.supabase, rows.map(r => r.metaapi_account_id));
        const now = Date.now();
        const active = [];
        for (const row of rows) {
            if ((0, copierPause_1.isUserCopierPausedCached)(row.user_id) || await (0, copierPause_1.loadCachedUserCopierPaused)(this.supabase, row.user_id)) {
                await (0, signalRangeEntryService_1.cancelWaitWithLog)(this.supabase, {
                    waitId: row.id,
                    signalId: row.signal_id,
                    userId: row.user_id,
                    brokerAccountId: row.broker_account_id,
                    reason: 'copier_paused',
                });
                continue;
            }
            if (row.expires_at && Date.parse(row.expires_at) <= now) {
                await (0, signalRangeEntryService_1.expireWait)(this.supabase, {
                    waitId: row.id,
                    signalId: row.signal_id,
                    userId: row.user_id,
                    brokerAccountId: row.broker_account_id,
                    reason: 'expired_ttl',
                    symbol: row.symbol,
                });
                continue;
            }
            active.push(row);
        }
        if (!active.length)
            return;
        const quoteGroups = new Map();
        for (const row of active) {
            const key = `${row.metaapi_account_id}:${row.symbol.toUpperCase()}`;
            const list = quoteGroups.get(key) ?? [];
            list.push(row);
            quoteGroups.set(key, list);
        }
        for (const [, group] of quoteGroups) {
            const sample = group[0];
            const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(this.platformByUuid, sample.metaapi_account_id);
            if (!api)
                continue;
            let bid;
            let ask;
            let pipSize = 0.00001;
            try {
                const q = await api.quote(sample.metaapi_account_id, sample.symbol);
                bid = q.bid;
                ask = q.ask;
                try {
                    const rawParams = await api.symbolParams(sample.metaapi_account_id, sample.symbol);
                    const normalized = (0, fxsocketClient_1.normalizeSymbolParams)(rawParams);
                    const point = normalized.point;
                    const digits = normalized.digits;
                    if (point != null && Number.isFinite(point) && point > 0) {
                        pipSize = (0, pipCalculator_1.pipCalculator)(sample.symbol, point, digits ?? 5, normalized.contractSize ?? null).pipPrice;
                    }
                }
                catch {
                    /* default pipSize */
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[signalRangeEntryMonitor] /Quote failed account=${sample.metaapi_account_id} symbol=${sample.symbol}: ${msg}`);
                continue;
            }
            for (const row of group) {
                if (this.wakeInflight.has(row.id))
                    continue;
                const { data: signalRow, error: sigErr } = await this.supabase
                    .from('signals')
                    .select('id,user_id,channel_id,parsed_data,user_override,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id')
                    .eq('id', row.signal_id)
                    .maybeSingle();
                if (sigErr || !signalRow?.parsed_data || signalRow.status !== 'parsed')
                    continue;
                const parsed = signalRow.parsed_data;
                const broker = this.tradeExecutor.lookupBroker(row.broker_account_id);
                let wait = (0, signalRangeEntryService_1.waitRowToPlannerWait)(row);
                if (broker) {
                    const manual = (0, channelTradingConfig_1.resolveChannelTradingConfig)(broker, signalRow.channel_id).manual_settings;
                    const syncResult = await (0, signalRangeEntryService_1.syncWaitRow)(this.supabase, {
                        signal: signalRow,
                        broker,
                        uuid: row.metaapi_account_id,
                        symbol: row.symbol,
                        parsed,
                        manual,
                        preserveExpiresAt: true,
                        logUpdates: true,
                    });
                    if (!syncResult.ok)
                        continue;
                    const freshWait = (0, signalRangeEntryService_1.buildWaitFromParsed)({
                        manual,
                        parsed,
                        isBuy: String(parsed.action ?? '').toLowerCase() !== 'sell',
                    });
                    if (freshWait)
                        wait = freshWait;
                }
                const stale = (0, signalRangeEntryService_1.evaluatePreEntryStaleness)({
                    parsed,
                    bid,
                    ask,
                    isBuy: row.is_buy,
                });
                if (stale.stale && stale.reason) {
                    await (0, signalRangeEntryService_1.expireWait)(this.supabase, {
                        waitId: row.id,
                        signalId: row.signal_id,
                        userId: row.user_id,
                        brokerAccountId: row.broker_account_id,
                        reason: stale.reason,
                        symbol: row.symbol,
                        bid,
                        ask,
                    });
                    continue;
                }
                if (!(0, signalRangeEntryService_1.evaluateWakeEligibility)({ wait, bid, ask, pipSize }))
                    continue;
                this.wakeInflight.add(row.id);
                try {
                    const dispatched = await this.tradeExecutor.acceptDispatchSignalAwait({
                        ...signalRow,
                        dispatch_source: signalRangeEntryHelpers_1.SIGNAL_RANGE_WAKE_DISPATCH_SOURCE,
                        wake_broker_account_id: row.broker_account_id,
                    }, {
                        source: signalRangeEntryHelpers_1.SIGNAL_RANGE_WAKE_DISPATCH_SOURCE,
                        priority: 'high',
                        wakeBrokerAccountId: row.broker_account_id,
                    });
                    if (!dispatched) {
                        console.warn(`[signalRangeEntryMonitor] wake dispatch rejected signal=${row.signal_id} broker=${row.broker_account_id}`);
                    }
                }
                finally {
                    this.wakeInflight.delete(row.id);
                }
            }
        }
    }
}
exports.SignalRangeEntryMonitor = SignalRangeEntryMonitor;
