"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHttpServer = startHttpServer;
exports.startTradeHttpServer = startTradeHttpServer;
const http_1 = require("http");
const telegramClient_1 = require("./telegramClient");
const workerConfig_1 = require("./workerConfig");
const queueHealth_1 = require("./queue/queueHealth");
const parseSignal_1 = require("./parseSignal");
const aiParseModification_1 = require("./aiParseModification");
const INTERNAL_TOKEN = process.env.WORKER_INTERNAL_TOKEN ?? '';
const PORT = parseInt(process.env.WORKER_PORT ?? '8080', 10);
function isTelegramSessionInvalid(err) {
    return err instanceof telegramClient_1.TelegramSessionInvalidError;
}
async function handleTelegramRpcError(res, userId, sessionManager, err, fallbackMessage) {
    if (userId && isTelegramSessionInvalid(err)) {
        await sessionManager.invalidateTelegramSession(userId);
        return sendSessionInvalid(res);
    }
    const msg = err instanceof Error ? err.message : fallbackMessage;
    return sendJson(res, 400, { error: sanitizeClientError(msg) });
}
function sendSessionInvalid(res) {
    sendJson(res, 401, {
        error: 'telegram_session_invalid',
        code: telegramClient_1.TELEGRAM_SESSION_INVALID_CODE,
        message: 'Your Telegram session expired. Please connect again.',
    });
}
/** Strip gramjs "(caused by …)" tails from messages shown to users. */
function sanitizeClientError(msg) {
    const idx = msg.indexOf('(caused by');
    return (idx > 0 ? msg.slice(0, idx) : msg).trim() || 'Request failed';
}
/**
 * Authenticated HTTP API consumed only by the supabase telegram-auth
 * edge function. Authenticates with a static internal token so requests
 * cannot originate from the public internet without the secret.
 */
function startHttpServer(authService, sessionManager) {
    if (!INTERNAL_TOKEN) {
        throw new Error('WORKER_INTERNAL_TOKEN must be set in env');
    }
    const server = (0, http_1.createServer)(async (req, res) => {
        try {
            const url = (req.url ?? '').split('?')[0] ?? '';
            if (url === '/health' && (req.method === 'GET' || req.method === 'POST')) {
                const payload = await sessionManager.getHealthPayload();
                return sendJson(res, payload.ok ? 200 : 503, payload);
            }
            if (req.method !== 'POST') {
                return sendJson(res, 404, { error: 'Not found' });
            }
            const token = req.headers['x-internal-token'];
            if (token !== INTERNAL_TOKEN) {
                return sendJson(res, 401, { error: 'Unauthorized' });
            }
            const body = (await readJson(req));
            if (url === '/auth/send_code') {
                if (!body.user_id || !body.phone) {
                    return sendJson(res, 400, { error: 'user_id and phone are required' });
                }
                const r = await authService.sendCode(body.user_id, body.phone);
                return sendJson(res, 200, r);
            }
            if (url === '/auth/verify_code') {
                if (!body.user_id || !body.phone || !body.code) {
                    return sendJson(res, 400, { error: 'user_id, phone, and code are required' });
                }
                try {
                    const r = await authService.verifyCode(body.user_id, body.phone, body.code, body.password);
                    if ('requires_password' in r) {
                        return sendJson(res, 200, {
                            requires_password: true,
                        });
                    }
                    return sendJson(res, 200, r);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : 'Verification failed';
                    return sendJson(res, 400, { error: sanitizeClientError(msg) });
                }
            }
            if (url === '/auth/list_channels') {
                if (!body.user_id) {
                    return sendJson(res, 400, { error: 'user_id is required' });
                }
                try {
                    const channels = await sessionManager.listChannels(body.user_id);
                    return sendJson(res, 200, { channels });
                }
                catch (err) {
                    return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to list channels');
                }
            }
            if (url === '/auth/backfill_channel_history') {
                if (!body.user_id || !body.channel_row_id) {
                    return sendJson(res, 400, { error: 'user_id and channel_row_id are required' });
                }
                try {
                    const forTraining = body.for_training === true || body.for_training === 'true';
                    const result = await sessionManager.backfillChannelHistory(body.user_id, body.channel_row_id, Number(body.days ?? 30), { forTraining });
                    return sendJson(res, 200, result);
                }
                catch (err) {
                    return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to backfill channel history');
                }
            }
            if (url === '/auth/import_backtest_history') {
                if (!body.user_id || !body.channel_row_id || !body.from || !body.to) {
                    return sendJson(res, 400, { error: 'user_id, channel_row_id, from, and to are required' });
                }
                try {
                    const result = await sessionManager.importBacktestChannelHistory(body.user_id, body.channel_row_id, body.from, body.to);
                    return sendJson(res, 200, result);
                }
                catch (err) {
                    return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to import backtest history');
                }
            }
            if (url === '/auth/backtest_sync_signals') {
                if (!body.user_id || !body.channel_row_id || !body.from || !body.to) {
                    return sendJson(res, 400, { error: 'user_id, channel_row_id, from, and to are required' });
                }
                try {
                    const result = await sessionManager.syncBacktestSignals(body.user_id, body.channel_row_id, body.from, body.to, body.run_id);
                    return sendJson(res, 200, result);
                }
                catch (err) {
                    return handleTelegramRpcError(res, body.user_id, sessionManager, err, 'Failed to sync backtest signals');
                }
            }
            if (url === '/internal/reconcile-signals') {
                const body = (await readJson(req));
                if (body.user_id) {
                    if (!(0, workerConfig_1.userBelongsToShard)(body.user_id)) {
                        return sendJson(res, 200, { ok: false, reason: 'wrong_shard' });
                    }
                    try {
                        const result = await sessionManager.reconcileUserSignals(body.user_id, {
                            channelRowId: body.channel_row_id,
                        });
                        return sendJson(res, 200, result);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : 'reconcile failed';
                        return sendJson(res, 500, { error: msg });
                    }
                }
                const result = await sessionManager.reconcileAllListenersOnShard();
                return sendJson(res, 200, { ok: true, ...result });
            }
            return sendJson(res, 404, { error: 'Unknown route' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Internal error';
            console.error('[httpServer] error:', msg);
            return sendJson(res, 500, { error: sanitizeClientError(msg) });
        }
    });
    server.listen(PORT, () => {
        console.log(`[httpServer] listening on :${PORT}`);
    });
    return server;
}
/**
 * Trade workers: `/health` + optional `/internal/dispatch-signal` (listener push).
 */
function startTradeHttpServer(sessionManager, tradeExecutor) {
    const server = (0, http_1.createServer)(async (req, res) => {
        try {
            const url = (req.url ?? '').split('?')[0] ?? '';
            if (url === '/health' && (req.method === 'GET' || req.method === 'POST')) {
                const payload = await sessionManager.getHealthPayload();
                const queue = await (0, queueHealth_1.getQueueHealthMetrics)();
                return sendJson(res, payload.ok ? 200 : 503, {
                    ...payload,
                    queue,
                });
            }
            if (url === '/internal/parse-signal' && req.method === 'POST') {
                if (!INTERNAL_TOKEN) {
                    return sendJson(res, 503, { error: 'WORKER_INTERNAL_TOKEN not configured' });
                }
                const token = req.headers['x-internal-token'];
                if (token !== INTERNAL_TOKEN) {
                    return sendJson(res, 401, { error: 'Unauthorized' });
                }
                const body = (await readJson(req));
                if (!body.channel_row_id || typeof body.raw_message !== 'string') {
                    return sendJson(res, 400, { error: 'channel_row_id and raw_message required' });
                }
                if (body.user_id && !(0, workerConfig_1.userBelongsToShard)(body.user_id)) {
                    return sendJson(res, 200, { parsed: null, status: 'skipped', reason: 'wrong_shard' });
                }
                try {
                    const result = await (0, parseSignal_1.parseRawChannelMessage)(sessionManager.getSupabase(), body.channel_row_id, body.raw_message);
                    return sendJson(res, 200, {
                        parsed: result.parsed,
                        status: result.status,
                        skip_reason: result.skip_reason,
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : 'parse failed';
                    return sendJson(res, 500, { error: msg });
                }
            }
            if (url === '/internal/parse-modification' && req.method === 'POST') {
                if (!INTERNAL_TOKEN) {
                    return sendJson(res, 503, { error: 'WORKER_INTERNAL_TOKEN not configured' });
                }
                const token = req.headers['x-internal-token'];
                if (token !== INTERNAL_TOKEN) {
                    return sendJson(res, 401, { error: 'Unauthorized' });
                }
                const body = (await readJson(req));
                if (!body.channel_row_id || typeof body.raw_message !== 'string' || !body.user_id) {
                    return sendJson(res, 400, { error: 'channel_row_id, raw_message, and user_id required' });
                }
                if (!(0, workerConfig_1.userBelongsToShard)(body.user_id)) {
                    return sendJson(res, 200, { parsed: null, status: 'skipped', reason: 'wrong_shard' });
                }
                try {
                    const aiResult = await (0, aiParseModification_1.aiParseModification)(sessionManager.getSupabase(), {
                        userId: body.user_id,
                        channelRowId: body.channel_row_id,
                        rawMessage: body.raw_message,
                        isReply: body.is_reply === true,
                        parentSignalId: body.parent_signal_id ?? null,
                        revision: body.revision?.prior_raw_message
                            ? {
                                prior_raw_message: body.revision.prior_raw_message,
                                prior_parsed_data: body.revision.prior_parsed_data ?? null,
                            }
                            : undefined,
                        forceAi: body.force_ai === true,
                    });
                    const parseResult = (0, aiParseModification_1.aiResultToParseResult)(aiResult);
                    return sendJson(res, 200, {
                        parsed: parseResult.parsed,
                        status: parseResult.status,
                        skip_reason: parseResult.skip_reason,
                        intent: aiResult.intent,
                        typo_corrected: aiResult.typo_corrected,
                        confidence: aiResult.confidence,
                        source: aiResult.source,
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : 'parse modification failed';
                    return sendJson(res, 500, { error: msg });
                }
            }
            if (url === '/internal/dispatch-signal' && req.method === 'POST') {
                if (!INTERNAL_TOKEN) {
                    return sendJson(res, 503, { error: 'WORKER_INTERNAL_TOKEN not configured' });
                }
                const token = req.headers['x-internal-token'];
                if (token !== INTERNAL_TOKEN) {
                    return sendJson(res, 401, { error: 'Unauthorized' });
                }
                if (!tradeExecutor) {
                    return sendJson(res, 503, { error: 'trade_executor_not_running' });
                }
                const body = (await readJson(req));
                const raw = body.signal;
                if (!raw || typeof raw.id !== 'string' || typeof raw.user_id !== 'string') {
                    return sendJson(res, 400, { error: 'signal.id and signal.user_id required' });
                }
                if (!(0, workerConfig_1.userBelongsToShard)(raw.user_id)) {
                    return sendJson(res, 200, { accepted: false, reason: 'wrong_shard' });
                }
                const signalRow = {
                    ...raw,
                    pipeline_ts: raw.pipeline_ts,
                };
                const dispatchOpts = {
                    priority: body.priority,
                    source: body.source ?? 'listener_push',
                };
                const awaitByDefault = String(process.env.TRADE_DISPATCH_AWAIT_DEFAULT ?? 'false').toLowerCase() === 'true';
                const shouldAwait = body.await === true
                    || (body.await !== false && awaitByDefault);
                const accepted = shouldAwait
                    ? await tradeExecutor.acceptDispatchSignalAwait(signalRow, dispatchOpts)
                    : tradeExecutor.acceptDispatchSignal(signalRow, dispatchOpts);
                return sendJson(res, 200, { accepted, awaited: shouldAwait });
            }
            return sendJson(res, 404, { error: 'Not found' });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : 'Internal error';
            console.error('[httpServer] trade http error:', msg);
            return sendJson(res, 500, { error: 'Request failed' });
        }
    });
    server.listen(PORT, () => {
        console.log(`[httpServer] trade API listening on :${PORT}`);
    });
    return server;
}
async function readJson(req) {
    const chunks = [];
    for await (const c of req)
        chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
}
