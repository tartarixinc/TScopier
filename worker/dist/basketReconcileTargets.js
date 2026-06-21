"use strict";
/**
 * Fresh SL/TP target resolution for basket reconcile jobs and drift sweeps.
 * Rebuilds per-leg targets from channel memory + entry-quality distribution
 * instead of trusting stale job JSON (e.g. all legs stuck on TP1).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveFreshBasketReconcileTargets = resolveFreshBasketReconcileTargets;
exports.basketLegsOutOfSync = basketLegsOutOfSync;
exports.sweepOpenBasketsForReconcileDrift = sweepOpenBasketsForReconcileDrift;
exports.resolveFreshTargetsForJob = resolveFreshTargetsForJob;
const basketEffectiveStops_1 = require("./basketEffectiveStops");
const tpBucketDistribution_1 = require("./manualPlanning/tpBucketDistribution");
const orderModifyBenign_1 = require("./orderModifyBenign");
const basketSlTpReconcile_1 = require("./basketSlTpReconcile");
const rangeBasketTpSync_1 = require("./rangeBasketTpSync");
const channelTradingConfig_1 = require("./channelTradingConfig");
const normalizeManualSettings_1 = require("./manualPlanning/normalizeManualSettings");
const copierPause_1 = require("./copierPause");
async function resolveFreshBasketReconcileTargets(supabase, args) {
    const stored = args.storedTargets;
    const { data: anchorSig } = await supabase
        .from('signals')
        .select('parsed_data, created_at, channel_id')
        .eq('id', args.anchorSignalId)
        .maybeSingle();
    const anchorCreatedAt = anchorSig?.created_at
        ?? args.familyTrades[0]?.opened_at
        ?? null;
    const channelId = args.channelId
        ?? anchorSig?.channel_id
        ?? null;
    const anchorParsed = (0, rangeBasketTpSync_1.toRangeBasketParsedSlice)(anchorSig?.parsed_data);
    const effective = await (0, basketEffectiveStops_1.resolveEffectiveBasketStops)({
        supabase,
        userId: args.userId,
        channelId,
        anchorSignalId: args.anchorSignalId,
        symbol: args.symbol,
        basketCreatedAt: anchorCreatedAt,
        anchorParsed,
        familyTrades: args.familyTrades,
    });
    (0, basketEffectiveStops_1.logEffectiveBasketStops)('[basketReconcileTargets]', args.anchorSignalId, effective);
    const parsed = { ...effective.parsedSlice };
    const channelTpLevels = effective.tpLevels.length ? effective.tpLevels : null;
    const signalTps = (0, rangeBasketTpSync_1.resolveRangeBasketFinalTps)({
        parsed,
        familyTrades: args.familyTrades,
        channelTpLevels,
        direction: args.direction,
    });
    let perLegTargets;
    let tpFrozen = false;
    if (args.manual.range_trading === true && args.familyTrades.length > 0) {
        const { activePendingCount, maxPendingStepIdx } = await (0, rangeBasketTpSync_1.loadRangePendingMeta)(supabase, args.brokerAccountId, args.anchorSignalId);
        const planImmediateLegCount = Math.max(1, args.familyTrades.length - maxPendingStepIdx);
        const { phase } = (0, rangeBasketTpSync_1.resolveRangeBasketLegCounts)({
            openLegCount: args.familyTrades.length,
            planImmediateLegCount,
            activePendingCount,
            maxPendingStepIdx,
        });
        const hasClosedLegs = await (0, rangeBasketTpSync_1.hasClosedBasketLegs)(supabase, args.brokerAccountId, args.anchorSignalId);
        const tpGate = (0, rangeBasketTpSync_1.resolveRangeTpRebalanceGate)({
            activePendingCount,
            maxPendingStepIdx,
            phase,
            hasClosedBasketLegs: hasClosedLegs,
        });
        const built = (0, rangeBasketTpSync_1.buildRangeBasketTpTargets)({
            familyTrades: args.familyTrades,
            plan: null,
            parsed,
            tpLots: args.manual.tp_lots,
            direction: args.direction,
            activePendingCount,
            maxPendingStepIdx,
            channelTpLevels,
            finalTpsOverride: signalTps.length ? signalTps : null,
            stoplossOverride: effective.stoploss > 0 ? effective.stoploss : null,
        });
        let mapped = built.map(t => ({
            stoploss: Number(t.stoploss) || 0,
            takeprofit: Number(t.takeprofit) || 0,
        }));
        if (!tpGate.allowOpenLegTpModify) {
            mapped = (0, rangeBasketTpSync_1.preserveOpenLegTakeProfits)(args.familyTrades, mapped).map(t => ({
                stoploss: Number(t.stoploss) || 0,
                takeprofit: Number(t.takeprofit) || 0,
            }));
        }
        perLegTargets = mapped;
        tpFrozen = !tpGate.allowOpenLegTpModify;
    }
    else {
        const slNum = typeof parsed.sl === 'number' && parsed.sl > 0 ? parsed.sl : 0;
        const sl = slNum > 0 ? slNum : (stored[0]?.stoploss ?? 0);
        const seed = stored.length
            ? stored.map(t => ({ ...t, stoploss: sl || t.stoploss }))
            : [{ stoploss: sl, takeprofit: 0 }];
        perLegTargets = (0, tpBucketDistribution_1.expandPerLegTargetsToCount)({
            targets: seed,
            openLegCount: args.familyTrades.length,
            finalTps: signalTps,
            tpLots: args.manual.tp_lots,
        }).map(t => ({
            stoploss: Number(t.stoploss) || 0,
            takeprofit: Number(t.takeprofit) || 0,
        }));
    }
    if (args.overrideTp != null && args.overrideTp > 0) {
        for (let i = 0; i < perLegTargets.length; i++) {
            perLegTargets[i] = { ...perLegTargets[i], takeprofit: args.overrideTp };
        }
    }
    for (let i = 0; i < Math.min(args.nImmCwe, perLegTargets.length); i++) {
        perLegTargets[i] = { ...perLegTargets[i], takeprofit: 0 };
    }
    return {
        perLegTargets,
        signalTps,
        effectiveStoploss: effective.stoploss,
        effectiveSlSource: effective.source,
        tpFrozen: tpFrozen || undefined,
    };
}
/** True when any open leg's DB SL/TP differs from freshly resolved targets. */
function basketLegsOutOfSync(familyTrades, perLegTargets, nImmCwe, opts) {
    if (!familyTrades.length || !perLegTargets.length)
        return false;
    const expanded = (0, tpBucketDistribution_1.expandPerLegTargetsToCount)({
        targets: perLegTargets,
        openLegCount: familyTrades.length,
        finalTps: perLegTargets.map(t => t.takeprofit).filter(tp => tp > 0),
        tpLots: null,
    });
    const effectiveSl = opts?.effectiveStoploss != null && opts.effectiveStoploss > 0
        ? opts.effectiveStoploss
        : null;
    const tpFrozen = opts?.tpFrozen === true;
    for (let i = 0; i < familyTrades.length; i++) {
        const target = expanded[i];
        if (!target)
            return true;
        let compareTarget = target;
        if (effectiveSl != null) {
            const legSl = Number(familyTrades[i].sl);
            if (Number.isFinite(legSl)
                && Math.abs(legSl - effectiveSl) < 1e-8
                && Math.abs(target.stoploss - effectiveSl) > 1e-8) {
                compareTarget = { ...target, stoploss: effectiveSl };
            }
        }
        if (tpFrozen) {
            const legSl = Number(familyTrades[i].sl);
            const targetSl = compareTarget.stoploss;
            if (targetSl > 0) {
                if (!Number.isFinite(legSl) || Math.abs(legSl - targetSl) > 1e-8)
                    return true;
            }
            else if (Number.isFinite(legSl) && legSl > 0) {
                return true;
            }
            continue;
        }
        if (!(0, orderModifyBenign_1.stopsAlreadyMatchDb)(familyTrades[i], compareTarget, nImmCwe, i))
            return true;
    }
    return false;
}
const SWEEP_BATCH = Math.min(50, Math.max(5, Number(process.env.BASKET_RECONCILE_SWEEP_BATCH ?? 20)));
/**
 * Scan open baskets and enqueue reconcile jobs when legs drift from channel SL/TP ladder.
 * Runs periodically from BasketSlTpReconcileMonitor (not only when jobs already exist).
 */
async function sweepOpenBasketsForReconcileDrift(supabase) {
    const { data: tradeRows, error } = await supabase
        .from('trades')
        .select('broker_account_id,signal_id,symbol,direction,telegram_channel_id')
        .eq('status', 'open')
        .not('broker_account_id', 'is', null)
        .limit(500);
    if (error || !tradeRows?.length)
        return 0;
    const basketKeys = new Map();
    for (const raw of tradeRows) {
        const row = raw;
        const key = `${row.broker_account_id}|${row.signal_id}`;
        if (!basketKeys.has(key))
            basketKeys.set(key, row);
    }
    const brokerIds = [...new Set([...basketKeys.values()].map(r => r.broker_account_id))];
    const { data: brokers } = await supabase
        .from('broker_accounts')
        .select('id,user_id,manual_settings,channel_trading_configs,copier_mode,ai_settings')
        .in('id', brokerIds);
    const brokerById = new Map((brokers ?? []).map(b => [b.id, b]));
    let enqueued = 0;
    let scanned = 0;
    for (const row of basketKeys.values()) {
        if (scanned >= SWEEP_BATCH)
            break;
        scanned += 1;
        const broker = brokerById.get(row.broker_account_id);
        if (!broker?.user_id)
            continue;
        if ((0, copierPause_1.isUserCopierPausedCached)(String(broker.user_id)))
            continue;
        const manual = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)((0, channelTradingConfig_1.resolveChannelTradingConfig)(broker, row.telegram_channel_id).manual_settings);
        const familyTrades = await (0, basketSlTpReconcile_1.loadOpenBasketLegs)(supabase, row.broker_account_id, row.signal_id, row.symbol);
        if (familyTrades.length === 0)
            continue;
        const direction = (row.direction === 'sell' ? 'sell' : 'buy');
        const { data: existingJob } = await supabase
            .from('basket_reconcile_jobs')
            .select('id,status,next_run_at')
            .eq('broker_account_id', row.broker_account_id)
            .eq('anchor_signal_id', row.signal_id)
            .maybeSingle();
        const jobStatus = existingJob?.status;
        if (jobStatus === 'pending' || jobStatus === 'claimed')
            continue;
        const { perLegTargets, signalTps, effectiveStoploss, tpFrozen } = await resolveFreshBasketReconcileTargets(supabase, {
            anchorSignalId: row.signal_id,
            channelId: row.telegram_channel_id,
            symbol: row.symbol,
            direction,
            userId: broker.user_id,
            brokerAccountId: row.broker_account_id,
            familyTrades,
            storedTargets: [],
            manual,
            nImmCwe: 0,
            overrideTp: null,
        });
        if (!perLegTargets.length)
            continue;
        if (!basketLegsOutOfSync(familyTrades, perLegTargets, 0, { effectiveStoploss, tpFrozen }))
            continue;
        const jobId = await (0, basketSlTpReconcile_1.upsertBasketReconcileJob)(supabase, {
            userId: broker.user_id,
            brokerAccountId: row.broker_account_id,
            anchorSignalId: row.signal_id,
            sourceSignalId: row.signal_id,
            channelId: row.telegram_channel_id,
            symbol: row.symbol,
            direction,
            perLegTargets,
            familyTrades,
            signalTps,
            tpLots: manual.tp_lots,
            virtualPendingsSnapshot: null,
            nImmCwe: 0,
            overrideTp: null,
            lastError: 'Drift sweep: open legs out of sync with channel SL/TP ladder',
        });
        if (jobId) {
            enqueued += 1;
            console.log(`[basketReconcileTargets] drift sweep enqueued job=${jobId}`
                + ` broker=${row.broker_account_id} anchor=${row.signal_id} legs=${familyTrades.length}`);
        }
    }
    if (enqueued > 0) {
        console.log(`[basketReconcileTargets] drift sweep enqueued ${enqueued} reconcile job(s)`);
    }
    return enqueued;
}
async function resolveFreshTargetsForJob(supabase, job, familyTrades, manual) {
    return resolveFreshBasketReconcileTargets(supabase, {
        anchorSignalId: job.anchor_signal_id,
        channelId: job.channel_id,
        symbol: job.symbol,
        direction: job.direction,
        userId: job.user_id,
        brokerAccountId: job.broker_account_id,
        familyTrades,
        storedTargets: (0, basketSlTpReconcile_1.parsePerLegTargets)(job.per_leg_targets),
        manual,
        nImmCwe: job.n_imm_cwe ?? 0,
        overrideTp: job.override_tp,
    });
}
