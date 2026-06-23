"use strict";
/**
 * Replay parsed signals after Telegram listener lease recovers from expiry.
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
exports.listenerLeaseRecoveryTick = listenerLeaseRecoveryTick;
exports.replaySignalsAfterListenerRecovery = replaySignalsAfterListenerRecovery;
const copierPause_1 = require("./copierPause");
const signalRangeEntryHelpers_1 = require("./signalRangeEntryHelpers");
const dispatch_1 = require("./tradeExecutor/dispatch");
const types_1 = require("./tradeExecutor/types");
const tradeSignalActions_1 = require("./tradeSignalActions");
const REPLAY_BATCH_LIMIT = 40;
const listenerLeaseLiveByUser = new Map();
/**
 * On trade workers (split deploy), detect lease false→true and replay missed signals.
 */
async function listenerLeaseRecoveryTick(ctx) {
    for (const userId of ctx.brokersByUser.keys()) {
        const { isTelegramListenerLiveForUser } = await Promise.resolve().then(() => __importStar(require('./sessionLease')));
        const live = await isTelegramListenerLiveForUser(ctx.supabase, userId);
        const hadPrior = listenerLeaseLiveByUser.has(userId);
        const wasLive = listenerLeaseLiveByUser.get(userId) ?? false;
        listenerLeaseLiveByUser.set(userId, live);
        if (hadPrior && live && !wasLive) {
            void replaySignalsAfterListenerRecovery(ctx, userId);
        }
    }
}
/**
 * Enqueue recent parsed signals (and reset transient listener skips) after lease recovery.
 */
async function replaySignalsAfterListenerRecovery(ctx, userId) {
    if (await (0, copierPause_1.loadCachedUserCopierPaused)(ctx.supabase, userId))
        return 0;
    const since = new Date(Date.now() - types_1.EXECUTOR_REPLAY_MAX_AGE_MS).toISOString();
    try {
        await ctx.supabase
            .from('signals')
            .update({ status: 'parsed', skip_reason: null })
            .eq('user_id', userId)
            .eq('status', 'skipped')
            .eq('skip_reason', 'telegram_listener_not_live')
            .gte('created_at', since);
    }
    catch (err) {
        console.warn(`[listenerSignalReplay] reset transient skips failed user=${userId}:`, err instanceof Error ? err.message : err);
    }
    const { data, error } = await ctx.supabase
        .from('signals')
        .select('id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id')
        .eq('user_id', userId)
        .eq('status', 'parsed')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(REPLAY_BATCH_LIMIT);
    if (error) {
        console.warn(`[listenerSignalReplay] load parsed signals failed user=${userId}: ${error.message}`);
        return 0;
    }
    let enqueued = 0;
    for (const row of (data ?? [])) {
        if (ctx.inflight.has(row.id) || ctx.queuedIds.has(row.id))
            continue;
        if (await (0, signalRangeEntryHelpers_1.hasActiveSignalRangeEntryWait)(ctx.supabase, row.id))
            continue;
        if (await ctx.signalAlreadyHandled(row.id)) {
            await ctx.markSignalExecuted(row.id);
            continue;
        }
        (0, dispatch_1.enqueueSignal)(ctx, row, {
            source: 'listener_lease_recovery_replay',
            priority: (0, tradeSignalActions_1.dispatchPriorityForAction)((0, tradeSignalActions_1.parsedAction)(row.parsed_data)),
        });
        enqueued += 1;
    }
    if (enqueued > 0) {
        console.log(`[listenerSignalReplay] user=${userId} re-queued ${enqueued} parsed signal(s) after listener lease recovery`);
    }
    return enqueued;
}
