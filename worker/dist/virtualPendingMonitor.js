"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VirtualPendingMonitor = void 0;
exports.isTriggered = isTriggered;
exports.isBlockedByShallowerStep = isBlockedByShallowerStep;
exports.fillWithinTriggerBand = fillWithinTriggerBand;
exports.evaluateTpTouch = evaluateTpTouch;
exports.shouldLockBasketLayering = shouldLockBasketLayering;
const node_os_1 = __importDefault(require("node:os"));
const fxsocketClient_1 = require("./fxsocketClient");
const mtApiByAccount_1 = require("./mtApiByAccount");
const autoManagement_1 = require("./autoManagement");
const basketModFollowUp_1 = require("./basketModFollowUp");
const channelActiveTradeParams_1 = require("./channelActiveTradeParams");
const channelTradingConfig_1 = require("./channelTradingConfig");
const rangePendingLadderSync_1 = require("./rangePendingLadderSync");
const normalizeManualSettings_1 = require("./manualPlanning/normalizeManualSettings");
const rangeBasketTpSync_1 = require("./rangeBasketTpSync");
const monitorIdleGate_1 = require("./monitorIdleGate");
const rangeLayerTillClose_1 = require("./rangeLayerTillClose");
const copierPause_1 = require("./copierPause");
const rangePendingFireGuard_1 = require("./rangePendingFireGuard");
const brokerConnectError_1 = require("./brokerConnectError");
const rangePendingBasketCleanup_1 = require("./rangePendingBasketCleanup");
const SYMBOL_TTL_MS = 10 * 60000;
const ACTIVE_MS = (0, monitorIdleGate_1.monitorActiveIntervalMs)('VIRTUAL_PENDING_TICK_MS', 1500);
const IDLE_MS = (0, monitorIdleGate_1.monitorIdleIntervalMs)('VIRTUAL_PENDING_IDLE_MS', 60000);
const STALE_CLAIM_AFTER_MS = 30000;
async function virtualPendingHasWork(supabase, staleCut) {
    const pending = await (0, monitorIdleGate_1.hasWorkOnShard)(supabase, 'range_pending_legs', q => q
        .eq('status', 'pending')
        .not('comment', 'ilike', '%:strictEntry%')
        .not('comment', 'ilike', '%:strictEntryAgg%'));
    if (pending)
        return true;
    return (0, monitorIdleGate_1.hasWorkOnShard)(supabase, 'range_pending_legs', q => q.eq('status', 'claimed').lt('claimed_at', staleCut));
}
/**
 * Pure trigger-check used by both the worker monitor and the edge sweep:
 *   buy ladder  → trigger fires when bid <= trigger_price (price dropped)
 *   sell ladder → trigger fires when ask >= trigger_price (price rose)
 */
function isTriggered(isBuy, triggerPrice, bid, ask) {
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0)
        return false;
    if (!Number.isFinite(bid) || !Number.isFinite(ask))
        return false;
    return isBuy ? bid <= triggerPrice : ask >= triggerPrice;
}
/**
 * True if some shallower virtual rung for the same basket is still `pending`
 * or `claimed` (see `activeStepsByBasket` from `fetchShallowActiveSteps`).
 */
function isBlockedByShallowerStep(leg, activeStepsByBasket) {
    const bk = `${leg.signal_id}|${leg.broker_account_id}`;
    const steps = activeStepsByBasket.get(bk);
    if (!steps)
        return false;
    for (const s of steps) {
        if (s < leg.step_idx)
            return true;
    }
    return false;
}
/**
 * A layer must fill at (or better than) its planned rung price, within the
 * configured slippage. Guards against the fire-time price racing away from the
 * tick-time trigger check — without it, a buy rung that triggered on a brief
 * dip can fill seconds later at the top of a rally, printing a WORSE entry
 * than the immediates it was supposed to average down from and ignoring the
 * step-pips ladder spacing.
 */
function fillWithinTriggerBand(args) {
    const { isBuy, triggerPrice, bid, ask, slippagePoints, point } = args;
    if (!isTriggered(isBuy, triggerPrice, bid, ask)) {
        return { ok: false, reason: 'no_longer_triggered' };
    }
    if (point == null || !(point > 0))
        return { ok: true };
    const tol = Math.max(2, Math.max(0, slippagePoints)) * point;
    const fillSide = isBuy ? ask : bid;
    const ok = isBuy ? fillSide <= triggerPrice + tol : fillSide >= triggerPrice - tol;
    return ok ? { ok: true } : { ok: false, reason: 'fill_outside_trigger_band' };
}
function evaluateTpTouch(args) {
    const { direction, tps, bid, ask } = args;
    const cleanTps = tps.filter(tp => Number.isFinite(tp) && tp > 0);
    if (!cleanTps.length)
        return { touched: false, triggerPrice: null, triggerSide: null };
    if (direction === 'buy') {
        const triggerPrice = Math.min(...cleanTps);
        return { touched: bid >= triggerPrice, triggerPrice, triggerSide: 'bid' };
    }
    if (direction === 'sell') {
        const triggerPrice = Math.max(...cleanTps);
        return { touched: ask <= triggerPrice, triggerPrice, triggerSide: 'ask' };
    }
    return { touched: false, triggerPrice: null, triggerSide: null };
}
/**
 * Decide whether a basket's layering must be locked when "layer till close"
 * is OFF. Two independent triggers:
 *  1. live quote touches an open trade's TP (catches the touch in real time)
 *  2. the basket is PARTIALLY closed — some trades closed while others remain
 *     open. A broker-side TP fill closes its trades within seconds, so by the
 *     time the monitor scans, the touched TP rows are no longer 'open' and
 *     trigger (1) can never fire. A partial close is sticky evidence that a
 *     TP/CWE/partial close happened and survives that race.
 */
function shouldLockBasketLayering(args) {
    const { direction, openTps, openCount, closedCount, bid, ask } = args;
    if (openCount <= 0)
        return { lock: false, reason: null, triggerPrice: null, triggerSide: null };
    const touch = evaluateTpTouch({ direction, tps: openTps, bid, ask });
    if (touch.touched) {
        return { lock: true, reason: 'tp_touched', triggerPrice: touch.triggerPrice, triggerSide: touch.triggerSide };
    }
    if (closedCount > 0) {
        return { lock: true, reason: 'basket_partially_closed', triggerPrice: null, triggerSide: null };
    }
    return { lock: false, reason: null, triggerPrice: null, triggerSide: null };
}
class VirtualPendingMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.loop = null;
        this.platformByUuid = new Map();
        this.symbolCache = new Map();
        this.brokerConfigCache = new Map();
        this.ticking = false;
        /** Heartbeat counter: when there ARE pending rows but none triggered, we
         *  still log one line every N ticks so it's obvious the monitor is alive
         *  and how far the live quote sits from the nearest trigger. */
        this.quietTicks = 0;
        this.firstTickLogged = false;
        /** Throttle basket_in_profit skip logs — legs re-check every tick. */
        this.profitSkipLogAt = new Map();
        /** Throttle trigger-band defer logs — legs re-check every tick. */
        this.bandSkipLogAt = new Map();
        this.hostId = `worker:${node_os_1.default.hostname()}:${process.pid}`;
    }
    start() {
        if (this.loop)
            return;
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)()) {
            console.warn('[virtualPendingMonitor] MT4API_BASIC_USER/PASSWORD missing — virtual pending monitor disabled');
            return;
        }
        const staleCut = () => new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString();
        this.loop = (0, monitorIdleGate_1.startMonitorLoop)({
            name: 'virtualPendingMonitor',
            supabase: this.supabase,
            activeIntervalMs: ACTIVE_MS,
            idleIntervalMs: IDLE_MS,
            hasWork: sb => virtualPendingHasWork(sb, staleCut()),
            tick: () => this.runTick(),
        });
        console.log(`[virtualPendingMonitor] started host=${this.hostId} active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`);
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
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
            return;
        // Re-open rows whose claim is stale. Anything older than STALE_CLAIM_AFTER_MS
        // is considered abandoned (the claiming worker probably crashed); reset it
        // so another monitor can pick it up.
        const staleCut = new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString();
        const staleStats = await (0, rangePendingFireGuard_1.reconcileStaleClaimedLegs)(this.supabase, staleCut);
        if (staleStats.cancelled > 0 || staleStats.reset > 0) {
            console.log(`[virtualPendingMonitor] stale claims reconciled cancelled=${staleStats.cancelled} reset=${staleStats.reset}`);
        }
        // Expire any rows whose pending_expiry_hours have lapsed BEFORE we try to
        // fire them — keeps the queue tight.
        const nowIso = new Date().toISOString();
        const { data: expired } = await this.supabase
            .from('range_pending_legs')
            .update({ status: 'expired', error_message: 'pending_expiry' })
            .eq('status', 'pending')
            .not('expires_at', 'is', null)
            .lt('expires_at', nowIso)
            .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,is_buy,step_idx');
        if (expired && expired.length) {
            for (const r of expired) {
                if ((0, copierPause_1.isUserCopierPausedCached)(r.user_id))
                    continue;
                try {
                    await this.supabase.from('trade_execution_logs').insert({
                        user_id: r.user_id,
                        signal_id: r.signal_id,
                        broker_account_id: r.broker_account_id,
                        action: 'virtual_pending_expired',
                        status: 'info',
                        request_payload: { id: r.id, symbol: r.symbol, step_idx: r.step_idx },
                    });
                }
                catch { /* logging is best-effort */ }
            }
            const expiredBaskets = new Map();
            for (const r of expired) {
                const key = `${r.broker_account_id}|${r.signal_id}|${r.symbol}`;
                if (!expiredBaskets.has(key))
                    expiredBaskets.set(key, r);
            }
            for (const basketLeg of expiredBaskets.values()) {
                try {
                    await this.rebalanceRangeBasketTakeProfits(basketLeg);
                }
                catch (rebalErr) {
                    console.warn(`[virtualPendingMonitor] TP rebalance after pending expiry signal=${basketLeg.signal_id}:`, rebalErr);
                }
            }
        }
        // Pull the live pending queue.
        const pendingQ = await (0, monitorIdleGate_1.applyShardToQuery)(this.supabase, this.supabase
            .from('range_pending_legs')
            .select('*')
            .eq('status', 'pending')
            .not('comment', 'ilike', '%:strictEntry%')
            .not('comment', 'ilike', '%:strictEntryAgg%')
            .limit(500));
        if (!pendingQ)
            return;
        const { data, error } = await pendingQ;
        if (error) {
            console.error('[virtualPendingMonitor] select failed:', error.message);
            return;
        }
        const rows = (data ?? [])
            .filter(r => !(0, copierPause_1.isUserCopierPausedCached)(r.user_id));
        if (!this.firstTickLogged) {
            this.firstTickLogged = true;
            console.log(`[virtualPendingMonitor] first tick ok pending_rows=${rows.length}`);
        }
        if (!rows.length) {
            // Reset the quiet-tick counter — next time rows appear, the heartbeat
            // restarts from zero so the first non-empty tick always logs.
            this.quietTicks = 0;
            return;
        }
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByFxsocketId)(this.supabase, rows.map(r => r.metaapi_account_id));
        // SL/TP/manual broker closes leave DB trades "open" — reconcile before triggers.
        await (0, rangePendingBasketCleanup_1.reconcilePendingLegBasketsFromBroker)(this.supabase, rows, uuid => (0, mtApiByAccount_1.apiForFxsocketAccount)(this.platformByUuid, uuid));
        // Group by (account, symbol) so we issue at most ONE /Quote per group.
        const groups = new Map();
        for (const r of rows) {
            const key = `${r.metaapi_account_id}|${r.symbol}`;
            const list = groups.get(key) ?? [];
            list.push(r);
            groups.set(key, list);
        }
        let triggeredTotal = 0;
        let firedOkTotal = 0;
        let firedErrTotal = 0;
        /** Per-group: cheapest distance between live quote and any leg's trigger.
         *  Lets the heartbeat log show "you're $0.40 from your nearest trigger". */
        const distances = [];
        await Promise.all(Array.from(groups.entries()).map(async ([key, legs]) => {
            const [uuid, symbol] = key.split('|');
            if (!uuid || !symbol)
                return;
            const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(this.platformByUuid, uuid);
            if (!api)
                return;
            let q;
            try {
                q = await api.quote(uuid, symbol);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[virtualPendingMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`);
                return;
            }
            const tpTouchedBaskets = await this.detectAndLockTpTouchedBaskets(legs, q.bid, q.ask);
            // How far is the nearest trigger? Useful diagnostic when nothing fires.
            let nearestGap = Number.POSITIVE_INFINITY;
            const triggeredInGroup = [];
            for (const leg of legs) {
                const basketKey = `${leg.signal_id}|${leg.broker_account_id}`;
                if (tpTouchedBaskets.has(basketKey))
                    continue;
                const ref = leg.is_buy ? q.bid : q.ask;
                const gap = leg.is_buy ? ref - leg.trigger_price : leg.trigger_price - ref;
                if (Number.isFinite(gap) && gap < nearestGap)
                    nearestGap = gap;
                if (isTriggered(leg.is_buy, leg.trigger_price, q.bid, q.ask))
                    triggeredInGroup.push(leg);
            }
            const cancelledStaleIds = new Set();
            const purgedBaskets = new Set();
            for (const leg of triggeredInGroup) {
                const bk = `${leg.signal_id}|${leg.broker_account_id}`;
                if (purgedBaskets.has(bk)) {
                    cancelledStaleIds.add(leg.id);
                    continue;
                }
                const staleEarly = await this.getStaleLegReason(leg, api, uuid);
                if (!staleEarly)
                    continue;
                purgedBaskets.add(bk);
                const deleted = await (0, rangePendingBasketCleanup_1.deleteRangePendingLegsForBasket)(this.supabase, { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id }, staleEarly);
                if (deleted > 0) {
                    for (const l of legs) {
                        if (l.signal_id === leg.signal_id && l.broker_account_id === leg.broker_account_id) {
                            cancelledStaleIds.add(l.id);
                        }
                    }
                    try {
                        await this.supabase.from('trade_execution_logs').insert({
                            user_id: leg.user_id,
                            signal_id: leg.signal_id,
                            broker_account_id: leg.broker_account_id,
                            action: 'virtual_pending_cancelled',
                            status: 'info',
                            request_payload: {
                                reason: staleEarly,
                                phase: 'pre_claim_stale',
                                rows: deleted,
                                basket: bk,
                            },
                        });
                    }
                    catch {
                        /* logging is best-effort */
                    }
                }
            }
            const signalIds = [...new Set(legs.map(l => l.signal_id))];
            const activeStepsByBasket = await this.fetchShallowActiveSteps(uuid, symbol, signalIds);
            const byBasket = new Map();
            for (const leg of triggeredInGroup) {
                if (cancelledStaleIds.has(leg.id))
                    continue;
                if (!isTriggered(leg.is_buy, leg.trigger_price, q.bid, q.ask))
                    continue;
                if (isBlockedByShallowerStep(leg, activeStepsByBasket))
                    continue;
                const bk = `${leg.signal_id}|${leg.broker_account_id}`;
                const arr = byBasket.get(bk) ?? [];
                arr.push(leg);
                byBasket.set(bk, arr);
            }
            for (const [, arr] of byBasket) {
                arr.sort((a, b) => a.step_idx - b.step_idx || a.id.localeCompare(b.id));
                const winner = arr[0];
                if (!winner)
                    continue;
                triggeredTotal += 1;
                const ok = await this.fireLeg(winner, q.bid, q.ask);
                if (ok)
                    firedOkTotal += 1;
                else
                    firedErrTotal += 1;
            }
            distances.push({ symbol, bid: q.bid, ask: q.ask, gapPriceUnits: nearestGap, legs: legs.length });
        }));
        if (triggeredTotal > 0) {
            console.log(`[virtualPendingMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} fired=${firedOkTotal}_ok ${firedErrTotal}_err`);
            this.quietTicks = 0;
        }
        else {
            // Heartbeat: log every ~30s (20 ticks × 1.5s) when there's work waiting
            // but no triggers crossing — makes "monitor is alive, just not hitting"
            // visible vs. "monitor is dead".
            this.quietTicks += 1;
            if (this.quietTicks % 20 === 1) {
                const summary = distances
                    .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gapPriceUnits) ? d.gapPriceUnits.toFixed(5) : 'n/a'} (${d.legs} legs)`)
                    .join('; ');
                console.log(`[virtualPendingMonitor] heartbeat rows=${rows.length} groups=${groups.size} no triggers crossed yet — ${summary}`);
            }
        }
    }
    async detectAndLockTpTouchedBaskets(legs, bid, ask) {
        const touched = new Set();
        if (!legs.length)
            return touched;
        const signalIds = [...new Set(legs.map(l => l.signal_id))];
        const brokerIds = [...new Set(legs.map(l => l.broker_account_id))];
        const symbol = legs[0]?.symbol ?? null;
        if (!symbol)
            return touched;
        // Scan open AND closed trades: a TP fill closes its rows at the broker
        // within seconds, so an open-only scan misses the touch (the remaining
        // open trades carry deeper TPs that were never reached).
        const { data, error } = await this.supabase
            .from('trades')
            .select('signal_id,broker_account_id,user_id,direction,tp,status')
            .in('signal_id', signalIds)
            .in('broker_account_id', brokerIds)
            .eq('symbol', symbol)
            .in('status', ['open', 'closed']);
        if (error) {
            console.warn(`[virtualPendingMonitor] tp-touch scan failed: ${error.message}`);
            return touched;
        }
        const byBasket = new Map();
        for (const row of (data ?? [])) {
            const basketKey = `${row.signal_id}|${row.broker_account_id}`;
            const arr = byBasket.get(basketKey) ?? [];
            arr.push(row);
            byBasket.set(basketKey, arr);
        }
        for (const [basketKey, rows] of byBasket) {
            const openRows = rows.filter(r => r.status === 'open');
            const closedCount = rows.length - openRows.length;
            const direction = String((openRows[0] ?? rows[0])?.direction ?? '').toLowerCase();
            const openTps = openRows
                .map(r => Number(r.tp))
                .filter(tp => Number.isFinite(tp) && tp > 0);
            const decision = shouldLockBasketLayering({
                direction,
                openTps,
                openCount: openRows.length,
                closedCount,
                bid,
                ask,
            });
            if (!decision.lock)
                continue;
            const [signalId, brokerAccountId] = basketKey.split('|');
            if (!signalId || !brokerAccountId)
                continue;
            const userId = (openRows[0] ?? rows[0])?.user_id;
            if (!userId)
                continue;
            const layerTillClose = await (0, rangeLayerTillClose_1.loadRangeLayerTillCloseForSignal)(this.supabase, signalId, brokerAccountId);
            if (layerTillClose)
                continue;
            const { stopped, deleted } = await (0, rangeLayerTillClose_1.stopRangeLayeringUnlessEnabled)(this.supabase, { signalId, brokerAccountId, symbol, userId }, decision.reason ?? 'tp_touched');
            if (!stopped)
                continue;
            touched.add(basketKey);
            try {
                await this.supabase.from('trade_execution_logs').insert({
                    user_id: userId,
                    signal_id: signalId,
                    broker_account_id: brokerAccountId,
                    action: 'virtual_pending_tp_lock',
                    status: 'info',
                    request_payload: {
                        symbol,
                        direction,
                        trigger_price: decision.triggerPrice,
                        trigger_side: decision.triggerSide,
                        lock_trigger: decision.reason,
                        closed_trades: closedCount,
                        open_trades: openRows.length,
                        bid,
                        ask,
                        deleted_rows: deleted,
                        lock_reason: 'layering_stopped',
                    },
                });
            }
            catch {
                /* best-effort */
            }
        }
        return touched;
    }
    /** Undo a CAS claim when the fire-time price check fails — leg stays live. */
    async releaseClaimedLegToPending(legId) {
        const { error } = await this.supabase
            .from('range_pending_legs')
            .update({ status: 'pending', claimed_at: null, claimed_by: null })
            .eq('id', legId)
            .eq('status', 'claimed');
        if (error) {
            console.warn(`[virtualPendingMonitor] release claim failed leg=${legId}: ${error.message}`);
        }
    }
    async markLegFiredWithRetry(legId, ticket) {
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await (0, rangePendingLadderSync_1.markRangeLegFired)(this.supabase, legId, ticket);
                return;
            }
            catch (err) {
                lastErr = err;
                await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
    async fireLeg(leg, bid, ask) {
        const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(this.platformByUuid, leg.metaapi_account_id);
        if (!api)
            return false;
        const layerTillClose = await (0, rangeLayerTillClose_1.loadRangeLayerTillCloseForSignal)(this.supabase, leg.signal_id, leg.broker_account_id);
        const block = await (0, rangePendingFireGuard_1.shouldBlockVirtualLegFire)(this.supabase, leg, {
            layerTillClose,
            quote: { bid, ask },
            isBuy: leg.is_buy,
        });
        if (block.block) {
            if (block.reason === 'basket_in_profit') {
                const bk = `${leg.signal_id}|${leg.broker_account_id}`;
                const now = Date.now();
                const last = this.profitSkipLogAt.get(bk) ?? 0;
                if (now - last >= VirtualPendingMonitor.PROFIT_SKIP_LOG_MS) {
                    this.profitSkipLogAt.set(bk, now);
                    console.log(`[virtualPendingMonitor] skip fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: basket_in_profit`);
                }
            }
            else if (block.reason) {
                console.log(`[virtualPendingMonitor] skip fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: ${block.reason}`);
            }
            return false;
        }
        // CAS claim. If another monitor (worker peer or edge fn) beat us, .maybeSingle()
        // returns no row and we walk away.
        const { data: claimed, error: claimErr } = await this.supabase
            .from('range_pending_legs')
            .update({ status: 'claimed', claimed_at: new Date().toISOString(), claimed_by: this.hostId })
            .eq('id', leg.id)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle();
        if (claimErr) {
            console.warn(`[virtualPendingMonitor] CAS claim error leg=${leg.id}: ${claimErr.message}`);
            return false;
        }
        if (!claimed)
            return false;
        // SL/TP may have been refreshed after this tick's queue SELECT (mgmt / basket refresh).
        try {
            const { data: freshRow } = await this.supabase
                .from('range_pending_legs')
                .select('stoploss,takeprofit,cwe_close_price')
                .eq('id', leg.id)
                .maybeSingle();
            if (freshRow) {
                leg.stoploss = freshRow.stoploss ?? leg.stoploss;
                leg.takeprofit = freshRow.takeprofit ?? leg.takeprofit;
                leg.cwe_close_price = freshRow.cwe_close_price ?? leg.cwe_close_price;
            }
        }
        catch {
            // best-effort — fire with stops from the tick snapshot
        }
        // Channel memory may hold a newer SL than the leg row (e.g. symbol-less Adjust SL).
        // Only when the memory was written during this basket's lifetime — older
        // memory belongs to a previous signal and produces wrong-side stops.
        let channelIdForTrade = null;
        try {
            const { data: sigMeta } = await this.supabase
                .from('signals')
                .select('channel_id,created_at')
                .eq('id', leg.signal_id)
                .maybeSingle();
            channelIdForTrade = sigMeta?.channel_id ?? null;
            const basketCreatedAt = sigMeta?.created_at ?? null;
            if (channelIdForTrade) {
                const channelParams = await (0, channelActiveTradeParams_1.loadChannelActiveTradeParamsForSymbol)(this.supabase, leg.user_id, channelIdForTrade, leg.symbol);
                if (channelParams?.stoploss != null
                    && channelParams.stoploss > 0
                    && !(0, channelActiveTradeParams_1.channelParamsPredateBasket)(channelParams, basketCreatedAt)) {
                    leg.stoploss = channelParams.stoploss;
                }
            }
        }
        catch {
            // best-effort — fire with stops from pending leg row
        }
        const staleReason = await this.getStaleLegReason(leg, api, leg.metaapi_account_id);
        if (staleReason) {
            await (0, rangePendingBasketCleanup_1.deleteRangePendingLegsForBasket)(this.supabase, { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id }, staleReason);
            return true;
        }
        const params = await this.getSymbolParams(leg.metaapi_account_id, leg.symbol);
        // The tick's quote can be seconds old by now (claim + guard round-trips).
        // Re-quote just before send and require the leg is STILL triggered AND the
        // fill side sits within slippage of the rung — otherwise release the claim
        // and let the leg fire when price genuinely returns to its level.
        let fireBid = bid;
        let fireAsk = ask;
        try {
            const fresh = await api.quote(leg.metaapi_account_id, leg.symbol);
            if (Number.isFinite(fresh.bid) && Number.isFinite(fresh.ask)) {
                fireBid = fresh.bid;
                fireAsk = fresh.ask;
            }
        }
        catch {
            // fall back to the tick quote
        }
        const band = fillWithinTriggerBand({
            isBuy: leg.is_buy,
            triggerPrice: leg.trigger_price,
            bid: fireBid,
            ask: fireAsk,
            slippagePoints: leg.slippage ?? 20,
            point: params?.point ?? null,
        });
        if (!band.ok) {
            await this.releaseClaimedLegToPending(leg.id);
            const now = Date.now();
            const last = this.bandSkipLogAt.get(leg.id) ?? 0;
            if (now - last >= VirtualPendingMonitor.PROFIT_SKIP_LOG_MS) {
                this.bandSkipLogAt.set(leg.id, now);
                console.log(`[virtualPendingMonitor] defer fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: `
                    + `${band.reason} trigger=${leg.trigger_price} bid=${fireBid} ask=${fireAsk}`);
            }
            return false;
        }
        // Build a MARKET order. We DO NOT send `price` for Buy/Sell — the broker
        // fills at the current bid/ask. Stops were precomputed at planning time
        // against the live anchor; SL/TP from the original ladder stand.
        //
        // CWE-tagged legs (cwe_close_price != null) intentionally ship with
        // takeprofit = 0 — the close threshold is enforced post-fill by
        // cweCloseMonitor, not by the broker. Honouring the persisted
        // `takeprofit` here would re-introduce the "Invalid stops" rejections
        // that motivated this redesign (a TP on a buy that's already in profit
        // is on the wrong side of the market and the broker refuses).
        const args = {
            symbol: leg.symbol,
            operation: leg.is_buy ? 'Buy' : 'Sell',
            volume: leg.volume,
            slippage: leg.slippage ?? 20,
            stoploss: leg.stoploss ?? 0,
            takeprofit: leg.cwe_close_price != null ? 0 : (leg.takeprofit ?? 0),
            comment: leg.comment ?? '',
            expertID: leg.expert_id ?? 909090,
        };
        // Last-second SL/TP clamp using the fire-time quote as the reference.
        const refPrice = leg.is_buy ? fireAsk : fireBid;
        if (params) {
            const clamped = this.clampOrderStops(args, refPrice, params);
            if (clamped.adjustments.length) {
                console.warn(`[virtualPendingMonitor] stops clamped leg=${leg.id} symbol=${leg.symbol} op=${args.operation}: ${clamped.adjustments.join(', ')}`);
            }
            Object.assign(args, clamped.args);
            // Sanity check the clamped result. The clamp only nudges to `ref ± minDist`,
            // which can still be invalid when the BROKER's effective stops_level is
            // larger than `/SymbolParams` reports (some MT5 builds quietly omit it).
            // If the resulting TP/SL is still on the wrong side of the live ref,
            // drop the offending side rather than send a doomed order — opening
            // without a TP is strictly better than not opening at all for an
            // averaging-down ladder.
            const cleanup = this.sanitizeStops(args, refPrice);
            if (cleanup.notes.length) {
                console.warn(`[virtualPendingMonitor] stops sanitized leg=${leg.id} symbol=${leg.symbol} op=${args.operation}: ${cleanup.notes.join(', ')}`);
            }
            Object.assign(args, cleanup.args);
        }
        const t0 = Date.now();
        try {
            const result = await this.sendWithStopsFallback(leg, args);
            // Mark fired immediately after OrderSend so a slow trades insert / log write
            // cannot leave the row `claimed` and get reset to `pending` (30s stale reclaim).
            await this.markLegFiredWithRetry(leg.id, result.ticket ?? null);
            const latencyMs = Date.now() - t0;
            console.log(`[virtualPendingMonitor] virtual leg fired signal=${leg.signal_id} stepIdx=${leg.step_idx} trigger=${leg.trigger_price} ref=${refPrice} ticket=${result.ticket} latency=${latencyMs}ms`);
            const entryPx = result.openPrice ?? refPrice ?? null;
            const openSl = result.stopLoss ?? args.stoploss ?? null;
            const manual = await this.loadManualSettingsForLeg(leg.broker_account_id, channelIdForTrade);
            const autoBeCols = (0, autoManagement_1.autoManagementTradeSnapshot)(manual, entryPx, openSl);
            const { data: insTrade, error: insErr } = await this.supabase.from('trades').insert({
                user_id: leg.user_id,
                signal_id: leg.signal_id,
                telegram_channel_id: channelIdForTrade,
                broker_account_id: leg.broker_account_id,
                metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
                symbol: leg.symbol,
                direction: leg.is_buy ? 'buy' : 'sell',
                entry_price: entryPx,
                sl: openSl,
                tp: result.takeProfit ?? args.takeprofit ?? null,
                lot_size: result.lots ?? args.volume,
                status: 'open',
                opened_at: new Date().toISOString(),
                // Carry the CWE threshold forward so cweCloseMonitor watches the
                // newly-filled leg alongside its sibling immediates. Null for
                // non-CWE pendings.
                cwe_close_price: leg.cwe_close_price,
                ...autoBeCols,
            }).select('id').maybeSingle();
            if (insErr) {
                console.warn(`[virtualPendingMonitor] trades insert failed leg=${leg.id}: ${insErr.message}`);
            }
            const ticketNum = result.ticket != null ? Number(result.ticket) : NaN;
            const tradeRowId = insTrade?.id ?? null;
            if (tradeRowId
                && Number.isFinite(ticketNum)
                && ticketNum > 0
                && (0, fxsocketClient_1.hasFxsocketConfigured)()) {
                try {
                    await (0, basketModFollowUp_1.tryApplyBasketFollowUpToNewFill)(this.supabase, api, {
                        userId: leg.user_id,
                        basketSignalId: leg.signal_id,
                        brokerAccountId: leg.broker_account_id,
                        metaUuid: leg.metaapi_account_id,
                        symbol: leg.symbol,
                        ticket: ticketNum,
                        tradeRowId,
                        entryPrice: entryPx,
                        existingSl: result.stopLoss ?? args.stoploss ?? null,
                        existingTp: result.takeProfit ?? args.takeprofit ?? null,
                        isBuy: leg.is_buy,
                    });
                }
                catch (hookErr) {
                    console.warn(`[virtualPendingMonitor] SL/TP follow-up for range leg=${leg.id} signal=${leg.signal_id}:`, hookErr);
                }
                // Brief pause so the new trade row is visible before the basket-wide rebalance query.
                await new Promise(r => setTimeout(r, 500));
                try {
                    await this.rebalanceRangeBasketTakeProfits(leg, { forceLayeringRebalance: true });
                }
                catch (rebalErr) {
                    console.warn(`[virtualPendingMonitor] TP rebalance after range fill leg=${leg.id} signal=${leg.signal_id}:`, rebalErr);
                }
            }
            else if (tradeRowId && Number.isFinite(ticketNum) && ticketNum > 0) {
                console.warn(`[virtualPendingMonitor] skip TP rebalance leg=${leg.id} signal=${leg.signal_id}: fxsocket not configured`);
            }
            try {
                await this.supabase.from('trade_execution_logs').insert({
                    user_id: leg.user_id,
                    signal_id: leg.signal_id,
                    broker_account_id: leg.broker_account_id,
                    action: 'virtual_pending_fired',
                    status: 'success',
                    request_payload: {
                        leg_id: leg.id,
                        step_idx: leg.step_idx,
                        trigger_price: leg.trigger_price,
                        ref_price: refPrice,
                    },
                    response_payload: { ticket: result.ticket, latency_ms: latencyMs, claimed_by: this.hostId },
                });
            }
            catch {
                /* logging is best-effort; leg is already `fired` */
            }
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[virtualPendingMonitor] fire failed leg=${leg.id} signal=${leg.signal_id} stepIdx=${leg.step_idx}: ${msg}`);
            if ((0, brokerConnectError_1.isMtBridgeGlitchMessage)(msg)) {
                await this.supabase
                    .from('range_pending_legs')
                    .update({
                    status: 'pending',
                    claimed_at: null,
                    claimed_by: null,
                    error_message: null,
                })
                    .eq('id', leg.id);
                console.warn(`[virtualPendingMonitor] bridge glitch leg=${leg.id} — released back to pending for retry`);
                return false;
            }
            await this.supabase
                .from('range_pending_legs')
                .update({ status: 'failed', error_message: msg, fired_at: new Date().toISOString() })
                .eq('id', leg.id);
            await this.supabase.from('trade_execution_logs').insert({
                user_id: leg.user_id,
                signal_id: leg.signal_id,
                broker_account_id: leg.broker_account_id,
                action: 'virtual_pending_failed',
                status: 'failed',
                request_payload: { leg_id: leg.id, step_idx: leg.step_idx, claimed_by: this.hostId },
                error_message: msg,
            });
            return false;
        }
    }
    /**
     * All `step_idx` values that still have a `pending` or `claimed` row for this
     * basket (same metaapi account + symbol). Used so deeper rungs never fire
     * before shallower ones on the same quote tick.
     */
    async fetchShallowActiveSteps(metaapiAccountId, symbol, signalIds) {
        const out = new Map();
        if (!signalIds.length)
            return out;
        const { data, error } = await this.supabase
            .from('range_pending_legs')
            .select('signal_id, broker_account_id, step_idx')
            .eq('metaapi_account_id', metaapiAccountId)
            .eq('symbol', symbol)
            .in('signal_id', signalIds)
            .in('status', ['pending', 'claimed'])
            .not('comment', 'ilike', '%:strictEntry%')
            .not('comment', 'ilike', '%:strictEntryAgg%');
        if (error) {
            console.warn(`[virtualPendingMonitor] fetchShallowActiveSteps failed: ${error.message}`);
            return out;
        }
        for (const r of (data ?? [])) {
            const bk = `${r.signal_id}|${r.broker_account_id}`;
            const s = out.get(bk) ?? new Set();
            s.add(r.step_idx);
            out.set(bk, s);
        }
        return out;
    }
    async getStaleLegReason(leg, api, metaapiAccountId) {
        return (0, rangePendingBasketCleanup_1.reconcileBasketFlatFromBroker)(this.supabase, api ?? null, metaapiAccountId, { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id });
    }
    async cancelClaimedLeg(leg, reason) {
        await (0, rangePendingBasketCleanup_1.deleteRangePendingLegsForBasket)(this.supabase, { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id }, reason);
        try {
            await this.supabase.from('trade_execution_logs').insert({
                user_id: leg.user_id,
                signal_id: leg.signal_id,
                broker_account_id: leg.broker_account_id,
                action: 'virtual_pending_cancelled',
                status: 'info',
                request_payload: {
                    leg_id: leg.id,
                    step_idx: leg.step_idx,
                    symbol: leg.symbol,
                    reason,
                    claimed_by: this.hostId,
                },
            });
        }
        catch {
            // Logging failure is non-fatal.
        }
    }
    async rebalanceRangeBasketTakeProfits(leg, opts) {
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
            return;
        const { data: signalRow, error: signalErr } = await this.supabase
            .from('signals')
            .select('parsed_data, channel_id, created_at')
            .eq('id', leg.signal_id)
            .maybeSingle();
        if (signalErr) {
            console.warn(`[virtualPendingMonitor] signal load failed for rebalance signal=${leg.signal_id}: ${signalErr.message}`);
            return;
        }
        const channelId = (signalRow?.channel_id ?? null);
        const basketCreatedAt = (signalRow?.created_at ?? null);
        const rawManual = await this.loadManualSettingsForLeg(leg.broker_account_id, channelId);
        const manual = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(rawManual);
        if (manual.range_trading !== true)
            return;
        const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(this.platformByUuid, leg.metaapi_account_id);
        if (!api)
            return;
        const params = await this.getSymbolParams(leg.metaapi_account_id, leg.symbol);
        const parsed = (0, rangeBasketTpSync_1.toRangeBasketParsedSlice)((signalRow?.parsed_data ?? null));
        await (0, rangeBasketTpSync_1.syncRangeBasketTakeProfits)({
            supabase: this.supabase,
            api,
            uuid: leg.metaapi_account_id,
            symbol: leg.symbol,
            direction: leg.is_buy ? 'buy' : 'sell',
            baseLot: 0.01,
            params: params
                ? {
                    digits: params.digits,
                    point: params.point,
                    minLot: params.minLot,
                    lotStep: params.lotStep,
                    contractSize: params.contractSize,
                    stopsLevel: params.stopsLevel,
                    freezeLevel: params.freezeLevel,
                }
                : null,
            signalId: leg.signal_id,
            userId: leg.user_id,
            brokerAccountId: leg.broker_account_id,
            manual,
            parsed,
            plan: null,
            forceLayeringRebalance: opts?.forceLayeringRebalance,
            channelId,
            basketCreatedAt,
        });
    }
    async loadManualSettingsForLeg(brokerAccountId, channelId) {
        const cacheKey = `${brokerAccountId}|${channelId ?? ''}`;
        const cached = this.brokerConfigCache.get(cacheKey);
        if (cached && Date.now() - cached.loadedAt < SYMBOL_TTL_MS) {
            return cached.manual;
        }
        const { data, error } = await this.supabase
            .from('broker_accounts')
            .select('manual_settings,channel_trading_configs,copier_mode,signal_channel_ids')
            .eq('id', brokerAccountId)
            .maybeSingle();
        if (error || !data)
            return {};
        const resolved = (0, channelTradingConfig_1.resolveChannelTradingConfig)(data, channelId);
        this.brokerConfigCache.set(cacheKey, {
            manual: resolved.manual_settings,
            loadedAt: Date.now(),
        });
        return resolved.manual_settings;
    }
    async getSymbolParams(uuid, symbol) {
        const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(this.platformByUuid, uuid);
        if (!api)
            return null;
        const key = `${uuid}:${symbol.toUpperCase()}`;
        const cached = this.symbolCache.get(key);
        if (cached && (Date.now() - cached.loadedAt) < SYMBOL_TTL_MS)
            return cached;
        try {
            const p = await api.symbolParams(uuid, symbol);
            const n = (0, fxsocketClient_1.normalizeSymbolParams)(p);
            const entry = {
                digits: n.digits ?? 5,
                point: n.point ?? 0.00001,
                minLot: n.minLot ?? 0.01,
                lotStep: n.lotStep ?? 0.01,
                contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
                stopsLevel: Math.max(0, n.stopsLevel ?? 0),
                freezeLevel: Math.max(0, n.freezeLevel ?? 0),
                loadedAt: Date.now(),
            };
            this.symbolCache.set(key, entry);
            return entry;
        }
        catch {
            return null;
        }
    }
    /**
     * Mirror of tradeExecutor.clampOrderStops — kept inline to avoid coupling the
     * monitor to the executor module. Push SL/TP outside the larger of
     * stops_level / freeze_level so MT5 can't reject the market send.
     */
    clampOrderStops(args, refPrice, params) {
        const adjustments = [];
        const point = Number(params.point) || 0;
        const minLevel = Math.max(params.stopsLevel, params.freezeLevel);
        const minDist = (minLevel + 2) * point;
        if (point <= 0 || minDist <= 0 || refPrice <= 0)
            return { args, adjustments };
        const digits = Math.max(0, Math.min(8, Math.floor(params.digits)));
        const round = (v) => Number(v.toFixed(digits));
        const isBuy = String(args.operation) === 'Buy';
        let sl = Number(args.stoploss) || 0;
        let tp = Number(args.takeprofit) || 0;
        const original = { sl, tp };
        if (isBuy) {
            if (sl > 0 && refPrice - sl < minDist)
                sl = round(refPrice - minDist);
            if (tp > 0 && tp - refPrice < minDist)
                tp = round(refPrice + minDist);
        }
        else {
            if (sl > 0 && sl - refPrice < minDist)
                sl = round(refPrice + minDist);
            if (tp > 0 && refPrice - tp < minDist)
                tp = round(refPrice - minDist);
        }
        if (sl !== original.sl)
            adjustments.push(`sl ${original.sl} → ${sl}`);
        if (tp !== original.tp)
            adjustments.push(`tp ${original.tp} → ${tp}`);
        if (adjustments.length === 0)
            return { args, adjustments };
        return { args: { ...args, stoploss: sl, takeprofit: tp }, adjustments };
    }
    /**
     * Final safety pass after `clampOrderStops`. If the clamped TP/SL is still on
     * the wrong side of the live reference price for the order's direction (which
     * happens when the broker's real stops_level is larger than `/SymbolParams`
     * reports, or when the signal TP was reached before our leg fired), drop the
     * bad side instead of sending a guaranteed-rejected order.
     */
    sanitizeStops(args, refPrice) {
        if (!Number.isFinite(refPrice) || refPrice <= 0)
            return { args, notes: [] };
        const notes = [];
        const isBuy = String(args.operation) === 'Buy';
        let sl = Number(args.stoploss) || 0;
        let tp = Number(args.takeprofit) || 0;
        if (isBuy) {
            // Buy: TP must sit ABOVE ref, SL must sit BELOW ref.
            if (tp > 0 && tp <= refPrice) {
                notes.push(`tp ${tp} <= ref ${refPrice} (wrong side for Buy) → dropping TP`);
                tp = 0;
            }
            if (sl > 0 && sl >= refPrice) {
                notes.push(`sl ${sl} >= ref ${refPrice} (wrong side for Buy) → dropping SL`);
                sl = 0;
            }
        }
        else {
            // Sell: TP must sit BELOW ref, SL must sit ABOVE ref.
            if (tp > 0 && tp >= refPrice) {
                notes.push(`tp ${tp} >= ref ${refPrice} (wrong side for Sell) → dropping TP`);
                tp = 0;
            }
            if (sl > 0 && sl <= refPrice) {
                notes.push(`sl ${sl} <= ref ${refPrice} (wrong side for Sell) → dropping SL`);
                sl = 0;
            }
        }
        if (notes.length === 0)
            return { args, notes };
        return { args: { ...args, stoploss: sl, takeprofit: tp }, notes };
    }
    /**
     * Send a market order; if the broker rejects with "Invalid stops" despite our
     * clamp/sanitize passes, retry once with SL=0 and TP=0 so the leg actually
     * opens. The user has explicitly opted into averaging-down by enabling range
     * trading — opening the leg without stops is strictly preferable to silently
     * dropping it. Subsequent SL/TP management can be done by the signal-modify
     * flow once the position is on the books.
     */
    async sendWithStopsFallback(leg, args) {
        const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(this.platformByUuid, leg.metaapi_account_id);
        if (!api)
            throw new Error('api unavailable');
        try {
            return await api.orderSend(leg.metaapi_account_id, args);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isInvalidStops = /invalid\s+stops/i.test(msg);
            const hasStops = (Number(args.stoploss) || 0) > 0 || (Number(args.takeprofit) || 0) > 0;
            if (isInvalidStops && hasStops) {
                console.warn(`[virtualPendingMonitor] retry without stops leg=${leg.id} signal=${leg.signal_id} stepIdx=${leg.step_idx} reason="${msg}" (sl=${args.stoploss} tp=${args.takeprofit})`);
                const fallback = { ...args, stoploss: 0, takeprofit: 0 };
                return await api.orderSend(leg.metaapi_account_id, fallback);
            }
            throw err;
        }
    }
}
exports.VirtualPendingMonitor = VirtualPendingMonitor;
VirtualPendingMonitor.PROFIT_SKIP_LOG_MS = 60000;
