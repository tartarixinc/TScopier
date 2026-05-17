"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoManagementMonitor = void 0;
const autoManagement_1 = require("./autoManagement");
const pipCalculator_1 = require("./pipCalculator");
const metatraderapi_1 = require("./metatraderapi");
const mtApiByAccount_1 = require("./mtApiByAccount");
const TICK_INTERVAL_MS = 1500;
const SYMBOL_CACHE_TTL_MS = 5 * 60000;
class AutoManagementMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.timer = null;
        this.platformByUuid = new Map();
        this.ticking = false;
        this.firstTickLogged = false;
        this.quietTicks = 0;
        this.symbolCache = new Map();
    }
    start() {
        if (this.timer)
            return;
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
            console.warn('[autoManagementMonitor] MT4API_BASIC_USER/PASSWORD missing — auto-management monitor disabled');
            return;
        }
        this.timer = setInterval(() => {
            if (this.ticking)
                return;
            this.ticking = true;
            this.tick()
                .catch(err => {
                console.error('[autoManagementMonitor] tick error:', err instanceof Error ? err.message : String(err));
            })
                .finally(() => { this.ticking = false; });
        }, TICK_INTERVAL_MS);
        console.log(`[autoManagementMonitor] started (interval=${TICK_INTERVAL_MS}ms)`);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async tick() {
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)())
            return;
        const { data, error } = await this.supabase
            .from('trades')
            .select('id,user_id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,entry_price,sl,tp,lot_size,'
            + 'auto_be_mode,auto_be_trigger_value,auto_be_tp_index,auto_be_type,auto_be_offset_pips,auto_be_risk_sl')
            .eq('status', 'open')
            .not('auto_be_mode', 'is', null)
            .is('auto_be_applied_at', null)
            .limit(500);
        if (error) {
            console.error('[autoManagementMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? []);
        if (!this.firstTickLogged) {
            this.firstTickLogged = true;
            console.log(`[autoManagementMonitor] first tick ok auto_be_rows=${rows.length}`);
        }
        if (!rows.length)
            return;
        const tradeIds = rows.map(r => r.id);
        const partialByTrade = await this.loadPartialLegs(tradeIds);
        const brokerIds = [...new Set(rows.map(r => r.broker_account_id).filter(Boolean))];
        const { data: brokers, error: brokerErr } = await this.supabase
            .from('broker_accounts')
            .select('id,metaapi_account_id,platform,manual_settings')
            .in('id', brokerIds);
        if (brokerErr) {
            console.error('[autoManagementMonitor] broker lookup failed:', brokerErr.message);
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
        let appliedTotal = 0;
        let applyErrTotal = 0;
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
                console.warn(`[autoManagementMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`);
                continue;
            }
            for (const trade of group) {
                const partials = partialByTrade.get(trade.id) ?? [];
                const broker = brokerById.get(trade.broker_account_id ?? '');
                const manual = (broker?.manual_settings ?? {});
                const halfClosePct = Math.min(99, Math.max(1, Math.floor(Number(manual.half_close_percent ?? 50) || 50)));
                const ok = await this.maybeApplyBreakeven(trade, uuid, api, bid, ask, partials, halfClosePct);
                if (ok === true)
                    appliedTotal++;
                if (ok === false)
                    applyErrTotal++;
            }
        }
        if (appliedTotal > 0 || applyErrTotal > 0) {
            this.quietTicks = 0;
            console.log(`[autoManagementMonitor] tick rows=${rows.length} groups=${groups.size} applied=${appliedTotal} errors=${applyErrTotal}`);
        }
        else if (++this.quietTicks >= 20) {
            this.quietTicks = 0;
            console.log(`[autoManagementMonitor] heartbeat rows=${rows.length} groups=${groups.size} (no BE updates this cycle)`);
        }
    }
    async loadPartialLegs(tradeIds) {
        const out = new Map();
        if (!tradeIds.length)
            return out;
        const { data, error } = await this.supabase
            .from('partial_tp_legs')
            .select('trade_id,tp_idx,trigger_price,status')
            .in('trade_id', tradeIds);
        if (error) {
            console.warn(`[autoManagementMonitor] partial_tp_legs select failed: ${error.message}`);
            return out;
        }
        for (const row of (data ?? [])) {
            const list = out.get(row.trade_id) ?? [];
            list.push(row);
            out.set(row.trade_id, list);
        }
        return out;
    }
    async maybeApplyBreakeven(trade, uuid, api, bid, ask, partials, halfClosePercent) {
        const ticketNum = Number(trade.metaapi_order_id);
        if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
            await this.markApplied(trade.id, { clearWatch: true });
            return null;
        }
        const entry = Number(trade.entry_price);
        if (!Number.isFinite(entry) || entry <= 0)
            return null;
        const symEntry = await this.getSymbolCache(uuid, trade.symbol);
        if (!symEntry)
            return null;
        const pipQuote = (0, pipCalculator_1.pipCalculator)(trade.symbol, symEntry.point, symEntry.digits, symEntry.contractSize);
        const lots = Number(trade.lot_size ?? 0);
        const pipValuePerLot = (0, pipCalculator_1.pipValueForLots)(pipQuote, lots > 0 ? lots : 0.01);
        const mode = String(trade.auto_be_mode).toLowerCase();
        const triggerValue = Number(trade.auto_be_trigger_value ?? 0);
        const tpIndex = Number(trade.auto_be_tp_index ?? 1);
        const offsetPips = Number(trade.auto_be_offset_pips ?? 0);
        const beType = String(trade.auto_be_type ?? 'sl_only').toLowerCase();
        const isBuy = String(trade.direction).toLowerCase() === 'buy';
        const partialTpFiredIndices = partials
            .filter(p => p.status === 'fired')
            .map(p => p.tp_idx);
        const partialTpTriggers = partials
            .filter(p => p.status === 'pending' || p.status === 'fired')
            .map(p => ({ tpIdx: p.tp_idx, triggerPrice: Number(p.trigger_price) }));
        const brokerTp = trade.tp != null && Number.isFinite(Number(trade.tp)) && Number(trade.tp) > 0
            ? Number(trade.tp)
            : null;
        const riskSl = trade.auto_be_risk_sl != null && Number.isFinite(Number(trade.auto_be_risk_sl))
            ? Number(trade.auto_be_risk_sl)
            : (trade.sl != null && Number.isFinite(Number(trade.sl)) ? Number(trade.sl) : null);
        const beSl = (0, autoManagement_1.computeBreakevenStopLoss)(isBuy, entry, offsetPips, pipQuote.pipPrice, symEntry.digits);
        const currentSl = trade.sl != null && Number.isFinite(Number(trade.sl)) ? Number(trade.sl) : null;
        if ((0, autoManagement_1.isSlAtOrBeyondBreakeven)(isBuy, currentSl, beSl, pipQuote.pipPrice)) {
            await this.markApplied(trade.id, { sl: currentSl ?? beSl });
            return null;
        }
        if (!(0, autoManagement_1.isAutoBeTriggerMet)({
            mode,
            triggerValue,
            tpIndex,
            isBuy,
            entryPrice: entry,
            riskSl,
            bid,
            ask,
            pipPrice: pipQuote.pipPrice,
            pipValuePerLot,
            partialTpFiredIndices,
            partialTpTriggers,
            brokerTp,
        })) {
            return null;
        }
        const tpSanitize = brokerTp ?? 0;
        try {
            await api.orderModify(uuid, {
                ticket: ticketNum,
                stoploss: beSl,
                takeprofit: tpSanitize,
            });
            let remainingLots = lots;
            if (beType === 'sl_and_close_half' && lots > 0.0001) {
                const closeLots = +(lots * (halfClosePercent / 100)).toFixed(2);
                if (closeLots >= 0.01) {
                    try {
                        await api.orderClose(uuid, { ticket: ticketNum, lots: closeLots });
                        remainingLots = Math.max(0, +(lots - closeLots).toFixed(2));
                    }
                    catch (halfErr) {
                        const msg = halfErr instanceof Error ? halfErr.message : String(halfErr);
                        console.warn(`[autoManagementMonitor] half close failed trade=${trade.id} ticket=${ticketNum}: ${msg}`);
                    }
                }
            }
            const patch = {
                sl: beSl,
                auto_be_applied_at: new Date().toISOString(),
            };
            if (remainingLots < 0.0001) {
                patch.status = 'closed';
                patch.closed_at = new Date().toISOString();
                patch.lot_size = 0;
            }
            else if (remainingLots !== lots) {
                patch.lot_size = remainingLots;
            }
            await this.supabase.from('trades').update(patch).eq('id', trade.id).eq('status', 'open');
            await this.supabase.from('trade_execution_logs').insert({
                user_id: trade.user_id,
                signal_id: trade.signal_id,
                broker_account_id: trade.broker_account_id,
                action: 'auto_be',
                status: 'success',
                request_payload: {
                    ticket: ticketNum,
                    symbol: trade.symbol,
                    direction: trade.direction,
                    mode,
                    trigger_value: triggerValue,
                    new_sl: beSl,
                    be_type: beType,
                    half_close: beType === 'sl_and_close_half',
                },
            });
            console.log(`[autoManagementMonitor] applied trade=${trade.id} symbol=${trade.symbol} mode=${mode} sl→${beSl}`);
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg);
            if (benign) {
                await this.supabase
                    .from('trades')
                    .update({
                    status: 'closed',
                    closed_at: new Date().toISOString(),
                    auto_be_applied_at: new Date().toISOString(),
                })
                    .eq('id', trade.id);
                return null;
            }
            console.warn(`[autoManagementMonitor] apply failed trade=${trade.id} ticket=${ticketNum}: ${msg}`);
            await this.supabase.from('trade_execution_logs').insert({
                user_id: trade.user_id,
                signal_id: trade.signal_id,
                broker_account_id: trade.broker_account_id,
                action: 'auto_be',
                status: 'failed',
                request_payload: { ticket: ticketNum, symbol: trade.symbol, attempted_sl: beSl, mode },
                error_message: msg,
            });
            return false;
        }
    }
    async markApplied(tradeId, opts) {
        const patch = {
            auto_be_applied_at: new Date().toISOString(),
        };
        if (opts.sl != null && Number.isFinite(opts.sl))
            patch.sl = opts.sl;
        if (opts.clearWatch) {
            patch.auto_be_mode = null;
        }
        await this.supabase.from('trades').update(patch).eq('id', tradeId);
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
exports.AutoManagementMonitor = AutoManagementMonitor;
