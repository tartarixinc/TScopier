"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldUseEntryFastPath = shouldUseEntryFastPath;
exports.shouldUseMgmtFastPath = shouldUseMgmtFastPath;
exports.isLiveMgmtFast = isLiveMgmtFast;
exports.revisionInflightWaitMs = revisionInflightWaitMs;
exports.enqueueSignal = enqueueSignal;
exports.scheduleQueueDrain = scheduleQueueDrain;
exports.dequeueQueuedSignal = dequeueQueuedSignal;
exports.drainSignalQueues = drainSignalQueues;
exports.logPipelineStage = logPipelineStage;
exports.logDispatchSkipped = logDispatchSkipped;
exports.logPipelineSummaryBackground = logPipelineSummaryBackground;
exports.markSignalExecuted = markSignalExecuted;
exports.signalLiveDispatchAlreadyHandled = signalLiveDispatchAlreadyHandled;
exports.signalAlreadyHandled = signalAlreadyHandled;
exports.signalTooOldForReplay = signalTooOldForReplay;
exports.claimSignalExecution = claimSignalExecution;
exports.waitForSignalInflightClear = waitForSignalInflightClear;
exports.handleSignal = handleSignal;
exports.getChannelMeta = getChannelMeta;
exports.brokerEligibleForSignal = brokerEligibleForSignal;
const fxsocketClient_1 = require("../fxsocketClient");
const tradeSignalActions_1 = require("../tradeSignalActions");
const workerConfig_1 = require("../workerConfig");
const brokerChannelFilter_1 = require("../brokerChannelFilter");
const copierPause_1 = require("../copierPause");
const channelTradingConfig_1 = require("../channelTradingConfig");
const channelMessageFilters_1 = require("../channelMessageFilters");
const multiTradeMerge_1 = require("../multiTradeMerge");
const manualPlanner_1 = require("../manualPlanner");
const pipelineTimestamps_1 = require("../pipelineTimestamps");
const tradeComment_1 = require("../tradeComment");
const helpers_1 = require("./helpers");
const types_1 = require("./types");
const signalRevision_1 = require("../signalRevision");
const messageRevisionDirectionFlipClose_1 = require("./messageRevisionDirectionFlipClose");
const subscriptionAccess_1 = require("../subscriptionAccess");
const signalExecutionEligibility_1 = require("../signalExecutionEligibility");
const copyLimitDispatch_1 = require("../copyLimitDispatch");
function shouldUseEntryFastPath(ctx, row) {
    const mode = workerConfig_1.workerConfig.tradeExecutorMode;
    if (mode !== 'entry' && mode !== 'all')
        return false;
    const parsed = row.parsed_data;
    if (!parsed)
        return false;
    // SL/TP follow-ups (replies / adjust posts) must modify the open basket — never OrderSend first.
    if ((0, multiTradeMerge_1.shouldRouteAsBasketParameterRefresh)(parsed))
        return false;
    return (0, tradeSignalActions_1.isEntryAction)((0, tradeSignalActions_1.parsedAction)(parsed));
}
function revisionDirectionFlip(row) {
    if (!row.revision_prior_action)
        return false;
    const action = (0, tradeSignalActions_1.parsedAction)(row.parsed_data);
    return (0, signalRevision_1.revisionDirectionFlippedFromActions)(row.revision_prior_action, action);
}
/** Live management bypasses in-process queue + heavy idempotency (mirror entry fast path). */
function shouldUseMgmtFastPath(row, source) {
    const mode = workerConfig_1.workerConfig.tradeExecutorMode;
    if (mode !== 'mgmt' && mode !== 'all')
        return false;
    const parsed = row.parsed_data;
    if (!parsed)
        return false;
    if (source === signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE && revisionDirectionFlip(row)) {
        return false;
    }
    const action = (0, tradeSignalActions_1.parsedAction)(parsed);
    if ((0, tradeSignalActions_1.isManagementAction)(action))
        return true;
    if (source === signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE
        && (0, multiTradeMerge_1.shouldRouteAsBasketParameterRefresh)(parsed)) {
        return true;
    }
    return false;
}
function isLiveMgmtFast(opts, parsed, row) {
    if (opts?.liveDispatch !== true || opts?.lightIdempotency !== true)
        return false;
    if (opts.dispatchSource === signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE
        && row?.revision_prior_action
        && (0, signalRevision_1.revisionDirectionFlippedFromActions)(row.revision_prior_action, (0, tradeSignalActions_1.parsedAction)(parsed))) {
        return false;
    }
    const action = (0, tradeSignalActions_1.parsedAction)(parsed);
    if ((0, tradeSignalActions_1.isManagementAction)(action))
        return true;
    if (opts.dispatchSource === signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE
        && parsed
        && (0, multiTradeMerge_1.shouldRouteAsBasketParameterRefresh)(parsed)) {
        return true;
    }
    return false;
}
function revisionInflightWaitMs(row, dispatchSource) {
    if (dispatchSource !== signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE)
        return 60000;
    const parsed = row.parsed_data;
    if (!parsed)
        return 60000;
    const action = (0, tradeSignalActions_1.parsedAction)(parsed);
    if ((0, tradeSignalActions_1.isManagementAction)(action))
        return 10000;
    if ((0, multiTradeMerge_1.shouldRouteAsBasketParameterRefresh)(parsed) && !(0, tradeSignalActions_1.isEntryAction)(action)) {
        return 10000;
    }
    if ((0, multiTradeMerge_1.shouldRouteAsBasketParameterRefresh)(parsed)) {
        return 10000;
    }
    return 60000;
}
function enqueueSignal(ctx, row, opts) {
    if (!types_1.PARSED_STATUSES.has(row.status))
        return;
    if (!(0, tradeSignalActions_1.signalMatchesExecutorMode)(row.parsed_data, workerConfig_1.workerConfig.tradeExecutorMode))
        return;
    if (ctx.inflight.has(row.id) || ctx.queuedIds.has(row.id))
        return;
    const action = (0, tradeSignalActions_1.parsedAction)(row.parsed_data);
    const high = (opts?.priority ?? (0, tradeSignalActions_1.dispatchPriorityForAction)(action)) === 'high';
    ctx.queuedIds.add(row.id);
    const item = {
        row,
        liveDispatch: opts?.liveDispatch,
        source: opts?.source,
        dispatchReceivedAt: opts?.dispatchReceivedAt,
    };
    if (high) {
        ctx.highPriorityQueue.push(item);
    }
    else {
        ctx.normalPriorityQueue.push(item);
    }
    ctx.scheduleQueueDrain();
}
function scheduleQueueDrain(ctx) {
    if (ctx.queueDrainScheduled)
        return;
    ctx.queueDrainScheduled = true;
    setImmediate(() => {
        ctx.queueDrainScheduled = false;
        void ctx.drainSignalQueues();
    });
}
function dequeueQueuedSignal(ctx) {
    return ctx.highPriorityQueue.shift() ?? ctx.normalPriorityQueue.shift() ?? null;
}
async function drainSignalQueues(ctx) {
    if (ctx.queueDraining)
        return;
    ctx.queueDraining = true;
    const inFlight = new Set();
    try {
        while (ctx.highPriorityQueue.length > 0 || ctx.normalPriorityQueue.length > 0 || inFlight.size > 0) {
            while (inFlight.size < types_1.EXECUTOR_MAX_CONCURRENT_SIGNALS
                && (ctx.highPriorityQueue.length > 0 || ctx.normalPriorityQueue.length > 0)) {
                const item = ctx.dequeueQueuedSignal();
                if (!item)
                    break;
                const row = item.row;
                ctx.queuedIds.delete(row.id);
                const job = ctx.handleSignal(row, {
                    liveDispatch: item.liveDispatch === true,
                    lightIdempotency: false,
                    dispatchSource: item.source,
                    dispatchReceivedAt: item.dispatchReceivedAt,
                })
                    .catch(err => console.error(`[tradeExecutor] handleSignal failed for ${row.id}:`, err));
                inFlight.add(job);
                void job.finally(() => {
                    inFlight.delete(job);
                });
            }
            if (inFlight.size > 0) {
                await Promise.race(inFlight);
            }
            else {
                break;
            }
        }
    }
    finally {
        ctx.queueDraining = false;
        if (ctx.highPriorityQueue.length > 0 || ctx.normalPriorityQueue.length > 0) {
            ctx.scheduleQueueDrain();
        }
    }
}
async function logPipelineStage(ctx, signal, action, payload) {
    try {
        await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            action,
            status: 'success',
            request_payload: payload,
        });
    }
    catch {
        /* best-effort */
    }
}
async function logDispatchSkipped(ctx, signal, skipReason, extra) {
    try {
        await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            action: 'dispatch_skipped',
            status: 'skipped',
            error_message: skipReason,
            request_payload: {
                skip_reason: skipReason,
                channel_id: signal.channel_id ?? null,
                ...extra,
            },
        });
        await ctx.supabase
            .from('signals')
            .update({ status: 'skipped', skip_reason: skipReason })
            .eq('id', signal.id)
            .in('status', ['parsed', 'pending']);
    }
    catch {
        /* best-effort */
    }
}
function logPipelineSummaryBackground(ctx, signal, extra) {
    const ts = signal.pipeline_ts ?? {};
    void ctx.supabase
        .from('trade_execution_logs')
        .insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        action: 'pipeline_summary',
        status: 'success',
        request_payload: (0, pipelineTimestamps_1.pipelineSummaryPayload)(ts, extra),
    })
        .then(({ error }) => {
        if (error) {
            console.warn(`[tradeExecutor] pipeline_summary log failed signal=${signal.id}: ${error.message}`);
        }
    });
}
async function markSignalExecuted(ctx, signalId) {
    try {
        await ctx.supabase
            .from('signals')
            .update({ status: 'executed' })
            .eq('id', signalId)
            .eq('status', 'parsed');
    }
    catch {
        /* best-effort */
    }
}
async function signalDispatchAlreadyHandled(ctx, signalId) {
    const [trades, range, entry, logs, claims] = await Promise.all([
        ctx.supabase
            .from('trades')
            .select('id', { count: 'exact', head: true })
            .eq('signal_id', signalId),
        ctx.supabase
            .from('range_pending_legs')
            .select('id', { count: 'exact', head: true })
            .eq('signal_id', signalId),
        ctx.supabase
            .from('signal_entry_pending_orders')
            .select('id', { count: 'exact', head: true })
            .eq('signal_id', signalId),
        ctx.supabase
            .from('trade_execution_logs')
            .select('id', { count: 'exact', head: true })
            .eq('signal_id', signalId)
            .eq('status', 'success')
            .in('action', [...types_1.EXECUTION_LOG_ACTIONS_HANDLED]),
        ctx.supabase
            .from('signal_broker_dispatch_claims')
            .select('id', { count: 'exact', head: true })
            .eq('signal_id', signalId),
    ]);
    return ((trades.count ?? 0) > 0
        || (range.count ?? 0) > 0
        || (entry.count ?? 0) > 0
        || (logs.count ?? 0) > 0
        || (claims.count ?? 0) > 0);
}
async function signalLiveDispatchAlreadyHandled(ctx, signalId) {
    return signalDispatchAlreadyHandled(ctx, signalId);
}
async function signalAlreadyHandled(ctx, signalId) {
    return signalDispatchAlreadyHandled(ctx, signalId);
}
function signalTooOldForReplay(ctx, row) {
    if (!row.created_at)
        return false;
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    return Number.isFinite(ageMs) && ageMs > types_1.EXECUTOR_REPLAY_MAX_AGE_MS;
}
function claimSignalExecution(ctx, signalId) {
    if (ctx.inflight.has(signalId))
        return false;
    ctx.inflight.add(signalId);
    return true;
}
/** Wait for an in-flight entry on the same signal row (teaser merge + revision overlap). */
async function waitForSignalInflightClear(ctx, signalId, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (ctx.inflight.has(signalId) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !ctx.inflight.has(signalId);
}
async function handleSignal(ctx, row, opts) {
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return;
    const isMessageRevisionEarly = opts?.dispatchSource === signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE;
    if (isMessageRevisionEarly) {
        await waitForSignalInflightClear(ctx, row.id, revisionInflightWaitMs(row, opts?.dispatchSource));
    }
    if (!ctx.claimSignalExecution(row.id))
        return;
    if (await (0, copierPause_1.loadCachedUserCopierPaused)(ctx.supabase, row.user_id)) {
        ctx.inflight.delete(row.id);
        ctx.queuedIds.delete(row.id);
        const action = (0, tradeSignalActions_1.parsedAction)(row.parsed_data);
        if ((0, tradeSignalActions_1.isManagementAction)(action)) {
            await ctx.logDispatchSkipped(row, 'copier_paused');
        }
        return;
    }
    if ((0, copierPause_1.signalPredatesCopierResume)(row.user_id, row.created_at)) {
        ctx.inflight.delete(row.id);
        ctx.queuedIds.delete(row.id);
        return;
    }
    const handleStartMs = Date.now();
    const liveFast = opts?.liveDispatch === true && opts?.lightIdempotency === true;
    const liveMgmtFast = isLiveMgmtFast(opts, row.parsed_data, row);
    const channelMetaPromise = (liveFast || liveMgmtFast) && row.channel_id
        ? ctx.getChannelMeta(row.channel_id)
        : null;
    const queueWaitMs = opts?.dispatchReceivedAt != null
        ? Math.max(0, handleStartMs - opts.dispatchReceivedAt)
        : null;
    let pipelineOutcome = {
        live_fast: liveFast,
        mgmt_fast_path: liveMgmtFast,
    };
    const isMessageRevision = opts?.dispatchSource === signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE;
    try {
        if (!opts?.liveDispatch && !isMessageRevision && ctx.signalTooOldForReplay(row))
            return;
        if (!liveFast && !liveMgmtFast) {
            void ctx.logPipelineStage(row, 'handle_start', {
                live_dispatch: opts?.liveDispatch === true,
                source: opts?.dispatchSource ?? null,
                queue_wait_ms: queueWaitMs,
            });
        }
        if (!isMessageRevision && !liveFast && !liveMgmtFast && await ctx.signalAlreadyHandled(row.id)) {
            await ctx.markSignalExecuted(row.id);
            return;
        }
        let userSub;
        let isAdmin;
        if (liveFast
            && (0, types_1.telegramLiveTradeGateEnabled)()
            && row.channel_id
            && ctx.sessionManager) {
            const [teleLive, sub, admin] = await Promise.all([
                ctx.sessionManager.canExecuteTelegramCopierTradesAsync(row.user_id),
                (0, subscriptionAccess_1.loadCachedUserSubscription)(ctx.supabase, row.user_id),
                (0, subscriptionAccess_1.loadCachedUserIsAdmin)(ctx.supabase, row.user_id),
            ]);
            if (!teleLive) {
                console.warn(`[tradeExecutor] skip signal ${row.id} (user ${row.user_id}): telegram listener not live for channel-backed copier`);
                await ctx.logDispatchSkipped(row, 'telegram_listener_not_live');
                return;
            }
            userSub = sub;
            isAdmin = admin;
        }
        else {
            if ((0, types_1.telegramLiveTradeGateEnabled)() && row.channel_id) {
                const live = ctx.sessionManager
                    ? await ctx.sessionManager.canExecuteTelegramCopierTradesAsync(row.user_id)
                    : false;
                if (!live) {
                    console.warn(`[tradeExecutor] skip signal ${row.id} (user ${row.user_id}): telegram listener not live for channel-backed copier`);
                    await ctx.logDispatchSkipped(row, 'telegram_listener_not_live');
                    return;
                }
            }
            ;
            [userSub, isAdmin] = await Promise.all([
                (0, subscriptionAccess_1.loadCachedUserSubscription)(ctx.supabase, row.user_id),
                (0, subscriptionAccess_1.loadCachedUserIsAdmin)(ctx.supabase, row.user_id),
            ]);
        }
        if (!isAdmin && (!userSub || !(0, subscriptionAccess_1.isSubscriptionActive)(userSub.status))) {
            await ctx.logDispatchSkipped(row, 'subscription_inactive');
            return;
        }
        if (isMessageRevision) {
            const fresh = await (0, signalRevision_1.loadSignalById)(ctx.supabase, row.id);
            if (!fresh?.parsed_data?.action)
                return;
            row.parsed_data = fresh.parsed_data;
        }
        const pipelineT0 = Date.now();
        const parsed = row.parsed_data;
        if (!parsed || !parsed.action)
            return;
        const action = String(parsed.action).toLowerCase();
        if (action === 'ignore')
            return;
        const executionEligibility = (0, signalExecutionEligibility_1.evaluateParsedSignalExecutionEligibility)(parsed, String(row.raw_message ?? parsed.raw_instruction ?? ''));
        if (!executionEligibility.eligible) {
            await ctx.logDispatchSkipped(row, executionEligibility.skipReason ?? 'entry_not_execution_eligible');
            return;
        }
        const rawMatchingBrokers = (ctx.brokersByUser.get(row.user_id) ?? []).filter(b => b.is_active && (0, helpers_1.brokerHasLinkedSession)(b) && (0, brokerChannelFilter_1.channelMatchesBrokerSignal)(b, row.channel_id));
        const configSkipReasons = [];
        const allMatchingBrokers = rawMatchingBrokers.flatMap(b => {
            const ready = (0, channelTradingConfig_1.channelConfigReadyForExecution)(b, row.channel_id);
            if (!ready.ready) {
                configSkipReasons.push(ready.reason);
                console.warn(`[tradeExecutor] skip broker ${b.id} signal=${row.id} channel=${row.channel_id ?? 'none'}`
                    + ` reason=${ready.reason}`);
                return [];
            }
            return [(0, channelTradingConfig_1.withChannelTradingConfig)(b, row.channel_id)];
        });
        let brokers = allMatchingBrokers.filter(b => ctx.brokerEligibleForSignal(b, row));
        if (brokers.length > 0 && row.channel_id) {
            const profileTz = ctx.userTimezoneById.get(row.user_id);
            const channelId = row.channel_id;
            if (liveFast && parsed.symbol) {
                void ctx.prewarmBrokersForLiveEntry(brokers, parsed.symbol);
            }
            const pauseResults = await Promise.all(brokers.map(async (broker) => {
                const state = await ctx.fetchCopyLimitState(broker.id, channelId);
                const pause = (0, copyLimitDispatch_1.evaluateChannelCopyLimitPauseForBroker)(broker, channelId, profileTz, state);
                if (pause.paused && pause.reason) {
                    const skipLog = ctx.logDispatchSkipped(row, pause.reason, {
                        broker_id: broker.id,
                        channel_id: channelId,
                        pause_key: pause.pauseKey ?? null,
                    });
                    if (liveFast)
                        void skipLog;
                    else
                        await skipLog;
                    return null;
                }
                return broker;
            }));
            brokers = pauseResults.filter((b) => b != null);
        }
        if (!brokers.length) {
            if (configSkipReasons.length > 0 && rawMatchingBrokers.length > 0) {
                await ctx.logDispatchSkipped(row, configSkipReasons[0] ?? 'channel_config_missing', {
                    channel_id: row.channel_id ?? null,
                    matching_brokers: rawMatchingBrokers.length,
                });
                return;
            }
            if (rawMatchingBrokers.length > 0) {
                // A matching broker exists but it was reactivated AFTER the signal
                // arrived — i.e. the signal piled up while the broker was disabled.
                // Marking as skipped here prevents the 5-min sweep from picking it
                // up the moment the user re-enables a broker.
                console.warn(`[tradeExecutor] skip signal ${row.id}: all matching brokers reactivated after signal arrival (stale-after-outage)`);
                await ctx.logDispatchSkipped(row, 'broker_reactivated_after_signal', {
                    matching_brokers: allMatchingBrokers.length,
                    broker_activated_at: allMatchingBrokers.map(b => ({
                        id: b.id,
                        activated_at: ctx.brokerActivatedAt.get(b.id) ?? null,
                    })),
                    signal_created_at: row.created_at ?? null,
                });
                return;
            }
            console.warn(`[tradeExecutor] skip signal ${row.id}: no active broker matches channel=${row.channel_id ?? 'none'} (check Configure Trading channel selection)`);
            await ctx.logDispatchSkipped(row, 'no_broker_channel_match');
            return;
        }
        for (const broker of brokers) {
            const blockReason = (0, subscriptionAccess_1.subscriptionBlocksSignalExecution)(userSub, (broker.manual_settings ?? null), isAdmin);
            if (blockReason === 'plan_advanced_feature_required') {
                await ctx.logDispatchSkipped(row, blockReason);
                return;
            }
        }
        if (isMessageRevision
            && row.revision_prior_action
            && (0, signalRevision_1.revisionDirectionFlippedFromActions)(row.revision_prior_action, action)) {
            const flipClose = await (0, messageRevisionDirectionFlipClose_1.closeBasketForRevisionDirectionFlip)(ctx, row, brokers);
            await (0, messageRevisionDirectionFlipClose_1.waitForSignalBasketFlat)(ctx, row, brokers);
            if (flipClose.closed === 0 && flipClose.failed > 0) {
                await ctx.logDispatchSkipped(row, 'message_revision_direction_flip_close_failed');
                return;
            }
            if (!(0, multiTradeMerge_1.parsedHasSlOrTp)(parsed)) {
                await ctx.logDispatchSkipped(row, 'message_revision_direction_flip_closed');
                await ctx.markSignalExecuted(row.id);
                return;
            }
        }
        // Pre-fetch channel keywords + comment slug once per signal.
        const { keywords: channelKeywords, commentSlug } = channelMetaPromise
            ? await channelMetaPromise
            : await ctx.getChannelMeta(row.channel_id);
        const rawText = String(parsed.raw_instruction ?? '').toLowerCase();
        const ignoreKw = channelKeywords?.additional?.ignore_keyword?.trim().toLowerCase();
        const skipKw = channelKeywords?.additional?.skip_keyword?.trim().toLowerCase();
        if ((ignoreKw && rawText.includes(ignoreKw)) || (skipKw && rawText.includes(skipKw))) {
            // Channel-level ignore — parse-signal usually already short-circuits this,
            // but we double-check here so a stale parse can't slip through.
            return;
        }
        if ((0, tradeSignalActions_1.isManagementAction)(action)) {
            const mgmtCtx = (0, channelMessageFilters_1.managementFilterContextFromParsed)(parsed);
            const mgmtBrokers = brokers.filter(b => !(0, channelMessageFilters_1.isChannelManagementBlocked)((0, channelMessageFilters_1.normalizeChannelMessageFiltersMap)(b.channel_message_filters), row.channel_id, action, mgmtCtx));
            if (!mgmtBrokers.length) {
                await ctx.logDispatchSkipped(row, 'channel_filter_ignored');
                return;
            }
            const mgmtWallStart = Date.now();
            const mgmtResult = await ctx.applyManagement(row, parsed, mgmtBrokers, { liveMgmtFast });
            pipelineOutcome = {
                ...pipelineOutcome,
                mgmt_wall_ms: Date.now() - mgmtWallStart,
                mgmt_legs_total: mgmtResult.legsTotal,
                mgmt_legs_parallelism: mgmtResult.legsParallelism,
                mgmt_action: action,
            };
            return;
        }
        const op = (0, helpers_1.operationFor)(action, parsed);
        if (!op || !parsed.symbol)
            return;
        if (!liveFast) {
            for (const b of brokers) {
                const resolved = (0, channelTradingConfig_1.resolveChannelTradingConfig)(b, row.channel_id);
                const ms = resolved.manual_settings;
                console.log(`[tradeExecutor] channel config signal=${row.id} channel=${row.channel_id ?? 'none'}`
                    + ` broker=${b.id} source=${resolved.config_source}`
                    + ` style=${String(ms.trade_style ?? 'single')}`
                    + ` fixed_lot=${String(ms.fixed_lot ?? 'missing')}`);
            }
        }
        if (liveFast && row.pipeline_ts) {
            row.pipeline_ts.t_order_send_start = Date.now();
        }
        const outcomes = await Promise.all(brokers.map(b => ctx.sendOrder(row, parsed, op, b, channelKeywords, pipelineT0, {
            liveEntryFast: liveFast,
            liveMgmtFast,
            commentSlug,
            sameSignalRefresh: isMessageRevision,
        })));
        if (liveFast && row.pipeline_ts) {
            row.pipeline_ts.t_order_send_done = Date.now();
        }
        const anyOpened = outcomes.some(o => o.openedOrMerged === true);
        const pipelineMs = Date.now() - pipelineT0;
        const channelDelayMs = Math.max(...outcomes.map(o => o.channelDelayMs ?? 0));
        const channelDelaySkipped = outcomes.some(o => o.channelDelaySkipped === true);
        pipelineOutcome = {
            ...pipelineOutcome,
            any_opened: anyOpened,
            pipeline_ms: pipelineMs,
            brokers: brokers.length,
            dispatch_source: opts?.dispatchSource ?? null,
            channel_delay_ms: channelDelayMs > 0 ? channelDelayMs : null,
            channel_delay_skipped: channelDelaySkipped || null,
            has_listener_timestamps: !!(row.pipeline_ts?.t_listener_received && row.pipeline_ts?.t_dispatch_sent),
        };
        if (pipelineMs > 4000) {
            console.warn(`[tradeExecutor] slow pipeline signal=${row.id} user=${row.user_id} ms=${pipelineMs} brokers=${brokers.length}`);
        }
        const strictSkips = outcomes.filter(o => o.signalEntryRequiredSkip === true).length;
        const finalizeSkipReasons = outcomes
            .map(o => o.finalizeSkipReason)
            .filter((r) => typeof r === 'string' && r.length > 0);
        if (!anyOpened && strictSkips === brokers.length && strictSkips > 0) {
            try {
                const { error: sigErr } = await ctx.supabase
                    .from('signals')
                    .update({ status: 'skipped', skip_reason: manualPlanner_1.SKIP_REASON_SIGNAL_ENTRY_REQUIRED })
                    .eq('id', row.id)
                    .eq('status', 'parsed');
                if (sigErr) {
                    console.warn(`[tradeExecutor] signal skip finalize failed id=${row.id}: ${sigErr.message}`);
                }
            }
            catch {
                // best-effort
            }
        }
        else if (!anyOpened && finalizeSkipReasons.length === brokers.length && finalizeSkipReasons.length > 0) {
            const skipReason = finalizeSkipReasons[0];
            try {
                const { error: sigErr } = await ctx.supabase
                    .from('signals')
                    .update({ status: 'skipped', skip_reason: skipReason })
                    .eq('id', row.id)
                    .eq('status', 'parsed');
                if (sigErr) {
                    console.warn(`[tradeExecutor] signal skip finalize failed id=${row.id}: ${sigErr.message}`);
                }
            }
            catch {
                // best-effort
            }
        }
        else if (anyOpened) {
            await ctx.markSignalExecuted(row.id);
        }
        else if (isMessageRevision) {
            const revisionApplied = outcomes.some(o => o.openedOrMerged === true);
            if (revisionApplied) {
                await ctx.markSignalExecuted(row.id);
            }
            else {
                try {
                    const { error: sigErr } = await ctx.supabase
                        .from('signals')
                        .update({ status: 'parsed', skip_reason: 'basket_modify_failed' })
                        .eq('id', row.id);
                    if (sigErr) {
                        console.warn(`[tradeExecutor] revision modify failed finalize id=${row.id}: ${sigErr.message}`);
                    }
                }
                catch {
                    // best-effort
                }
            }
        }
    }
    finally {
        const handleMs = Date.now() - handleStartMs;
        if (liveFast || liveMgmtFast) {
            ctx.logPipelineSummaryBackground(row, { handle_ms: handleMs, ...pipelineOutcome });
        }
        else {
            void ctx.logPipelineStage(row, 'handle_end', {
                handle_ms: handleMs,
                source: opts?.dispatchSource ?? null,
                ...pipelineOutcome,
            });
        }
        ctx.inflight.delete(row.id);
        ctx.queuedIds.delete(row.id);
    }
}
async function getChannelMeta(ctx, channelId) {
    if (!channelId)
        return { keywords: null, commentSlug: null };
    const cached = ctx.channelMetaCache.get(channelId);
    if (cached && Date.now() - cached.loadedAt < 5 * 60000) {
        return { keywords: cached.keywords, commentSlug: cached.commentSlug };
    }
    try {
        const { data } = await ctx.supabase
            .from('telegram_channels')
            .select('channel_keywords, display_name, channel_username')
            .eq('id', channelId)
            .maybeSingle();
        const row = data;
        const keywords = row?.channel_keywords ?? null;
        const label = (0, tradeComment_1.resolveChannelLabelForComment)(row?.display_name, row?.channel_username);
        const commentSlug = label ? (0, tradeComment_1.sanitizeChannelCommentSlug)(label) : null;
        ctx.channelMetaCache.set(channelId, { keywords, commentSlug, loadedAt: Date.now() });
        return { keywords, commentSlug };
    }
    catch {
        ctx.channelMetaCache.set(channelId, { keywords: null, commentSlug: null, loadedAt: Date.now() });
        return { keywords: null, commentSlug: null };
    }
}
function brokerEligibleForSignal(ctx, broker, signal) {
    if (!broker.is_active)
        return false;
    const activatedAt = ctx.brokerActivatedAt.get(broker.id);
    if (activatedAt == null)
        return true;
    const createdAtRaw = signal.created_at;
    if (createdAtRaw == null)
        return true;
    const createdMs = typeof createdAtRaw === 'number'
        ? createdAtRaw
        : Date.parse(String(createdAtRaw));
    if (!Number.isFinite(createdMs))
        return true;
    return createdMs >= activatedAt;
}
