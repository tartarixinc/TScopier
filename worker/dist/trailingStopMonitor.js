"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrailingStopMonitor = void 0;
const signalPip_1 = require("./signalPip");
const trailingStop_1 = require("./trailingStop");
const metatraderapi_1 = require("./metatraderapi");
const mtApiByAccount_1 = require("./mtApiByAccount");
const orderModifyBenign_1 = require("./orderModifyBenign");
const monitorIdleGate_1 = require("./monitorIdleGate");
const copierPause_1 = require("./copierPause");
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('TRAILING_STOP_TICK_MS', 1500);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('TRAILING_STOP_IDLE_MS', 60000);
const SYMBOL_CACHE_TTL_MS = 5 * 60000;
class TrailingStopMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.loop = null;
        this.platformByUuid = new Map();
        this.ticking = false;
        this.firstTickLogged = false;
        this.quietTicks = 0;
        this.symbolCache = new Map();
    }
    start() {
        if (this.loop)
            return;
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
            console.warn('[trailingStopMonitor] MT4API_BASIC_USER/PASSWORD missing — trailing stop monitor disabled');
            return;
        }
        this.loop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'trailingStopMonitor',
            supabase: this.supabase,
            activeIntervalMs: ACTIVE_MS,
            idleIntervalMs: IDLE_MS,
            hasWork: sb => (0, monitorIdleGate_1.hasWorkOnShard)(sb, 'trades', q => q.eq('status', 'open').not('trail_peak_price', 'is', null)),
            tick: () => this.runTick(),
        });
        console.log(`[trailingStopMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`);
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
        const tradesQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('trades')
            .select('id,user_id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,entry_price,sl,tp,'
            + 'trail_peak_price,trail_last_sl,trail_start_pips,trail_step_pips,trail_distance_pips')
            .eq('status', 'open')
            .not('trail_peak_price', 'is', null)
            .limit(500));
        if (!tradesQ)
            return;
        const { data, error } = await tradesQ;
        if (error) {
            console.error('[trailingStopMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? [])
            .filter(r => !(0, copierPause_1.isUserCopierPausedCached)(r.user_id));
        if (!this.firstTickLogged) {
            this.firstTickLogged = true;
            console.log(`[trailingStopMonitor] first tick ok trail_rows=${rows.length}`);
        }
        if (!rows.length)
            return;
        const brokerIds = [...new Set(rows.map(r => r.broker_account_id).filter(Boolean))];
        const { data: brokers, error: brokerErr } = await this.supabase
            .from('broker_accounts')
            .select('id,metaapi_account_id,platform')
            .in('id', brokerIds);
        if (brokerErr) {
            console.error('[trailingStopMonitor] broker lookup failed:', brokerErr.message);
            return;
        }
        const brokerById = new Map((brokers ?? []).map(b => [b.id, b]));
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByMetaapiId)(this.supabase, (brokers ?? []).map(b => String(b.metaapi_account_id ?? '')));
        const groups = new Map();
        for (const row of rows) {
            const b = brokerById.get(row.broker_account_id ?? '');
            if (!b?.metaapi_account_id)
                continue;
            const key = `${b.metaapi_account_id}:${row.symbol.toUpperCase()}`;
            const list = groups.get(key) ?? [];
            list.push(row);
            groups.set(key, list);
        }
        let modifiedTotal = 0;
        let modifyErrTotal = 0;
        for (const [key, group] of groups) {
            const uuid = key.split(':')[0];
            const symbol = group[0]?.symbol ?? '';
            let bid = NaN;
            let ask = NaN;
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, uuid);
            if (!api)
                continue;
            try {
                const q = await api.quote(uuid, symbol);
                bid = q.bid;
                ask = q.ask;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[trailingStopMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`);
                continue;
            }
            for (const trade of group) {
                const ok = await this.maybeTrailTrade(trade, uuid, api, bid, ask);
                if (ok === true)
                    modifiedTotal++;
                if (ok === false)
                    modifyErrTotal++;
            }
        }
        if (modifiedTotal > 0 || modifyErrTotal > 0) {
            this.quietTicks = 0;
            console.log(`[trailingStopMonitor] tick rows=${rows.length} groups=${groups.size} trailed=${modifiedTotal} errors=${modifyErrTotal}`);
        }
        else if (++this.quietTicks >= 20) {
            this.quietTicks = 0;
            console.log(`[trailingStopMonitor] heartbeat rows=${rows.length} groups=${groups.size} (no SL updates this cycle)`);
        }
    }
    async maybeTrailTrade(trade, uuid, api, bid, ask) {
        const ticketNum = Number(trade.metaapi_order_id);
        if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
            await this.clearTrailWatch(trade.id);
            return null;
        }
        const entry = Number(trade.entry_price);
        const peak = Number(trade.trail_peak_price);
        if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(peak) || peak <= 0) {
            return null;
        }
        const symEntry = await this.getSymbolCache(uuid, trade.symbol);
        if (!symEntry)
            return null;
        const signalPip = (0, signalPip_1.signalPipPrice)(trade.symbol);
        const config = (0, trailingStop_1.normalizeTrailingConfig)({
            trailing_start_pips: trade.trail_start_pips ?? undefined,
            trailing_step_pips: trade.trail_step_pips ?? undefined,
            trailing_distance_pips: trade.trail_distance_pips ?? undefined,
        });
        const isBuy = String(trade.direction).toLowerCase() === 'buy';
        const currentSl = trade.trail_last_sl ?? trade.sl;
        const update = (0, trailingStop_1.computeTrailingStopUpdate)({
            isBuy,
            entryPrice: entry,
            currentSl: currentSl != null ? Number(currentSl) : null,
            trailPeak: peak,
            bid,
            ask,
            pipPrice: signalPip,
            digits: symEntry.digits,
            config,
        });
        if (!update)
            return null;
        const tpSanitize = trade.tp != null && Number.isFinite(Number(trade.tp)) && Number(trade.tp) > 0
            ? Number(trade.tp)
            : 0;
        try {
            await api.orderModify(uuid, {
                ticket: ticketNum,
                stoploss: update.newSl,
                takeprofit: tpSanitize,
            });
            await this.supabase
                .from('trades')
                .update({
                sl: update.newSl,
                trail_peak_price: update.newPeak,
                trail_last_sl: update.newSl,
            })
                .eq('id', trade.id)
                .eq('status', 'open');
            await this.supabase.from('trade_execution_logs').insert({
                user_id: trade.user_id,
                signal_id: trade.signal_id,
                broker_account_id: trade.broker_account_id,
                action: 'trailing_stop',
                status: 'success',
                request_payload: {
                    ticket: ticketNum,
                    symbol: trade.symbol,
                    direction: trade.direction,
                    new_sl: update.newSl,
                    trail_peak: update.newPeak,
                    profit_pips: update.profitPips,
                },
            });
            console.log(`[trailingStopMonitor] trailed trade=${trade.id} symbol=${trade.symbol} sl→${update.newSl} peak=${update.newPeak}`);
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
                || (0, orderModifyBenign_1.isBenignOrderModifyError)(msg);
            if (benign) {
                await this.supabase
                    .from('trades')
                    .update({ status: 'closed', closed_at: new Date().toISOString(), trail_peak_price: null })
                    .eq('id', trade.id);
                return null;
            }
            console.warn(`[trailingStopMonitor] OrderModify failed trade=${trade.id} ticket=${ticketNum}: ${msg}`);
            await this.supabase.from('trade_execution_logs').insert({
                user_id: trade.user_id,
                signal_id: trade.signal_id,
                broker_account_id: trade.broker_account_id,
                action: 'trailing_stop',
                status: 'failed',
                request_payload: { ticket: ticketNum, symbol: trade.symbol, attempted_sl: update.newSl },
                error_message: msg,
            });
            return false;
        }
    }
    async clearTrailWatch(tradeId) {
        await this.supabase.from('trades').update({ trail_peak_price: null }).eq('id', tradeId);
    }
    async getSymbolCache(uuid, symbol) {
        const key = `${uuid}:${symbol.toUpperCase()}`;
        const cached = this.symbolCache.get(key);
        if (cached && Date.now() - cached.loadedAt < SYMBOL_CACHE_TTL_MS)
            return cached;
        const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, uuid);
        if (!api)
            return null;
        try {
            const p = await api.symbolParams(uuid, symbol);
            const n = (0, metatraderapi_1.normalizeSymbolParams)(p);
            const entry = {
                digits: n.digits ?? 5,
                point: n.point ?? 0.00001,
                contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
                loadedAt: Date.now(),
            };
            this.symbolCache.set(key, entry);
            return entry;
        }
        catch {
            return null;
        }
    }
}
exports.TrailingStopMonitor = TrailingStopMonitor;
