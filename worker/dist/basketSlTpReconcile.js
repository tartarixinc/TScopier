"use strict";
/**
 * Shared basket SL/TP modify + reconcile job persistence.
 * Used by tradeExecutor (realtime), BasketSlTpReconcileMonitor, and edge sweep.
 */
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
exports.GHOST_BASKET_CLOSED_USER_MESSAGE = void 0;
exports.clampBasketOrderStops = clampBasketOrderStops;
exports.roundBasketLot = roundBasketLot;
exports.fetchOpenBrokerTickets = fetchOpenBrokerTickets;
exports.fetchOpenBrokerTicketsStrict = fetchOpenBrokerTicketsStrict;
exports.classifyGhostBasketLegs = classifyGhostBasketLegs;
exports.closeStaleOpenTrades = closeStaleOpenTrades;
exports.markBasketReconcileDoneForAnchor = markBasketReconcileDoneForAnchor;
exports.logBasketLegModify = logBasketLegModify;
exports.runBasketLegModifies = runBasketLegModifies;
exports.reconcileBackoffMs = reconcileBackoffMs;
exports.upsertBasketReconcileJob = upsertBasketReconcileJob;
exports.markBasketReconcileDone = markBasketReconcileDone;
exports.loadOpenBasketLegs = loadOpenBasketLegs;
exports.parsePerLegTargets = parsePerLegTargets;
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const basketModFollowUp_1 = require("./basketModFollowUp");
const channelActiveTradeParams_1 = require("./channelActiveTradeParams");
const orderModifyBenign_1 = require("./orderModifyBenign");
function isBuySideOp(op) {
    return op === 'Buy' || op === 'BuyLimit' || op === 'BuyStop' || op === 'BuyStopLimit';
}
function clampBasketOrderStops(args, params) {
    const adjustments = [];
    if (!params)
        return { args, adjustments };
    const point = Number(params.point) || 0;
    const stopsLevel = Number(params.stopsLevel) || 0;
    const freezeLevel = Number(params.freezeLevel) || 0;
    if (point <= 0)
        return { args, adjustments };
    const minLevel = Math.max(stopsLevel, freezeLevel);
    const minDist = (minLevel + 2) * point;
    const ref = Number(args.price) || 0;
    if (ref <= 0 || minDist <= 0)
        return { args, adjustments };
    const digits = Math.max(0, Math.min(8, Number(params.digits) || 5));
    const round = (v) => Number(v.toFixed(digits));
    const isBuy = isBuySideOp(String(args.operation));
    let sl = Number(args.stoploss) || 0;
    let tp = Number(args.takeprofit) || 0;
    const original = { sl, tp };
    if (isBuy) {
        if (sl > 0 && ref - sl < minDist)
            sl = round(ref - minDist);
        if (tp > 0 && tp - ref < minDist)
            tp = round(ref + minDist);
    }
    else {
        if (sl > 0 && sl - ref < minDist)
            sl = round(ref + minDist);
        if (tp > 0 && ref - tp < minDist)
            tp = round(ref - minDist);
    }
    if (sl !== original.sl)
        adjustments.push(`sl ${original.sl} → ${sl}`);
    if (tp !== original.tp)
        adjustments.push(`tp ${original.tp} → ${tp}`);
    if (adjustments.length === 0)
        return { args, adjustments };
    return { args: { ...args, stoploss: sl, takeprofit: tp }, adjustments };
}
function roundBasketLot(volume, params) {
    const step = params?.lotStep ?? 0.01;
    const min = params?.minLot ?? 0.01;
    const rounded = Math.round(volume / step) * step;
    return Math.max(min, +rounded.toFixed(2));
}
function ingestBrokerTickets(orders) {
    const tickets = new Set();
    for (const raw of orders ?? []) {
        if (!raw || typeof raw !== 'object')
            continue;
        const o = raw;
        const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0);
        if (Number.isFinite(ticket) && ticket > 0)
            tickets.add(ticket);
    }
    return tickets;
}
/** Tickets currently open on the broker account (from /OpenedOrders). */
async function fetchOpenBrokerTickets(api, uuid) {
    try {
        const orders = await api.openedOrders(uuid);
        return ingestBrokerTickets(orders);
    }
    catch {
        /* caller treats empty set as "skip preflight" */
        return new Set();
    }
}
/** Same as fetchOpenBrokerTickets but propagates API errors (for ghost-basket reconcile). */
async function fetchOpenBrokerTicketsStrict(api, uuid) {
    const orders = await api.openedOrders(uuid);
    return ingestBrokerTickets(orders);
}
function classifyGhostBasketLegs(familyTrades, brokerTickets) {
    const onBroker = [];
    const ghost = [];
    for (const tr of familyTrades) {
        const ticket = Number(tr.metaapi_order_id);
        if (!Number.isFinite(ticket) || ticket <= 0) {
            ghost.push(tr);
            continue;
        }
        if (brokerTickets.has(ticket))
            onBroker.push(tr);
        else
            ghost.push(tr);
    }
    return { onBroker, ghost };
}
/** Mark DB open legs closed when they are absent from the broker (manual close / expired session). */
async function closeStaleOpenTrades(supabase, tradeIds) {
    if (!tradeIds.length)
        return 0;
    const { data: targets, error: loadErr } = await supabase
        .from('trades')
        .select('id,signal_id,broker_account_id')
        .in('id', tradeIds)
        .eq('status', 'open');
    if (loadErr) {
        console.warn(`[basketSlTpReconcile] closeStaleOpenTrades load failed: ${loadErr.message}`);
        return 0;
    }
    const rows = (targets ?? []);
    if (!rows.length)
        return 0;
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('trades')
        .update({ status: 'closed', closed_at: now })
        .in('id', rows.map(r => r.id))
        .eq('status', 'open')
        .select('id');
    if (error) {
        console.warn(`[basketSlTpReconcile] closeStaleOpenTrades failed: ${error.message}`);
        return 0;
    }
    const closed = (data ?? []).length;
    if (closed > 0) {
        const { purgeRangePendingLegsForBaskets } = await Promise.resolve().then(() => __importStar(require('./rangePendingLegDelete')));
        await purgeRangePendingLegsForBaskets(supabase, rows.map(r => ({ signalId: r.signal_id, brokerAccountId: r.broker_account_id })), 'basket_flat');
    }
    return closed;
}
async function markBasketReconcileDoneForAnchor(supabase, brokerAccountId, anchorSignalId) {
    const { data: existingJob } = await supabase
        .from('basket_reconcile_jobs')
        .select('id')
        .eq('broker_account_id', brokerAccountId)
        .eq('anchor_signal_id', anchorSignalId)
        .maybeSingle();
    if (existingJob?.id) {
        await markBasketReconcileDone(supabase, existingJob.id);
    }
}
exports.GHOST_BASKET_CLOSED_USER_MESSAGE = 'Open basket existed only in TSCopier (not on the broker); stale legs were closed. Send a new entry to open on MT.';
function stopsAlreadyMatch(tr, target, nImmCwe, legIdx) {
    return (0, orderModifyBenign_1.stopsAlreadyMatchDb)(tr, target, nImmCwe, legIdx);
}
async function logBasketLegModify(supabase, args) {
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: args.userId,
            signal_id: args.signalId,
            broker_account_id: args.brokerAccountId,
            action: 'basket_leg_modify',
            status: args.status,
            error_message: args.errorMessage ?? args.skipReason ?? null,
            request_payload: {
                trade_id: args.tradeId,
                ticket: args.ticket,
                leg_index: args.legIndex,
                broker_symbol: args.brokerSymbol,
                target_sl: args.targetSl,
                target_tp: args.targetTp,
                skip_reason: args.skipReason ?? null,
            },
        });
    }
    catch { /* best-effort */ }
}
async function runBasketLegModifies(args) {
    const { supabase, api, uuid, symbol, direction, baseLot, params, signalId, userId, brokerAccountId, familyTrades, perLegTargets: rawTargets, signalTps, tpLots, nImmCwe, strictEntryPrefetch, openedTickets, skipAlreadySynced, alreadyModified, } = args;
    const parsedTps = (signalTps ?? []).filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
    const perLegTargets = (0, tpBucketDistribution_1.expandPerLegTargetsToCount)({
        targets: rawTargets,
        openLegCount: familyTrades.length,
        finalTps: parsedTps.length
            ? parsedTps
            : rawTargets.map(t => t.takeprofit).filter(tp => tp > 0),
        tpLots,
    });
    const summary = {
        openLegs: familyTrades.length,
        attempted: 0,
        modified: 0,
        failed: 0,
        skippedNoTicket: 0,
        skippedNotOnBroker: 0,
    };
    const legErrors = [];
    const modifiedTradeIds = [];
    const usePreflight = openedTickets != null && openedTickets.size >= 0;
    const legModifyGapMs = Math.max(0, Number(process.env.BASKET_LEG_MODIFY_GAP_MS ?? 50) || 0);
    for (let i = 0; i < familyTrades.length; i++) {
        if (i > 0 && legModifyGapMs > 0) {
            await new Promise(resolve => setTimeout(resolve, legModifyGapMs));
        }
        const tr = familyTrades[i];
        if (alreadyModified?.has(tr.id)) {
            modifiedTradeIds.push(tr.id);
            summary.modified += 1;
            continue;
        }
        const target = perLegTargets[i];
        if (!target)
            continue;
        const legIdx = familyTrades.findIndex(t => t.id === tr.id);
        const cweIdx = legIdx >= 0 ? legIdx : i;
        if (skipAlreadySynced && stopsAlreadyMatch(tr, target, nImmCwe, cweIdx)) {
            modifiedTradeIds.push(tr.id);
            summary.modified += 1;
            continue;
        }
        const ticket = Number(tr.metaapi_order_id);
        if (!Number.isFinite(ticket) || ticket <= 0) {
            summary.skippedNoTicket += 1;
            continue;
        }
        if (usePreflight && !openedTickets.has(ticket)) {
            summary.skippedNotOnBroker += 1;
            const err = {
                trade_id: tr.id,
                ticket,
                leg_index: i + 1,
                broker_symbol: tr.symbol,
                target_sl: target.stoploss,
                target_tp: cweIdx < nImmCwe ? 0 : target.takeprofit,
                error: 'ticket not in OpenedOrders',
                skip_reason: 'skipped_not_on_broker',
            };
            legErrors.push(err);
            await logBasketLegModify(supabase, {
                userId,
                signalId,
                brokerAccountId,
                status: 'skipped',
                tradeId: tr.id,
                ticket,
                legIndex: i + 1,
                brokerSymbol: tr.symbol,
                targetSl: target.stoploss,
                targetTp: cweIdx < nImmCwe ? 0 : target.takeprofit,
                skipReason: 'skipped_not_on_broker',
            });
            continue;
        }
        summary.attempted += 1;
        let ref = Number(tr.entry_price) || 0;
        if (ref <= 0) {
            try {
                const q = strictEntryPrefetch ?? await api.quote(uuid, symbol);
                ref = direction === 'buy' ? q.ask : q.bid;
            }
            catch (err) {
                summary.failed += 1;
                const msg = err instanceof Error ? err.message : String(err);
                legErrors.push({
                    trade_id: tr.id,
                    ticket,
                    leg_index: i + 1,
                    broker_symbol: tr.symbol,
                    target_sl: target.stoploss,
                    target_tp: target.takeprofit,
                    error: msg,
                });
                await logBasketLegModify(supabase, {
                    userId,
                    signalId,
                    brokerAccountId,
                    status: 'failed',
                    tradeId: tr.id,
                    ticket,
                    legIndex: i + 1,
                    brokerSymbol: tr.symbol,
                    targetSl: target.stoploss,
                    targetTp: target.takeprofit,
                    errorMessage: msg,
                });
                continue;
            }
        }
        let stoploss = target.stoploss;
        let takeprofit = cweIdx < nImmCwe ? 0 : target.takeprofit;
        const stripped = (0, channelActiveTradeParams_1.stripInvalidStopsForSide)({
            stoploss,
            takeprofit,
            referencePrice: ref,
            isBuy: direction === 'buy',
        });
        if (stripped.stripped.length) {
            stoploss = stripped.stoploss;
            takeprofit = stripped.takeprofit;
            if (stoploss <= 0 && takeprofit <= 0) {
                summary.failed += 1;
                const err = {
                    trade_id: tr.id,
                    ticket,
                    leg_index: i + 1,
                    broker_symbol: tr.symbol,
                    target_sl: target.stoploss,
                    target_tp: target.takeprofit,
                    error: 'wrong_side_sl',
                    skip_reason: 'wrong_side_sl',
                };
                legErrors.push(err);
                await logBasketLegModify(supabase, {
                    userId,
                    signalId,
                    brokerAccountId,
                    status: 'skipped',
                    tradeId: tr.id,
                    ticket,
                    legIndex: i + 1,
                    brokerSymbol: tr.symbol,
                    targetSl: target.stoploss,
                    targetTp: target.takeprofit,
                    skipReason: 'wrong_side_sl',
                });
                continue;
            }
        }
        const sendShape = {
            symbol,
            operation: direction === 'buy' ? 'Buy' : 'Sell',
            volume: roundBasketLot(Number(tr.lot_size) || baseLot, params),
            price: ref,
            stoploss,
            takeprofit,
            slippage: 20,
            comment: `TSCopier:${signalId.slice(0, 8)}:refresh`,
            expertID: 909090,
        };
        const clamped = clampBasketOrderStops(sendShape, params);
        let modSl = clamped.args.stoploss ?? 0;
        let modTp = clamped.args.takeprofit ?? 0;
        // MT5 OrderModifySafe can null-ref when TP=0 is sent on a position that
        // already carries TP — keep the open leg's stops for unchanged fields.
        if (modTp <= 0 && nImmCwe === 0) {
            const curTp = Number(tr.tp);
            if (Number.isFinite(curTp) && curTp > 0)
                modTp = curTp;
        }
        if (modSl <= 0) {
            const curSl = Number(tr.sl);
            if (Number.isFinite(curSl) && curSl > 0)
                modSl = curSl;
        }
        if (modSl <= 0 && modTp <= 0) {
            summary.failed += 1;
            legErrors.push({
                trade_id: tr.id,
                ticket,
                leg_index: i + 1,
                broker_symbol: tr.symbol,
                target_sl: target.stoploss,
                target_tp: target.takeprofit,
                error: 'no_stops_to_apply',
                skip_reason: 'no_stops_to_apply',
            });
            await logBasketLegModify(supabase, {
                userId,
                signalId,
                brokerAccountId,
                status: 'skipped',
                tradeId: tr.id,
                ticket,
                legIndex: i + 1,
                brokerSymbol: tr.symbol,
                targetSl: target.stoploss,
                targetTp: target.takeprofit,
                skipReason: 'no_stops_to_apply',
            });
            continue;
        }
        try {
            const modRes = await api.orderModify(uuid, {
                ticket,
                stoploss: modSl,
                takeprofit: modTp,
            });
            const newSl = modRes.stopLoss ?? modSl ?? null;
            const newTp = modRes.takeProfit ?? modTp ?? null;
            const cweClose = cweIdx < nImmCwe ? args.overrideTp : null;
            await supabase.from('trades').update({
                sl: typeof newSl === 'number' && newSl > 0 ? newSl : null,
                tp: typeof newTp === 'number' && newTp > 0 ? newTp : null,
                cwe_close_price: typeof cweClose === 'number' && cweClose > 0 ? cweClose : null,
            }).eq('id', tr.id);
            modifiedTradeIds.push(tr.id);
            summary.modified += 1;
            await logBasketLegModify(supabase, {
                userId,
                signalId,
                brokerAccountId,
                status: 'success',
                tradeId: tr.id,
                ticket,
                legIndex: i + 1,
                brokerSymbol: tr.symbol,
                targetSl: modSl,
                targetTp: modTp,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if ((0, orderModifyBenign_1.isBenignOrderModifyError)(msg)) {
                modifiedTradeIds.push(tr.id);
                summary.modified += 1;
                await logBasketLegModify(supabase, {
                    userId,
                    signalId,
                    brokerAccountId,
                    status: 'skipped',
                    tradeId: tr.id,
                    ticket,
                    legIndex: i + 1,
                    brokerSymbol: tr.symbol,
                    targetSl: modSl,
                    targetTp: modTp,
                    skipReason: 'already_synced_on_broker',
                });
                continue;
            }
            summary.failed += 1;
            legErrors.push({
                trade_id: tr.id,
                ticket,
                leg_index: i + 1,
                broker_symbol: tr.symbol,
                target_sl: modSl,
                target_tp: modTp,
                error: msg,
            });
            console.warn(`[basketSlTpReconcile] OrderModify failed leg=${i + 1}/${familyTrades.length} trade=${tr.id}: ${msg}`);
            await logBasketLegModify(supabase, {
                userId,
                signalId,
                brokerAccountId,
                status: 'failed',
                tradeId: tr.id,
                ticket,
                legIndex: i + 1,
                brokerSymbol: tr.symbol,
                targetSl: modSl,
                targetTp: modTp,
                errorMessage: msg,
            });
        }
    }
    const stillMissingTicket = familyTrades.filter(tr => {
        const t = Number(tr.metaapi_order_id);
        return !Number.isFinite(t) || t <= 0;
    }).length;
    summary.skippedNoTicket = stillMissingTicket;
    summary.failed = Math.max(0, familyTrades.length - summary.modified - stillMissingTicket - summary.skippedNotOnBroker);
    return { summary, legErrors, modifiedTradeIds };
}
function reconcileBackoffMs(attempts) {
    const base = Number(process.env.BASKET_RECONCILE_BACKOFF_MS ?? 15000);
    const capped = Math.min(base * Math.pow(2, Math.min(attempts, 4)), 300000);
    return capped;
}
async function upsertBasketReconcileJob(supabase, args) {
    const maxAttempts = Math.min(120, Math.max(6, Number(process.env.BASKET_RECONCILE_MAX_ATTEMPTS ?? 48)));
    const parsedTps = (args.signalTps ?? []).filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
    const storedTargets = (0, tpBucketDistribution_1.expandPerLegTargetsToCount)({
        targets: args.perLegTargets,
        openLegCount: Math.max(args.familyTrades.length, args.perLegTargets.length),
        finalTps: parsedTps.length
            ? parsedTps
            : args.perLegTargets.map(t => t.takeprofit).filter(tp => tp > 0),
        tpLots: args.tpLots,
    });
    const { data: job, error: jobErr } = await supabase
        .from('basket_reconcile_jobs')
        .upsert({
        user_id: args.userId,
        broker_account_id: args.brokerAccountId,
        anchor_signal_id: args.anchorSignalId,
        source_signal_id: args.sourceSignalId,
        channel_id: args.channelId,
        symbol: args.symbol,
        direction: args.direction,
        per_leg_targets: storedTargets,
        virtual_pendings_snapshot: args.virtualPendingsSnapshot ?? null,
        n_imm_cwe: args.nImmCwe,
        override_tp: args.overrideTp,
        status: 'pending',
        max_attempts: maxAttempts,
        next_run_at: new Date().toISOString(),
        last_error: args.lastError,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'broker_account_id,anchor_signal_id' })
        .select('id')
        .single();
    if (jobErr || !job?.id) {
        console.warn(`[basketSlTpReconcile] upsert job failed: ${jobErr?.message ?? 'no id'}`);
        return null;
    }
    const jobId = job.id;
    const expandedTargets = (0, tpBucketDistribution_1.expandPerLegTargetsToCount)({
        targets: storedTargets,
        openLegCount: args.familyTrades.length,
        finalTps: parsedTps.length
            ? parsedTps
            : storedTargets.map(t => t.takeprofit).filter(tp => tp > 0),
        tpLots: args.tpLots,
    });
    const legRows = args.familyTrades.map((tr, i) => {
        const target = expandedTargets[i];
        const ticket = Number(tr.metaapi_order_id);
        return {
            trade_id: tr.id,
            job_id: jobId,
            leg_index: i,
            ticket: Number.isFinite(ticket) && ticket > 0 ? ticket : null,
            desired_sl: target?.stoploss ?? null,
            desired_tp: target?.takeprofit ?? null,
        };
    });
    if (legRows.length > 0) {
        const { error: legErr } = await supabase.from('basket_reconcile_legs').upsert(legRows, {
            onConflict: 'trade_id',
        });
        if (legErr) {
            console.warn(`[basketSlTpReconcile] upsert legs failed: ${legErr.message}`);
        }
    }
    return jobId;
}
async function markBasketReconcileDone(supabase, jobId) {
    await supabase
        .from('basket_reconcile_jobs')
        .update({
        status: 'done',
        last_error: null,
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
    })
        .eq('id', jobId);
    await supabase.from('basket_reconcile_legs').delete().eq('job_id', jobId);
}
async function loadOpenBasketLegs(supabase, brokerAccountId, anchorSignalId, symbolHint) {
    const { data, error } = await supabase
        .from('trades')
        .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
        .eq('broker_account_id', brokerAccountId)
        .eq('signal_id', anchorSignalId)
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(500);
    if (error)
        return [];
    return (data ?? []).filter(tr => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symbolHint, tr.symbol));
}
function parsePerLegTargets(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map(row => {
        if (!row || typeof row !== 'object')
            return null;
        const o = row;
        return {
            stoploss: Number(o.stoploss) || 0,
            takeprofit: Number(o.takeprofit) || 0,
        };
    })
        .filter((x) => x != null);
}
