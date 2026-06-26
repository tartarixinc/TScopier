"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.V2ReconcileMonitor = void 0;
exports.buildDesiredLegTargets = buildDesiredLegTargets;
const fxClient_1 = require("./fxClient");
const reconciler_1 = require("./reconciler");
const basketSlTpReconcile_1 = require("../basketSlTpReconcile");
const basketEffectiveStops_1 = require("../basketEffectiveStops");
const helpers_1 = require("../tradeExecutor/helpers");
const fxsocketClient_1 = require("../fxsocketClient");
const executionMode_1 = require("./executionMode");
const TICK_MS = Math.min(60000, Math.max(1000, Number(process.env.V2_RECONCILE_TICK_MS ?? 4000)));
function legTicket(leg) {
    const t = Number(leg.metaapi_order_id);
    return Number.isFinite(t) && t > 0 ? t : null;
}
function deepestTp(tpLevels, isBuy) {
    if (!tpLevels.length)
        return null;
    // Deepest = farthest target: highest for buy, lowest for sell.
    return isBuy ? Math.max(...tpLevels) : Math.min(...tpLevels);
}
/**
 * Pure: compute the per-leg SL/TP the basket SHOULD have right now, given the
 * basket-level effective SL/TP (resolved upstream by v1's resolveEffectiveBasketStops,
 * which already merges target store + channel memory + latest mgmt instruction).
 *  - SL: the effective basket SL applied to every leg, EXCEPT a leg with its own
 *    breakeven SL (auto-breakeven OR manual channel breakeven, both stamp
 *    auto_be_applied_at). Such a leg keeps its OWN entry-relative SL so a multi-entry
 *    basket is never collapsed onto one shared breakeven SL — UNLESS the effective SL
 *    comes from an explicit, newer instruction (basket_target / mgmt_signal), which
 *    resolveEffectiveBasketStops only surfaces when it is newer than the breakeven;
 *    then the latest instruction wins for the whole basket.
 *  - TP: the DB leg's TP is the basket's INTENDED per-leg target (set by the
 *    distributed plan, a management modify, or the merge apply) and is authoritative
 *    over the live broker snapshot. Preferring it (a) stops a reconcile tick that
 *    races an in-flight distribution from collapsing every leg to the deepest ladder
 *    TP when a leg still looks naked on the broker, and (b) lets the tick SELF-HEAL
 *    broker drift back to the intended distributed TP instead of getting stuck on a
 *    once-applied deepest TP. Order: intended DB TP > live broker TP > deepest ladder
 *    TP (only for a leg that is genuinely naked everywhere). A hit TP closes its leg,
 *    so an open leg's intended TP is never a taken target.
 */
function buildDesiredLegTargets(args) {
    const byTicket = new Map();
    for (const o of args.snapshot)
        byTicket.set(o.ticket, o);
    const baseSl = args.effectiveSl != null && args.effectiveSl > 0 ? args.effectiveSl : null;
    const explicitBasketInstruction = args.effectiveSource === 'basket_target' || args.effectiveSource === 'mgmt_signal';
    const out = [];
    for (const leg of args.legs) {
        const ticket = legTicket(leg);
        if (ticket == null)
            continue;
        const o = byTicket.get(ticket);
        if (!o)
            continue; // not at broker -> reconciler closedTickets handles it
        let sl = baseSl;
        // A leg at breakeven (per-leg, entry-relative) keeps EXACTLY its own SL — never
        // merged up to a basket-level / most-protective SL, which would force every leg
        // onto the deepest leg's breakeven. An explicit newer instruction overrides it.
        const beSl = leg.auto_be_applied_at && leg.sl != null && leg.sl > 0 ? leg.sl : null;
        if (beSl != null) {
            sl = explicitBasketInstruction ? (baseSl ?? beSl) : beSl;
        }
        const intendedTp = leg.tp != null && leg.tp > 0 ? leg.tp : null;
        const existingTp = o.takeProfit != null && o.takeProfit > 0 ? o.takeProfit : null;
        const fillTp = intendedTp ?? existingTp ?? deepestTp(args.effectiveTpLevels, args.isBuy);
        out.push({ ticket, stoploss: sl, takeProfit: fillTp });
    }
    return out;
}
/** The single management-first reconcile loop for v2 brokers. */
class V2ReconcileMonitor {
    constructor(supabase, fx) {
        this.supabase = supabase;
        this.timer = null;
        this.ticking = false;
        this.fx = fx ?? (0, fxClient_1.getFxClient)();
    }
    start() {
        if (this.timer)
            return;
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)() && !process.env.FXSOCKET_API_KEY) {
            console.warn('[v2ReconcileMonitor] FxSocket not configured — disabled');
            return;
        }
        this.timer = setInterval(() => void this.runTick(), TICK_MS);
        console.log(`[v2ReconcileMonitor] started tick=${TICK_MS}ms (v2 brokers only)`);
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    async runTick() {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            await this.tick();
        }
        catch (err) {
            console.warn(`[v2ReconcileMonitor] tick failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            this.ticking = false;
        }
    }
    /** Enumerate v2 baskets, then reconcile each. */
    async tick() {
        const { data, error } = await this.supabase
            .from('trades')
            .select('broker_account_id,signal_id,symbol,direction')
            .eq('status', 'open')
            .limit(5000);
        if (error || !data)
            return { baskets: 0, modified: 0, closed: 0 };
        const baskets = new Map();
        for (const r of data) {
            if (!r.broker_account_id || !r.signal_id)
                continue;
            if (!(0, executionMode_1.isV2)({ brokerAccountId: r.broker_account_id }))
                continue;
            const key = `${r.broker_account_id}|${r.signal_id}|${r.symbol}`;
            if (!baskets.has(key)) {
                baskets.set(key, {
                    brokerAccountId: r.broker_account_id,
                    anchorSignalId: r.signal_id,
                    symbol: r.symbol,
                    isBuy: String(r.direction).toLowerCase().startsWith('buy'),
                });
            }
        }
        const sessions = await this.loadSessions([...baskets.values()].map(b => b.brokerAccountId));
        let modified = 0;
        let closed = 0;
        for (const basket of baskets.values()) {
            const session = sessions.get(basket.brokerAccountId);
            if (!session)
                continue;
            const res = await this.reconcileBasket(basket, session).catch(() => null);
            if (res) {
                modified += res.modified;
                closed += res.closed;
            }
        }
        return { baskets: baskets.size, modified, closed };
    }
    async loadSessions(brokerIds) {
        const out = new Map();
        const unique = [...new Set(brokerIds)];
        if (!unique.length)
            return out;
        const { data } = await this.supabase
            .from('broker_accounts')
            .select('id,user_id,fxsocket_account_id,metaapi_account_id,platform')
            .in('id', unique);
        for (const b of (data ?? [])) {
            const uuid = (0, helpers_1.brokerSessionUuid)(b);
            if (!uuid)
                continue;
            const platform = String(b.platform).toUpperCase() === 'MT4' ? 'MT4' : 'MT5';
            out.set(b.id, { uuid, platform, userId: b.user_id ?? null });
        }
        return out;
    }
    async reconcileBasket(basket, session) {
        const legs = await (0, basketSlTpReconcile_1.loadOpenBasketLegs)(this.supabase, basket.brokerAccountId, basket.anchorSignalId, basket.symbol);
        if (!legs.length)
            return { modified: 0, closed: 0 };
        // Resolve the basket's effective SL/TP exactly like v1 (target store + channel
        // memory + latest mgmt instruction + auto-BE recency) so merged baskets and
        // channel-memory adjustments are honored - not just the raw target-store row.
        const { data: anchorSig } = await this.supabase
            .from('signals')
            .select('parsed_data, channel_id, user_id, created_at')
            .eq('id', basket.anchorSignalId)
            .maybeSingle();
        const anchorParsed = anchorSig?.parsed_data ?? {};
        const eff = await (0, basketEffectiveStops_1.resolveEffectiveBasketStops)({
            supabase: this.supabase,
            userId: anchorSig?.user_id ?? session.userId ?? '',
            channelId: anchorSig?.channel_id ?? null,
            anchorSignalId: basket.anchorSignalId,
            symbol: basket.symbol,
            basketCreatedAt: anchorSig?.created_at ?? legs[0]?.opened_at ?? null,
            anchorParsed: { sl: anchorParsed.sl ?? null, tp: anchorParsed.tp ?? null },
            familyTrades: legs,
            brokerAccountId: basket.brokerAccountId,
        }).catch(() => null);
        // SAFETY: the broker snapshot is the source of truth for "is this leg still open?".
        // If the fetch FAILS we must NOT proceed - an empty list would be read as
        // "every leg vanished" and wrongly mark all legs closed in the DB. Abort instead.
        let snapshot;
        try {
            snapshot = await this.fx.openedOrders(session.uuid, session.platform);
        }
        catch (err) {
            console.warn(`[v2ReconcileMonitor] snapshot failed broker=${basket.brokerAccountId} anchor=${basket.anchorSignalId} — skipping (no close): ${err instanceof Error ? err.message : String(err)}`);
            return { modified: 0, closed: 0 };
        }
        const desiredTargets = buildDesiredLegTargets({
            legs,
            snapshot,
            effectiveSl: eff && eff.stoploss > 0 ? eff.stoploss : null,
            effectiveTpLevels: eff?.tpLevels ?? [],
            isBuy: basket.isBuy,
            effectiveSource: eff?.source,
        });
        const trackedTickets = legs.map(legTicket).filter((t) => t != null);
        const actions = (0, reconciler_1.computeReconcileActions)({
            desired: desiredTargets,
            openOrders: snapshot,
            trackedTickets,
        });
        // Orphan adoption is log-only on the first management-first run.
        const orphanCount = actions.adopt.length;
        actions.adopt = [];
        // SAFETY: never mass-close a basket off an empty snapshot. A disconnected
        // FxSocket session can return an empty (but successful) OpenedOrders list; that
        // must not be read as "all legs closed". Only honor closes when the snapshot
        // actually shows other open orders (a real account picture).
        if (snapshot.length === 0 && actions.closedTickets.length > 0) {
            console.warn(`[v2ReconcileMonitor] empty snapshot with ${actions.closedTickets.length} tracked legs broker=${basket.brokerAccountId} anchor=${basket.anchorSignalId} — deferring close (suspected disconnect)`);
            actions.closedTickets = [];
        }
        const ticketToTradeId = new Map();
        for (const leg of legs) {
            const t = legTicket(leg);
            if (t != null)
                ticketToTradeId.set(t, leg.id);
        }
        const result = await (0, reconciler_1.applyReconcileActions)({
            fx: this.fx,
            accountId: session.uuid,
            platform: session.platform,
            markClosed: async (ticket) => {
                const id = ticketToTradeId.get(ticket);
                if (id)
                    await (0, basketSlTpReconcile_1.closeStaleOpenTrades)(this.supabase, [id]);
            },
            adoptOrphan: async () => { },
        }, actions);
        if (result.modified > 0 || result.closed > 0 || result.modifyFailed > 0 || orphanCount > 0) {
            await this.logTick(basket, session.userId, { ...result, legs: legs.length, orphanCount });
        }
        return { modified: result.modified, closed: result.closed };
    }
    async logTick(basket, userId, payload) {
        if (!userId)
            return;
        try {
            await this.supabase.from('trade_execution_logs').insert({
                user_id: userId,
                signal_id: basket.anchorSignalId,
                broker_account_id: basket.brokerAccountId,
                action: 'v2_reconcile_tick',
                status: payload.modifyFailed > 0 ? 'failed' : 'success',
                request_payload: {
                    anchor_signal_id: basket.anchorSignalId,
                    symbol: basket.symbol,
                    ...payload,
                },
            });
        }
        catch { /* best-effort */ }
    }
}
exports.V2ReconcileMonitor = V2ReconcileMonitor;
