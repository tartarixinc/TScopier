"use strict";
/**
 * Backtest Telegram history sync on a dedicated short-lived MTProto connection.
 * Never shares the live UserListener client (avoids AUTH_KEY_DUPLICATED).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithEphemeralListener = runWithEphemeralListener;
exports.runEphemeralBacktestSync = runEphemeralBacktestSync;
const telegramClient_1 = require("./telegramClient");
const userListener_1 = require("./userListener");
async function loadSessionString(supabase, userId) {
    const { data: sess, error } = await supabase
        .from('telegram_sessions')
        .select('session_string')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();
    if (error)
        throw new Error(error.message);
    if (!sess?.session_string)
        throw new Error('No active Telegram session');
    return sess.session_string;
}
/** Short-lived MTProto client; never uses the live UserListener connection. */
async function runWithEphemeralListener(supabase, userId, fn) {
    const sessionString = await loadSessionString(supabase, userId);
    const client = (0, telegramClient_1.buildClient)(sessionString);
    try {
        await client.connect();
        const listener = new userListener_1.UserListener(userId, sessionString, supabase, client);
        return await fn(listener);
    }
    finally {
        try {
            await client.disconnect();
        }
        catch {
            /* ignore */
        }
    }
}
async function runEphemeralBacktestSync(supabase, userId, channelRowId, fromIso, toIso, runId) {
    return runWithEphemeralListener(supabase, userId, listener => listener.syncBacktestSignals(channelRowId, fromIso, toIso, { runId }));
}
