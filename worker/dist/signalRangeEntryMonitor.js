"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalRangeEntryMonitor = void 0;
const fxsocketClient_1 = require("./fxsocketClient");
const pipCalculator_1 = require("./pipCalculator");
const parsedEntry_1 = require("./manualPlanning/parsedEntry");
const mtApiByAccount_1 = require("./mtApiByAccount");
const manualPlanner_1 = require("./manualPlanner");
const copierPause_1 = require("./copierPause");
const monitorIdleGate_1 = require("./monitorIdleGate");
const signalRangeEntryHelpers_1 = require("./signalRangeEntryHelpers");
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('SIGNAL_RANGE_ENTRY_TICK_MS', 2000);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('SIGNAL_RANGE_ENTRY_IDLE_MS', 60000);
/**
 * Polls /Quote for virtual "Use signal range" waits and re-dispatches when price
 * reaches the signal level or zone edge ± pip tolerance.
 */
class SignalRangeEntryMonitor {
    constructor(supabase, tradeExecutor) {
        this.supabase = supabase;
        this.tradeExecutor = tradeExecutor;
        this.loop = null;
        this.platformByUuid = new Map();
        this.ticking = false;
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
        const rows = (data ?? [])
            .filter(r => !(0, copierPause_1.isUserCopierPausedCached)(r.user_id));
        if (!rows.length)
            return;
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByFxsocketId)(this.supabase, rows.map(r => r.metaapi_account_id));
        const now = Date.now();
        const active = rows.filter(r => !r.expires_at || Date.parse(r.expires_at) > now);
        for (const row of rows) {
            if (row.expires_at && Date.parse(row.expires_at) <= now) {
                await this.supabase
                    .from('signal_range_entry_waits')
                    .update({ status: 'expired', updated_at: new Date().toISOString() })
                    .eq('id', row.id)
                    .eq('status', 'waiting');
            }
        }
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
                const wait = (0, signalRangeEntryHelpers_1.waitRowToPlannerWait)(row);
                const { data: signalZoneRow } = await this.supabase
                    .from('signals')
                    .select('parsed_data')
                    .eq('id', row.signal_id)
                    .maybeSingle();
                const freshZone = signalZoneRow?.parsed_data
                    ? (0, parsedEntry_1.resolvedParsedEntryZone)(signalZoneRow.parsed_data)
                    : null;
                if (freshZone) {
                    wait.zoneLo = freshZone.lo;
                    wait.zoneHi = freshZone.hi;
                    if (freshZone.lo !== row.zone_lo || freshZone.hi !== row.zone_hi) {
                        await this.supabase
                            .from('signal_range_entry_waits')
                            .update({
                            zone_lo: freshZone.lo,
                            zone_hi: freshZone.hi,
                            updated_at: new Date().toISOString(),
                        })
                            .eq('id', row.id)
                            .eq('status', 'waiting');
                    }
                }
                if (!(0, manualPlanner_1.signalRangeEntryQuoteAllowsImmediate)({ wait, bid, ask, pipSize }))
                    continue;
                const { data: claimed, error: claimErr } = await this.supabase
                    .from('signal_range_entry_waits')
                    .update({ status: 'fired', updated_at: new Date().toISOString() })
                    .eq('id', row.id)
                    .eq('status', 'waiting')
                    .select('id')
                    .maybeSingle();
                if (claimErr || !claimed)
                    continue;
                const { data: signalRow, error: sigErr } = await this.supabase
                    .from('signals')
                    .select('id,user_id,channel_id,parsed_data,user_override,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id')
                    .eq('id', row.signal_id)
                    .maybeSingle();
                if (sigErr || !signalRow || signalRow.status !== 'parsed')
                    continue;
                await (0, signalRangeEntryHelpers_1.logSignalRangeEntryFired)(this.supabase, signalRow, row.broker_account_id, wait, row.symbol);
                this.tradeExecutor.acceptDispatchSignal({ ...signalRow, dispatch_source: 'signal_range_wake' }, { source: 'signal_range_wake', priority: 'high' });
            }
        }
    }
}
exports.SignalRangeEntryMonitor = SignalRangeEntryMonitor;
