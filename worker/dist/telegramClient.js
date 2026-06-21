"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramSessionInvalidError = exports.TELEGRAM_SESSION_INVALID_CODE = exports.API_HASH = exports.API_ID = void 0;
exports.buildClient = buildClient;
exports.isAuthKeyUnregistered = isAuthKeyUnregistered;
exports.isAuthKeyDuplicated = isAuthKeyDuplicated;
exports.rethrowIfSessionInvalid = rethrowIfSessionInvalid;
exports.tgInvoke = tgInvoke;
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
exports.API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '0');
exports.API_HASH = process.env.TELEGRAM_API_HASH ?? '';
/**
 * Construct a TelegramClient with a fingerprint that matches what an official
 * Telegram desktop client sends. Avoids the generic GramJS defaults that
 * Telegram's anti-spam system flags on cold accounts from datacenter IPs.
 *
 * Reuse a single instance for the whole lifetime of an authenticated session
 * (auth + listener) — repeated connect/disconnect from datacenter IPs is one
 * of the strongest ban signals.
 */
function buildClient(sessionString = '') {
    if (!exports.API_ID || !exports.API_HASH) {
        throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH must be set in env');
    }
    return new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), exports.API_ID, exports.API_HASH, {
        connectionRetries: 5,
        retryDelay: 4000,
        // Manual recovery lives in UserListener.runWatchdog / forceReconnect.
        // Leaving autoReconnect on races with explicit disconnect+connect and is a
        // common trigger for Telegram AUTH_KEY_DUPLICATED after worker restarts.
        autoReconnect: false,
        useWSS: true,
        deviceModel: 'Desktop',
        systemVersion: 'Windows 10',
        appVersion: '5.6.3',
        langCode: 'en',
        systemLangCode: 'en',
        // Auto-sleep on FLOOD_WAIT under this many seconds instead of throwing.
        floodSleepThreshold: 60,
    });
}
/**
 * Wrap a raw `client.invoke(...)` call so that long FLOOD_WAIT_N errors
 * (above floodSleepThreshold) are handled with a transparent backoff
 * instead of bubbling up. Use for auth flows where we cannot afford a
 * hard error mid-handshake.
 */
exports.TELEGRAM_SESSION_INVALID_CODE = 'TELEGRAM_SESSION_INVALID';
class TelegramSessionInvalidError extends Error {
    constructor(message = 'Telegram session is no longer valid') {
        super(message);
        this.code = exports.TELEGRAM_SESSION_INVALID_CODE;
        this.name = 'TelegramSessionInvalidError';
    }
}
exports.TelegramSessionInvalidError = TelegramSessionInvalidError;
function isAuthKeyUnregistered(err) {
    const m = err instanceof Error ? err.message : String(err);
    return m.includes('AUTH_KEY_UNREGISTERED');
}
/** Telegram returns this when the same auth key is online twice (deploy overlap, double connect). */
function isAuthKeyDuplicated(err) {
    const m = err instanceof Error ? err.message : String(err);
    return m.includes('AUTH_KEY_DUPLICATED');
}
function rethrowIfSessionInvalid(err) {
    if (isAuthKeyUnregistered(err)) {
        throw new TelegramSessionInvalidError();
    }
    throw err;
}
async function tgInvoke(client, req) {
    try {
        return (await client.invoke(req));
    }
    catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        const flood = m.match(/FLOOD_WAIT_(\d+)/);
        if (flood) {
            const waitSec = parseInt(flood[1], 10) + 2;
            console.warn(`[telegram] FLOOD_WAIT_${flood[1]} — sleeping ${waitSec}s before retry`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            return tgInvoke(client, req);
        }
        throw e;
    }
}
