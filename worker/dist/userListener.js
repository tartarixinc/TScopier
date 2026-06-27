"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserListener = void 0;
const node_crypto_1 = require("node:crypto");
const telegram_1 = require("telegram");
const events_1 = require("telegram/events");
const EditedMessage_1 = require("telegram/events/EditedMessage");
const tl_1 = require("telegram/tl");
const telegramClient_1 = require("./telegramClient");
const backtestSignal_1 = require("./backtestSignal");
const signalQueuePublisher_1 = require("./queue/signalQueuePublisher");
const signalQueueConfig_1 = require("./queue/signalQueueConfig");
const tradeSignalPush_1 = require("./tradeSignalPush");
const listenerEvents_1 = require("./listenerEvents");
const channelKeywordsCache_1 = require("./channelKeywordsCache");
const parseSignal_1 = require("./parseSignal");
const signalTradingHeuristic_1 = require("./signalTradingHeuristic");
const signalManagementIntent_1 = require("./signalManagementIntent");
const normalizeTelegramMessageText_1 = require("./normalizeTelegramMessageText");
const workerMetrics_1 = require("./workerMetrics");
const workerConfig_1 = require("./workerConfig");
const tradeSignalActions_1 = require("./tradeSignalActions");
const copierPause_1 = require("./copierPause");
const signalRevision_1 = require("./signalRevision");
const aiParseModification_1 = require("./aiParseModification");
const aiParseEntry_1 = require("./aiParseEntry");
const signalTelegramReconcile_1 = require("./signalTelegramReconcile");
const signalExecutionEligibility_1 = require("./signalExecutionEligibility");
const channelListenerIntegration_1 = require("./channelListenerIntegration");
const channelListenerConfig_1 = require("./channelListenerConfig");
const channelRegistry_1 = require("./channelRegistry");
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const PARSE_SIGNAL_URL = process.env.PARSE_SIGNAL_URL ?? (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/parse-signal` : '');
const RAW_PARSE_SIGNAL_KEY = process.env.PARSE_SIGNAL_KEY ?? '';
const isJwt = (v) => v.split('.').length === 3;
const PARSE_SIGNAL_AUTH_KEY = isJwt(RAW_PARSE_SIGNAL_KEY)
    ? RAW_PARSE_SIGNAL_KEY
    : SUPABASE_SERVICE_ROLE_KEY;
const PARSE_SIGNAL_API_KEY = SUPABASE_SERVICE_ROLE_KEY;
function listenerInlineParseEnabled() {
    const v = String(process.env.LISTENER_INLINE_PARSE ?? 'true').toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no';
}
/** Min seconds between client.connect() and first getDialogs on a fresh session. */
const COLD_FANOUT_DELAY_MS = 8000;
const DIALOG_CACHE_TTL_MS = 60000;
const DIALOG_MAX_SCAN = 500;
const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_FAILURE_THRESHOLD = 2;
const SAFETY_POLL_INTERVAL_MS = Math.max(5000, Math.min(60000, Number(process.env.TELEGRAM_SAFETY_POLL_MS ?? 10000)));
/**
 * Fast poll for channels Telegram is NOT pushing live updates for (last_live_at
 * stale/null). Telegram silently stops pushing updates for broadcast channels it
 * considers inactive on a session; without this, those signals are only picked
 * up by the safety poll (avg ~5s extra latency at 10s safety interval).
 */
const FAST_POLL_INTERVAL_MS = Math.max(1000, Math.min(15000, Number(process.env.TELEGRAM_FAST_POLL_MS ?? 3000)));
/** A channel counts as live-dead when no live push has been seen for this long. */
const FAST_POLL_LIVE_STALE_MS = Math.max(60000, Number(process.env.TELEGRAM_FAST_POLL_LIVE_STALE_MS ?? 2 * 60000));
const SESSION_PERSIST_INTERVAL_MS = 30 * 60000;
const CATCHUP_BACKPRESSURE_MS = 250;
const CATCHUP_PER_CHANNEL_CAP = 200;
const BACKFILL_PER_CHANNEL_CAP = 1000;
const REPLY_CHAIN_SWEEP_MS = 60000;
/** Re-fetch teaser entries (e.g. "Gold buy now") after channel adds SL/TP via edit. */
const ENTRY_MESSAGE_SETTLE_MS = Math.max(3000, Math.min(30000, Number(process.env.ENTRY_MESSAGE_SETTLE_MS ?? 10000)));
function entryMessageSettleDelaysMs() {
    const raw = String(process.env.ENTRY_MESSAGE_SETTLE_DELAYS_MS ?? '').trim();
    if (raw) {
        const parsed = raw
            .split(',')
            .map(s => Number(s.trim()))
            .filter(n => Number.isFinite(n) && n >= 3000)
            .map(n => Math.min(30000, Math.floor(n)));
        if (parsed.length)
            return [...new Set(parsed)];
    }
    const second = Math.min(30000, ENTRY_MESSAGE_SETTLE_MS * 3);
    return second > ENTRY_MESSAGE_SETTLE_MS
        ? [ENTRY_MESSAGE_SETTLE_MS, second]
        : [ENTRY_MESSAGE_SETTLE_MS];
}
const ENTITY_WARMUP_INTERVAL_MS = Math.max(60000, Math.min(30 * 60000, Number(process.env.TELEGRAM_ENTITY_WARMUP_INTERVAL_MS ?? 10 * 60000)));
function catchUpOnStartEnabled() {
    const v = String(process.env.TELEGRAM_CATCHUP_ON_START ?? 'true').toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no';
}
/** Skip catch-up parse/trade for Telegram posts older than this (avoids stale fills after deploy). */
function catchUpMaxAgeMs() {
    const minutes = Math.max(1, Math.min(24 * 60, Number(process.env.TELEGRAM_CATCHUP_MAX_AGE_MINUTES ?? 20)));
    return minutes * 60000;
}
function catchUpParseConcurrency() {
    return Math.max(1, Math.min(4, Number(process.env.TELEGRAM_CATCHUP_PARSE_CONCURRENCY ?? 2)));
}
function livePriorityPauseMs() {
    return Math.max(0, Math.min(30000, Number(process.env.TELEGRAM_LIVE_PRIORITY_PAUSE_MS ?? 3000)));
}
function reconnectCooldownMs() {
    return Math.max(500, Math.min(120000, Number(process.env.TELEGRAM_RECONNECT_COOLDOWN_MS ?? 3500)));
}
const AUTH_KEY_DUP_RECONNECT_DELAY_MS = Math.max(2000, Math.min(30000, Number(process.env.TELEGRAM_AUTH_DUP_RECONNECT_DELAY_MS ?? 10000)));
function startConnectJitterMaxMs() {
    return Math.max(0, Math.min(30000, Number(process.env.TELEGRAM_START_JITTER_MAX_MS ?? 2000)));
}
/** Telegram / gramjs: extract numeric reply target message id when present. */
function extractReplyToMsgId(replyTo) {
    if (replyTo == null || typeof replyTo !== 'object')
        return null;
    const r = replyTo;
    const v = r.replyToMsgId ?? r.reply_to_msg_id;
    if (v == null)
        return null;
    const s = String(v).trim();
    return s ? s : null;
}
function normalizeChannelUsername(raw) {
    return (raw ?? '').trim().replace(/^@/, '').toLowerCase();
}
function isValidTelegramUsername(raw) {
    const value = normalizeChannelUsername(raw);
    if (!value)
        return false;
    return /^[a-z0-9_]{5,32}$/i.test(value);
}
function isNumericTelegramChatId(raw) {
    return /^-?\d+$/.test(String(raw ?? '').trim());
}
function toChannelIdVariants(raw) {
    const value = (raw ?? '').trim();
    if (!value)
        return [];
    const out = new Set([value]);
    const n = Number(value);
    if (!Number.isFinite(n))
        return [...out];
    const abs = String(Math.abs(Math.trunc(n)));
    out.add(abs);
    if (value.startsWith('-100')) {
        out.add(value.slice(4));
    }
    else if (!value.startsWith('-')) {
        // Telegram often represents channel peers as -100<id> in updates,
        // while dialogs/list results can expose plain positive ids.
        out.add(`-100${value}`);
    }
    else {
        out.add(`-100${abs}`);
    }
    return [...out];
}
class UserListener {
    constructor(userId, sessionString, supabase, adoptedClient) {
        this.monitoredChannels = new Set();
        this.currentHandler = null;
        this.currentEventBuilder = null;
        this.currentEditHandler = null;
        this.currentEditEventBuilder = null;
        this.startedAt = 0;
        /** Set when start() reuses the auth-time client (no second connect). */
        this.startedWithLiveClient = false;
        this.dialogsCache = null;
        this.dialogsCacheAt = 0;
        this.safetyPollTimer = null;
        this.fastPollTimer = null;
        this.fastPollRows = [];
        this.fastPollRowsAt = 0;
        this.fastPollInFlight = false;
        /** In-memory live-push freshness per channel row (DB last_live_at can lag). */
        this.lastLiveByRow = new Map();
        this.watchdogTimer = null;
        this.sessionPersistTimer = null;
        this.replyChainSweepTimer = null;
        this.signalReconcileSweepTimer = null;
        this.signalReconcileInFlight = false;
        this.entityWarmupTimer = null;
        this.catchUpInFlight = false;
        this.catchUpParseActive = 0;
        this.lastLiveMessageAt = 0;
        this.isConnected = false;
        this.lastEventAt = 0;
        this.lastSuccessfulPollAt = 0;
        this.lastReconnectAt = 0;
        this.consecutiveProbeFailures = 0;
        this.onSignalParsed = null;
        /** Recent live message ids — avoids a Supabase round-trip on hot-path dedup. */
        this.liveMessageDedup = new Map();
        this.userProfilesCopierPauseChannel = null;
        /** Serializes message revision apply per channel row + telegram message id. */
        this.revisionChains = new Map();
        /** signal_channel_ids where canonical feed is live — skip poll/reconcile in primary mode. */
        this.passiveSignalChannelIds = new Set();
        this.userId = userId;
        this.supabase = supabase;
        this.client = adoptedClient ?? (0, telegramClient_1.buildClient)(sessionString);
        this.lastSavedSession = sessionString;
    }
    /** Immediate trade dispatch after parse (avoids waiting on Supabase Realtime). */
    setOnSignalParsed(handler) {
        this.onSignalParsed = handler;
    }
    // ── lifecycle ─────────────────────────────────────────────────────────
    async start(opts = {}) {
        if (!opts.alreadyConnected) {
            const jm = startConnectJitterMaxMs();
            if (jm > 0) {
                const jitter = Math.floor(Math.random() * (jm + 1));
                if (jitter > 0)
                    await new Promise(r => setTimeout(r, jitter));
            }
            try {
                await this.client.connect();
            }
            catch (err) {
                if ((0, telegramClient_1.isAuthKeyUnregistered)(err))
                    throw new telegramClient_1.TelegramSessionInvalidError();
                if ((0, telegramClient_1.isAuthKeyDuplicated)(err)) {
                    console.warn(`[userListener] AUTH_KEY_DUPLICATED on initial connect for ${this.userId}`
                        + ` — old session still releasing; waiting ${AUTH_KEY_DUP_RECONNECT_DELAY_MS}ms then retrying`);
                    (0, workerMetrics_1.incMetric)('auth_key_duplicated');
                    try {
                        await this.client.disconnect();
                    }
                    catch { /* ignore */ }
                    await new Promise(r => setTimeout(r, AUTH_KEY_DUP_RECONNECT_DELAY_MS));
                    await this.client.connect();
                }
                else {
                    throw err;
                }
            }
        }
        this.isConnected = true;
        this.startedAt = Date.now();
        this.lastEventAt = Date.now();
        // Warm gramjs entity cache so NewMessage events fire for all channels.
        await this.warmEntityCache();
        await this.refreshChannelSubscription();
        await this.refreshChannelListenerState();
        this.scheduleCatchUpOnStart();
        this.startWatchdog();
        this.startSafetyPoll();
        this.startFastPoll();
        void this.pollMonitoredChannelsForMessages().catch(err => console.warn(`[userListener] initial channel poll failed for ${this.userId}:`, err));
        this.startSessionPersist();
        this.startReplyChainSweep();
        this.startSignalReconcileSweep();
        this.startEntityWarmup();
        this.subscribeCopierPauseState();
    }
    async stop() {
        try {
            if (this.userProfilesCopierPauseChannel) {
                await this.supabase.removeChannel(this.userProfilesCopierPauseChannel);
                this.userProfilesCopierPauseChannel = null;
            }
            this.stopTimer('watchdogTimer');
            this.stopTimer('safetyPollTimer');
            this.stopTimer('fastPollTimer');
            this.stopTimer('sessionPersistTimer');
            this.stopTimer('replyChainSweepTimer');
            this.stopTimer('signalReconcileSweepTimer');
            this.stopTimer('entityWarmupTimer');
            this.removeCurrentHandler();
            await this.persistSessionIfChanged();
            await this.client.disconnect();
        }
        catch {
            // ignore disconnect errors
        }
        finally {
            this.isConnected = false;
            this.clearDialogsCache();
        }
    }
    clearDialogsCache() {
        this.dialogsCache = null;
        this.dialogsCacheAt = 0;
    }
    stopTimer(field) {
        const t = this[field];
        if (t) {
            clearInterval(t);
            this[field] = null;
        }
    }
    /** True while MTProto is up after connect/reconnect (false during disconnect/reconnect). */
    isTelegramConnected() {
        return this.isConnected;
    }
    getStatus() {
        return {
            user_id: this.userId,
            connected: this.isConnected,
            last_event_at: this.lastEventAt,
            last_successful_poll_at: this.lastSuccessfulPollAt,
            last_reconnect_at: this.lastReconnectAt,
            monitored_channels: this.monitoredChannels.size,
            consecutive_probe_failures: this.consecutiveProbeFailures,
        };
    }
    getClient() {
        return this.client;
    }
    /** Public wrapper for channel reconcile monitor peer resolution. */
    async resolveChannelPeerForReconcile(row) {
        return this.resolveChannelPeer(row);
    }
    /** Used by session manager to skip lease renew when listener is stale. */
    isListenerHealthy(staleMs) {
        const now = Date.now();
        const lastActivity = Math.max(this.lastEventAt, this.lastSuccessfulPollAt);
        return this.isConnected && (lastActivity === 0 || now - lastActivity < staleMs);
    }
    async refreshChannelListenerState() {
        this.passiveSignalChannelIds = await (0, channelListenerIntegration_1.refreshPassiveSignalChannels)(this.supabase, this.userId);
        const acquired = await (0, channelListenerIntegration_1.syncUserChannelReaderLeases)(this.supabase, this.userId);
        if (acquired > 0) {
            console.log(`[userListener] acquired ${acquired} channel reader lease(s) user=${this.userId}`);
        }
    }
    // ── channel subscription ──────────────────────────────────────────────
    /**
     * Public hook for the session manager's Realtime subscription. Called
     * whenever telegram_channels changes for this user. Refreshes the
     * NewMessage filter and runs catch-up for any newly added channels.
     */
    async onChannelsChanged() {
        const { data: activeChannelRows } = await this.supabase
            .from('telegram_channels')
            .select('id')
            .eq('user_id', this.userId)
            .eq('is_active', true);
        for (const row of activeChannelRows ?? []) {
            const id = row.id;
            if (id)
                (0, channelKeywordsCache_1.invalidateChannelParseCache)(id);
        }
        const previous = new Set(this.monitoredChannels);
        await this.refreshChannelSubscription();
        await this.refreshChannelListenerState();
        const { data: rows } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username, signal_channel_id, last_seen_message_id, last_seen_at, last_live_at')
            .eq('user_id', this.userId)
            .eq('is_active', true);
        const added = [...this.monitoredChannels].filter(c => !previous.has(c));
        const lookup = new Map();
        for (const row of (rows ?? [])) {
            if (row.channel_id && isNumericTelegramChatId(String(row.channel_id))) {
                for (const v of toChannelIdVariants(String(row.channel_id))) {
                    lookup.set(v, row);
                }
            }
            if (isValidTelegramUsername(row.channel_username)) {
                lookup.set(normalizeChannelUsername(row.channel_username), row);
            }
        }
        for (const key of added) {
            const row = lookup.get(key);
            if (row) {
                if (row.signal_channel_id) {
                    void (0, channelRegistry_1.inheritChannelHistory)(this.supabase, this.userId, row.signal_channel_id).catch(err => console.warn(`[userListener] inheritChannelHistory failed channel=${row.id}:`, err));
                }
                await this.warmChannelEntity(row).catch(err => console.warn(`[userListener] entity warmup failed channel=${row.id}:`, err));
                await this.catchUpChannel(row).catch(err => console.error(`[userListener] catchUp (added) failed for ${row.id}:`, err));
            }
        }
        // Keep entity cache hot for every active channel (not only newly added keys).
        for (const row of (rows ?? [])) {
            await this.warmChannelEntity(row).catch(() => { });
            await this.ensureJoinedPublicChannel(row).catch(err => console.warn(`[userListener] join channel failed ${row.id}:`, err));
        }
        // Poll channels with no recent activity (missed live events or stale entity).
        const pollStaleMs = 5 * 60000;
        const now = Date.now();
        for (const row of (rows ?? [])) {
            const lastLive = row.last_live_at ? new Date(row.last_live_at).getTime() : 0;
            const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
            const lastActivity = Math.max(lastLive, lastSeen);
            if (lastActivity > 0 && now - lastActivity < pollStaleMs)
                continue;
            await this.pollChannelNewMessages(row).catch(err => console.warn(`[userListener] poll (stale) failed for ${row.id}:`, err));
        }
        // Never heard from Telegram at all.
        for (const row of (rows ?? [])) {
            if (row.last_seen_at)
                continue;
            await this.pollChannelNewMessages(row).catch(err => console.warn(`[userListener] poll (never-heard) failed for ${row.id}:`, err));
        }
    }
    /**
     * Read the active channel set for this user and (re)subscribe the
     * NewMessage handler scoped to those chats only. Listening globally
     * (NewMessage({})) and filtering in JS is one of the userbot
     * fingerprints Telegram flags on cold accounts.
     */
    async refreshChannelSubscription() {
        const next = await this.loadChannels();
        if (this.currentHandler && this.setsEqual(next, this.monitoredChannels)) {
            return;
        }
        this.removeCurrentHandler();
        this.monitoredChannels = next;
        if (next.size === 0)
            return;
        const handler = (event) => {
            this.handleMessage(event).catch(err => {
                console.error(`[userListener] handleMessage error for ${this.userId}:`, err);
            });
        };
        // NOTE:
        // Passing `chats:` here depends on Telegram/gramjs resolving each chat
        // identifier exactly as expected. In practice, channel ids can vary in
        // representation (e.g. -100 prefix / raw ids), and a mismatch can result
        // in silently missing all updates. We subscribe to all incoming messages
        // and apply strict user/channel filtering in handleMessage() instead.
        // Important: do not use `incoming: true` here — channel posts are not
        // always classified as "incoming", which can cause silent drops.
        const editHandler = (event) => {
            this.handleEditedMessage(event).catch(err => {
                console.error(`[userListener] handleEditedMessage error for ${this.userId}:`, err);
            });
        };
        const builder = new events_1.NewMessage({});
        const editBuilder = new EditedMessage_1.EditedMessage({});
        this.client.addEventHandler(handler, builder);
        this.client.addEventHandler(editHandler, editBuilder);
        this.currentHandler = handler;
        this.currentEventBuilder = builder;
        this.currentEditHandler = editHandler;
        this.currentEditEventBuilder = editBuilder;
    }
    removeCurrentHandler() {
        if (this.currentHandler && this.currentEventBuilder) {
            try {
                this.client.removeEventHandler(this.currentHandler, this.currentEventBuilder);
            }
            catch {
                // ignore
            }
        }
        if (this.currentEditHandler && this.currentEditEventBuilder) {
            try {
                this.client.removeEventHandler(this.currentEditHandler, this.currentEditEventBuilder);
            }
            catch {
                // ignore
            }
        }
        this.currentHandler = null;
        this.currentEventBuilder = null;
        this.currentEditHandler = null;
        this.currentEditEventBuilder = null;
    }
    setsEqual(a, b) {
        if (a.size !== b.size)
            return false;
        for (const v of a)
            if (!b.has(v))
                return false;
        return true;
    }
    async loadChannels() {
        const { data } = await this.supabase
            .from('telegram_channels')
            .select('channel_id, channel_username')
            .eq('user_id', this.userId)
            .eq('is_active', true);
        const next = new Set();
        for (const ch of data ?? []) {
            if (ch.channel_id && isNumericTelegramChatId(String(ch.channel_id))) {
                for (const v of toChannelIdVariants(String(ch.channel_id)))
                    next.add(v);
            }
            if (isValidTelegramUsername(ch.channel_username)) {
                next.add(normalizeChannelUsername(ch.channel_username));
            }
        }
        return next;
    }
    async resolveChannelRowForChat(chatIdVariants, chatUsername) {
        const { data: rows, error } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username, last_seen_message_id')
            .eq('user_id', this.userId)
            .eq('is_active', true);
        if (error || !rows?.length)
            return null;
        const variantSet = new Set(chatIdVariants);
        for (const row of rows) {
            const storedId = String(row.channel_id ?? '').trim();
            if (storedId && isNumericTelegramChatId(storedId)) {
                if (toChannelIdVariants(storedId).some(v => variantSet.has(v))) {
                    return row;
                }
            }
        }
        if (chatUsername) {
            const wanted = normalizeChannelUsername(chatUsername);
            for (const row of rows) {
                const stored = normalizeChannelUsername(row.channel_username);
                if (stored && stored === wanted)
                    return row;
            }
        }
        return null;
    }
    /**
     * Return user's channels/groups. Delays the first call after start to
     * avoid cold-session fan-out, pages with a small limit, and caches the
     * result briefly so onboarding UI re-renders don't re-hit Telegram.
     */
    async listChannels(opts) {
        if (!opts?.skipColdDelay && !this.startedWithLiveClient) {
            const elapsed = Date.now() - this.startedAt;
            if (elapsed >= 0 && elapsed < COLD_FANOUT_DELAY_MS) {
                await new Promise(r => setTimeout(r, COLD_FANOUT_DELAY_MS - elapsed));
            }
        }
        if (this.dialogsCache && (Date.now() - this.dialogsCacheAt) < DIALOG_CACHE_TTL_MS) {
            return this.dialogsCache;
        }
        let dialogs;
        try {
            dialogs = await this.fetchAllDialogs();
        }
        catch (err) {
            if ((0, telegramClient_1.isAuthKeyDuplicated)(err)) {
                dialogs = await this.reconnectAndRetryDialogs();
            }
            else {
                (0, telegramClient_1.rethrowIfSessionInvalid)(err);
            }
        }
        const byId = new Map();
        for (const d of dialogs) {
            if (!d.isChannel && !d.isGroup)
                continue;
            const entity = (d.entity ?? {});
            const id = String(d.id ?? '');
            if (!id)
                continue;
            byId.set(id, {
                id,
                title: d.title ?? 'Unknown',
                username: entity.username ?? '',
                members_count: entity.participantsCount ?? 0,
            });
        }
        const channels = [...byId.values()];
        this.dialogsCache = channels;
        this.dialogsCacheAt = Date.now();
        return channels;
    }
    async reconnectAndRetryDialogs() {
        console.warn(`[userListener] AUTH_KEY_DUPLICATED on getDialogs for ${this.userId}`
            + ' — disconnecting, waiting for old session to release, then reconnecting');
        (0, workerMetrics_1.incMetric)('auth_key_duplicated');
        const delays = [
            AUTH_KEY_DUP_RECONNECT_DELAY_MS,
            15000,
            15000,
        ];
        let lastErr;
        for (let attempt = 0; attempt < delays.length; attempt++) {
            this.isConnected = false;
            try {
                await this.client.disconnect();
            }
            catch { /* ignore */ }
            await new Promise(r => setTimeout(r, delays[attempt]));
            try {
                await this.client.connect();
                this.isConnected = true;
                return await this.fetchAllDialogs();
            }
            catch (err) {
                lastErr = err;
                if (!(0, telegramClient_1.isAuthKeyDuplicated)(err))
                    (0, telegramClient_1.rethrowIfSessionInvalid)(err);
                console.warn(`[userListener] AUTH_KEY_DUPLICATED reconnect attempt ${attempt + 1}/${delays.length}`
                    + ` for ${this.userId}`);
            }
        }
        throw lastErr;
    }
    /**
     * Load channel/group dialogs (capped). Uses gramjs built-in pagination, which
     * offsets by top *message* id — not dialog/peer id (large channel ids overflow int32).
     */
    async fetchAllDialogs() {
        return this.client.getDialogs({ limit: DIALOG_MAX_SCAN });
    }
    /**
     * Explicit historical import used by channel insights profiling.
     * Fetches and stores matching messages for the last N days even when
     * last_seen_message_id is still empty (seed-only mode).
     */
    async backfillChannelHistory(channelRowId, days, opts) {
        const lookbackDays = Math.max(1, Math.min(90, Number(days || 30)));
        const { data: row, error } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username, last_seen_message_id')
            .eq('user_id', this.userId)
            .eq('id', channelRowId)
            .eq('is_active', true)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        if (!row)
            throw new Error('Channel not found');
        const messages = await this.backfillChannelFromDate(row, lookbackDays, opts);
        return { imported: messages.length, messages };
    }
    /**
     * Fetch Telegram messages in [fromIso, toIso] for backtest only.
     * Does not write to `signals` or trigger copier parse/trade execution.
     */
    async importBacktestChannelHistory(channelRowId, fromIso, toIso) {
        const fromMs = new Date(fromIso).getTime();
        const toMs = new Date(toIso.includes('T') ? toIso : `${toIso}T23:59:59.999Z`).getTime();
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
            throw new Error('Invalid backtest date range');
        }
        const { data: row, error } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username, last_seen_message_id')
            .eq('user_id', this.userId)
            .eq('id', channelRowId)
            .eq('is_active', true)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        if (!row)
            throw new Error('Channel not found');
        const collected = await this.fetchMessagesBetweenForBacktest(row, fromMs, toMs);
        const messages = [];
        for (const m of collected) {
            const raw = (0, signalTelegramReconcile_1.telegramMessageText)(m);
            if (!raw)
                continue;
            const epoch = this.messageEpochSec(m);
            const signalAt = epoch > 0
                ? new Date(epoch * 1000).toISOString()
                : new Date().toISOString();
            messages.push({
                telegram_message_id: String(m.id),
                raw_message: raw,
                signal_at: signalAt,
            });
        }
        return { messages, messages_scanned: collected.length };
    }
    /**
     * Sync Telegram history into backtest_channel_signals (parse + upsert on worker).
     */
    async syncBacktestSignals(channelRowId, fromIso, toIso, opts) {
        const fromMs = new Date(fromIso).getTime();
        const toMs = new Date(toIso.includes('T') ? toIso : `${toIso}T23:59:59.999Z`).getTime();
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
            throw new Error('Invalid backtest date range');
        }
        if (!PARSE_SIGNAL_URL || !PARSE_SIGNAL_AUTH_KEY) {
            throw new Error('PARSE_SIGNAL_URL / service role key not configured on worker');
        }
        const { data: row, error } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username, last_seen_message_id')
            .eq('user_id', this.userId)
            .eq('id', channelRowId)
            .eq('is_active', true)
            .maybeSingle();
        if (error)
            throw new Error(error.message);
        if (!row)
            throw new Error('Channel not found');
        const runId = opts?.runId;
        if (runId) {
            await this.supabase.from('backtest_runs').update({
                progress_pct: 1,
                progress_message: 'Fetching messages from Telegram…',
                updated_at: new Date().toISOString(),
            }).eq('id', runId).eq('user_id', this.userId);
        }
        const collected = await this.fetchMessagesBetweenForBacktest(row, fromMs, toMs);
        const errors = [];
        const heuristicCtx = await (0, channelKeywordsCache_1.getChannelParseContext)(this.supabase, channelRowId);
        const rangeFromIso = new Date(fromMs).toISOString();
        const rangeToIso = new Date(toMs).toISOString();
        const { error: delErr } = await this.supabase
            .from('backtest_channel_signals')
            .delete()
            .eq('user_id', this.userId)
            .eq('channel_id', channelRowId)
            .eq('source', 'telegram_import')
            .gte('signal_at', rangeFromIso)
            .lte('signal_at', rangeToIso);
        if (delErr)
            errors.push(`clear prior import: ${delErr.message}`);
        const candidates = [];
        for (const m of collected) {
            const raw = (0, signalTelegramReconcile_1.telegramMessageText)(m);
            if (!raw)
                continue;
            const isReply = !!m.replyTo;
            if (!(0, signalTradingHeuristic_1.looksLikeTradingSignal)(raw, isReply, heuristicCtx))
                continue;
            const epoch = this.messageEpochSec(m);
            candidates.push({
                raw,
                signalAt: epoch > 0 ? new Date(epoch * 1000).toISOString() : new Date().toISOString(),
                telegramMessageId: String(m.id),
            });
        }
        let imported = 0;
        const parseConcurrency = Math.max(1, Math.min(8, Number(process.env.BACKTEST_PARSE_CONCURRENCY ?? 4)));
        const parseDelayMs = Math.max(0, Number(process.env.BACKTEST_PARSE_DELAY_MS ?? 0));
        const reportSyncProgress = async (parsed, total) => {
            if (!runId)
                return;
            const pct = total > 0 ? 5 + Math.floor((parsed / total) * 90) : 5;
            await this.supabase.from('backtest_runs').update({
                progress_pct: pct,
                progress_message: `Parsing signals ${parsed}/${total}…`,
                updated_at: new Date().toISOString(),
            }).eq('id', runId).eq('user_id', this.userId);
        };
        if (runId) {
            await this.supabase.from('backtest_runs').update({
                progress_pct: 5,
                progress_message: candidates.length > 0
                    ? `Found ${candidates.length} candidate message(s) — parsing…`
                    : 'No trade-like messages in range',
                updated_at: new Date().toISOString(),
            }).eq('id', runId).eq('user_id', this.userId);
        }
        await reportSyncProgress(0, candidates.length);
        let parsedCount = 0;
        await this.mapWithConcurrency(candidates, parseConcurrency, async (c) => {
            try {
                const parsed = await this.parseSignalForBacktest(channelRowId, c.raw);
                if (!parsed)
                    return;
                const tradeable = (0, backtestSignal_1.tradeableFromParsed)(parsed);
                if (!tradeable)
                    return;
                const { error: upsertErr } = await this.supabase.rpc('upsert_backtest_channel_signal', {
                    p_user_id: this.userId,
                    p_channel_id: channelRowId,
                    p_signal_id: null,
                    p_telegram_message_id: c.telegramMessageId,
                    p_source: 'telegram_import',
                    p_direction: tradeable.direction,
                    p_symbol: tradeable.symbol,
                    p_entry_price: tradeable.entry_price,
                    p_sl: tradeable.sl,
                    p_tp_levels: tradeable.tp_levels,
                    p_lot_size: tradeable.lot_size,
                    p_raw_message: c.raw,
                    p_parsed_data: parsed,
                    p_signal_at: c.signalAt,
                });
                if (upsertErr) {
                    errors.push(upsertErr.message);
                    return;
                }
                imported++;
            }
            catch (e) {
                errors.push(e instanceof Error ? e.message : String(e));
            }
            finally {
                parsedCount++;
                if (parsedCount % 3 === 0 || parsedCount === candidates.length) {
                    await reportSyncProgress(parsedCount, candidates.length);
                }
                if (parseDelayMs > 0) {
                    await new Promise(r => setTimeout(r, parseDelayMs));
                }
            }
        });
        if (collected.length === 0) {
            errors.push('0 messages from Telegram — check session and channel access');
        }
        else if (candidates.length === 0) {
            errors.push('No messages looked like trade signals in this range');
        }
        else if (imported === 0 && errors.length === 0) {
            errors.push('No tradeable signals — messages need buy/sell, valid symbol, and SL or TP');
        }
        return {
            messages_scanned: collected.length,
            candidates: candidates.length,
            imported,
            errors,
        };
    }
    async mapWithConcurrency(items, concurrency, fn) {
        if (items.length === 0)
            return;
        let next = 0;
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (true) {
                const i = next++;
                if (i >= items.length)
                    break;
                await fn(items[i]);
            }
        });
        await Promise.all(workers);
    }
    async parseSignalForBacktest(channelRowId, rawMessage) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('parse-timeout'), 15000);
        try {
            const res = await fetch(PARSE_SIGNAL_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${PARSE_SIGNAL_AUTH_KEY}`,
                    apikey: PARSE_SIGNAL_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    parse_only: true,
                    channel_id: channelRowId,
                    raw_message: rawMessage,
                }),
                signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error ?? `parse-signal ${res.status}`);
            }
            if (data.error)
                throw new Error(data.error);
            return data.parsed ?? null;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    // ── live message handling ─────────────────────────────────────────────
    async handleMessage(event) {
        this.lastEventAt = Date.now();
        this.lastLiveMessageAt = Date.now();
        (0, workerMetrics_1.incMetric)('telegram_live_events');
        const message = event.message;
        if (!message)
            return;
        const { chatId, chatIdVariants, chatUsername } = await this.resolveChatIdentity(event);
        if (!chatId && !chatUsername)
            return;
        // We subscribe broadly and filter by our own monitored set.
        const isMonitored = chatIdVariants.some(v => this.monitoredChannels.has(v)) ||
            (!!chatUsername && this.monitoredChannels.has(chatUsername));
        if (!isMonitored)
            return;
        console.log(`[userListener] message candidate user=${this.userId} chatId=${chatId} variants=${chatIdVariants.join(',')} username=${chatUsername || '-'} msgId=${String(message.id)}`);
        // Prefer channel_id matching across normalized variants, fallback to username.
        const channelRow = await this.resolveChannelRowForChat(chatIdVariants, chatUsername);
        if (!channelRow) {
            const { data: configured } = await this.supabase
                .from('telegram_channels')
                .select('display_name, channel_id, channel_username')
                .eq('user_id', this.userId)
                .eq('is_active', true);
            const configuredSummary = (configured ?? [])
                .map(c => `${c.display_name ?? '?'} id=${c.channel_id ?? '-'} @${c.channel_username ?? '-'}`)
                .join('; ');
            console.warn(`[userListener] monitored message could not map to telegram_channels row user=${this.userId}`
                + ` chatId=${chatId} username=${chatUsername || '-'} variants=${chatIdVariants.join(',')}`
                + ` configured=[${configuredSummary}]`);
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'unmapped_channel',
                telegramMessageId: String(message.id),
                detail: {
                    chat_id: chatId,
                    chat_username: chatUsername || null,
                    variants: chatIdVariants,
                    configured: configuredSummary,
                },
            });
            return;
        }
        await this.logSignal(channelRow, {
            id: message.id,
            text: message.text ?? message.message,
            replyTo: message.replyTo,
            date: message.date,
        }, { source: 'live' });
        void this.bumpLastLive(channelRow.id);
    }
    async handleEditedMessage(event) {
        this.lastEventAt = Date.now();
        (0, workerMetrics_1.incMetric)('telegram_edit_events');
        const message = event.message;
        if (!message)
            return;
        const { chatId, chatIdVariants, chatUsername } = await this.resolveChatIdentity(event);
        if (!chatId && !chatUsername)
            return;
        const isMonitored = chatIdVariants.some(v => this.monitoredChannels.has(v)) ||
            (!!chatUsername && this.monitoredChannels.has(chatUsername));
        if (!isMonitored)
            return;
        const channelRow = await this.resolveChannelRowForChat(chatIdVariants, chatUsername);
        if (!channelRow)
            return;
        const rawMessage = (0, signalTelegramReconcile_1.telegramMessageText)(message);
        if (!rawMessage.trim())
            return;
        await this.tryApplyMessageRevision({
            channelRow,
            messageId: String(message.id),
            rawMessage,
            source: 'live_edit',
            telegramEditDateSeen: (0, signalTelegramReconcile_1.telegramEditDateSec)(message),
        });
        void this.bumpLastLive(channelRow.id);
    }
    revisionLockKey(channelRowId, messageId) {
        return `${channelRowId}:${messageId}`;
    }
    runRevisionExclusive(key, fn) {
        const prev = this.revisionChains.get(key) ?? Promise.resolve(false);
        const next = prev.catch(() => false).then(fn);
        this.revisionChains.set(key, next.catch(() => false));
        void next.finally(() => {
            if (this.revisionChains.get(key) === next) {
                this.revisionChains.delete(key);
            }
        });
        return next;
    }
    async tryApplyMessageRevision(args) {
        const key = this.revisionLockKey(args.channelRow.id, args.messageId);
        return this.runRevisionExclusive(key, () => this.tryApplyMessageRevisionInner(args));
    }
    async tryApplyMessageRevisionInner(args) {
        const { channelRow, messageId, rawMessage, source } = args;
        if (await (0, copierPause_1.loadCachedUserCopierPaused)(this.supabase, this.userId))
            return false;
        const existing = await (0, signalRevision_1.loadSignalByTelegramMessage)(this.supabase, {
            userId: this.userId,
            channelRowId: channelRow.id,
            telegramMessageId: messageId,
        });
        if (!existing)
            return false;
        if ((0, signalRevision_1.isIncomingRevisionStale)(existing.telegram_edit_date_seen, args.telegramEditDateSeen)) {
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'message_revision_stale_skipped',
                channelRowId: channelRow.id,
                telegramMessageId: messageId,
                detail: {
                    signal_id: existing.id,
                    source,
                    stored_edit_date: existing.telegram_edit_date_seen,
                    incoming_edit_date: args.telegramEditDateSeen ?? null,
                },
            });
            return false;
        }
        if (!(0, signalRevision_1.storedMessageDiffersFromTelegram)(existing.raw_message, rawMessage))
            return false;
        let aiResult;
        try {
            aiResult = await (0, aiParseModification_1.aiParseModification)(this.supabase, {
                userId: this.userId,
                channelRowId: channelRow.id,
                rawMessage,
                revision: {
                    prior_raw_message: existing.raw_message,
                    prior_parsed_data: (existing.parsed_data ?? null),
                },
            });
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[userListener] message revision AI parse failed user=${this.userId} signalId=${existing.id}:`, errMsg);
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'ai_modification_failed',
                channelRowId: channelRow.id,
                telegramMessageId: messageId,
                detail: { error: errMsg.slice(0, 300), signal_id: existing.id, source, revision: true },
            });
            return false;
        }
        const parseResult = (0, aiParseModification_1.aiResultToParseResult)(aiResult);
        if (parseResult.status !== 'parsed') {
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'ai_modification_skipped',
                channelRowId: channelRow.id,
                telegramMessageId: messageId,
                detail: {
                    signal_id: existing.id,
                    source,
                    revision: true,
                    skip_reason: parseResult.skip_reason,
                    intent: aiResult.intent,
                },
            });
            return false;
        }
        const fresh = await (0, signalRevision_1.loadSignalByTelegramMessage)(this.supabase, {
            userId: this.userId,
            channelRowId: channelRow.id,
            telegramMessageId: messageId,
        });
        if (!fresh)
            return false;
        if ((0, signalRevision_1.isIncomingRevisionStale)(fresh.telegram_edit_date_seen, args.telegramEditDateSeen)) {
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'message_revision_stale_skipped',
                channelRowId: channelRow.id,
                telegramMessageId: messageId,
                detail: {
                    signal_id: fresh.id,
                    source,
                    phase: 'pre_update',
                    stored_edit_date: fresh.telegram_edit_date_seen,
                    incoming_edit_date: args.telegramEditDateSeen ?? null,
                },
            });
            return false;
        }
        if (!(0, signalRevision_1.storedMessageDiffersFromTelegram)(fresh.raw_message, rawMessage))
            return false;
        const updated = await (0, signalRevision_1.updateSignalAfterRevision)(this.supabase, {
            signalId: fresh.id,
            rawMessage,
            parseResult,
            telegramEditDateSeen: args.telegramEditDateSeen,
        });
        if (!updated) {
            if (args.telegramEditDateSeen != null
                && args.telegramEditDateSeen > 0
                && (0, signalRevision_1.isIncomingRevisionStale)(fresh.telegram_edit_date_seen, args.telegramEditDateSeen)) {
                void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                    userId: this.userId,
                    eventType: 'message_revision_stale_skipped',
                    channelRowId: channelRow.id,
                    telegramMessageId: messageId,
                    detail: {
                        signal_id: fresh.id,
                        source,
                        phase: 'update_rejected',
                        stored_edit_date: fresh.telegram_edit_date_seen,
                        incoming_edit_date: args.telegramEditDateSeen,
                    },
                });
            }
            else {
                console.error(`[userListener] message revision update failed user=${this.userId} signalId=${fresh.id}`);
            }
            return false;
        }
        const tRevision = Date.now();
        const dispatchRow = (0, signalRevision_1.buildRevisionDispatchRow)(fresh, parseResult, {
            t_ai_parse_done: tRevision,
            t_dispatch_sent: tRevision,
        });
        dispatchRow.dispatch_source = signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE;
        if (fresh.parsed_data?.action) {
            dispatchRow.revision_prior_action = String(fresh.parsed_data.action);
        }
        console.log(`[userListener] message revision dispatch user=${this.userId} signalId=${fresh.id}`
            + ` channelRow=${channelRow.id} messageId=${messageId} source=${source}`);
        void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
            userId: this.userId,
            eventType: 'message_revision_applied',
            channelRowId: channelRow.id,
            telegramMessageId: messageId,
            detail: {
                signal_id: fresh.id,
                source,
                intent: aiResult.intent,
                ai_source: aiResult.source,
                sl: parseResult.parsed.sl ?? null,
                tp: parseResult.parsed.tp ?? [],
            },
        });
        await this.dispatchRevisionSignal(dispatchRow);
        return true;
    }
    scheduleEntryMessageSettlePoll(channelRow, messageId) {
        for (const delayMs of entryMessageSettleDelaysMs()) {
            setTimeout(() => {
                this.pollEntryMessageRevision(channelRow, messageId, delayMs).catch(err => {
                    console.error(`[userListener] entry settle poll failed user=${this.userId} messageId=${messageId}:`, err instanceof Error ? err.message : err);
                });
            }, delayMs);
        }
    }
    async pollEntryMessageRevision(channelRow, messageId, delayMs) {
        const existing = await (0, signalRevision_1.loadSignalByTelegramMessage)(this.supabase, {
            userId: this.userId,
            channelRowId: channelRow.id,
            telegramMessageId: messageId,
        });
        if (!existing)
            return;
        let peer;
        try {
            peer = await this.resolveChannelPeer(channelRow);
        }
        catch {
            return;
        }
        const numericId = Number(messageId);
        if (!Number.isFinite(numericId) || numericId <= 0)
            return;
        const batch = (await this.client.getMessages(peer, {
            ids: [numericId],
        }));
        const message = batch?.[0];
        const rawMessage = (0, signalTelegramReconcile_1.telegramMessageText)(message);
        if (!rawMessage.trim())
            return;
        if (!(0, signalRevision_1.storedMessageDiffersFromTelegram)(existing.raw_message, rawMessage))
            return;
        void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
            userId: this.userId,
            eventType: 'entry_settle_poll_mismatch',
            channelRowId: channelRow.id,
            telegramMessageId: messageId,
            detail: {
                signal_id: existing.id,
                delay_ms: delayMs ?? null,
                stored_len: existing.raw_message.length,
                fetched_len: rawMessage.length,
            },
        });
        const revised = await this.tryApplyMessageRevision({
            channelRow,
            messageId,
            rawMessage,
            source: 'entry_settle_poll',
            telegramEditDateSeen: (0, signalTelegramReconcile_1.telegramEditDateSec)(message),
        });
        if (revised) {
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'entry_settle_poll_applied',
                channelRowId: channelRow.id,
                telegramMessageId: messageId,
                detail: { signal_id: existing.id, delay_ms: delayMs ?? null },
            });
        }
    }
    async dispatchRevisionSignal(dispatchRow) {
        if (await (0, copierPause_1.loadCachedUserCopierPaused)(this.supabase, this.userId))
            return;
        const dispatchedInProcess = this.onSignalParsed
            ? this.onSignalParsed(dispatchRow) === true
            : false;
        const shouldPush = workerConfig_1.workerConfig.runsListener && (!workerConfig_1.workerConfig.runsTrade || !dispatchedInProcess);
        if (shouldPush) {
            const pushed = await (0, tradeSignalPush_1.pushParsedSignalToTradeWorkerAwait)({
                ...dispatchRow,
                dispatch_source: signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE,
            }, { source: signalRevision_1.MESSAGE_REVISION_DISPATCH_SOURCE });
            if (!pushed)
                (0, workerMetrics_1.incMetric)('dispatch_push_exhausted');
        }
    }
    isModificationClassMessage(rawMessage, isReply, channelKeywords, lexicon) {
        const message = (0, normalizeTelegramMessageText_1.normalizeSignalMessageForParse)(rawMessage);
        return isReply || (0, signalManagementIntent_1.looksLikeChannelManagementUpdate)(message, channelKeywords, lexicon);
    }
    async parseSignalForListener(args) {
        const { keywords, lexicon } = await (0, channelKeywordsCache_1.getChannelParseContext)(this.supabase, args.channelRowId);
        if (this.isModificationClassMessage(args.rawMessage, args.isReply, keywords, lexicon)) {
            if (listenerInlineParseEnabled()) {
                const detMod = (0, parseSignal_1.parseModificationDeterministic)(args.rawMessage, keywords, lexicon);
                if (detMod.status === 'parsed' && detMod.parsed.action !== 'ignore') {
                    return { parseResult: detMod, channelKeywords: keywords };
                }
            }
            const aiResult = await (0, aiParseModification_1.aiParseModification)(this.supabase, {
                userId: this.userId,
                channelRowId: args.channelRowId,
                rawMessage: args.rawMessage,
                isReply: args.isReply,
                parentSignalId: args.parentSignalId,
            });
            return {
                parseResult: (0, aiParseModification_1.aiResultToParseResult)(aiResult),
                aiMeta: { intent: aiResult.intent, source: aiResult.source },
                channelKeywords: keywords,
            };
        }
        if (listenerInlineParseEnabled()) {
            const det = (0, parseSignal_1.parseChannelMessageSync)(args.rawMessage, keywords, lexicon);
            const detEntryParsed = det.status === 'parsed'
                && (det.parsed.action === 'buy' || det.parsed.action === 'sell');
            // A deterministically-parsed management action (breakeven / modify / close /
            // partial / close-worse) must never be overridden by the AI entry parser —
            // otherwise an instruction like "SL to Entry" gets re-guessed as a fresh
            // entry on a hallucinated symbol and skipped as entry_requires_now.
            const detManagementParsed = det.status === 'parsed' && (0, tradeSignalActions_1.isManagementAction)((0, tradeSignalActions_1.parsedAction)(det.parsed));
            if (detEntryParsed || detManagementParsed) {
                return { parseResult: det, channelKeywords: keywords };
            }
            if (!this.isModificationClassMessage(args.rawMessage, args.isReply, keywords, lexicon)) {
                const aiEntry = await (0, aiParseEntry_1.aiParseEntry)(this.supabase, {
                    userId: this.userId,
                    channelRowId: args.channelRowId,
                    rawMessage: args.rawMessage,
                    isReply: args.isReply,
                    parentSignalId: args.parentSignalId,
                });
                const aiMeta = { intent: 'entry', source: aiEntry.source };
                if (aiEntry.status === 'parsed') {
                    console.log(`[userListener] ai entry parsed user=${this.userId} channelRow=${args.channelRowId}`
                        + ` action=${aiEntry.parsed.action} symbol=${aiEntry.parsed.symbol ?? 'null'}`);
                    return {
                        parseResult: (0, aiParseEntry_1.aiEntryResultToParseResult)(aiEntry),
                        aiMeta,
                        channelKeywords: keywords,
                    };
                }
                if ((0, aiParseEntry_1.isAiEntryParseEnabled)()) {
                    console.warn(`[userListener] ai entry skipped user=${this.userId} channelRow=${args.channelRowId}:`
                        + ` ${aiEntry.skip_reason ?? 'unknown'}`);
                    return {
                        parseResult: {
                            ...det,
                            skip_reason: aiEntry.skip_reason ?? det.skip_reason,
                        },
                        aiMeta,
                        channelKeywords: keywords,
                    };
                }
            }
            return { parseResult: det, channelKeywords: keywords };
        }
        if (PARSE_SIGNAL_URL) {
            return {
                parseResult: await this.parseViaEdgeFunction(args.signalId, args.rawMessage, args.channelRowId),
                channelKeywords: keywords,
            };
        }
        return {
            parseResult: await (0, parseSignal_1.parseRawChannelMessage)(this.supabase, args.channelRowId, args.rawMessage),
            channelKeywords: keywords,
        };
    }
    /**
     * Resolve chat identity for an update without depending solely on
     * getChat(), which can fail transiently when gramjs entity cache is cold.
     */
    async resolveChatIdentity(event) {
        const message = event.message;
        const fallbackId = event.chatId != null ? String(event.chatId) : '';
        let chatId = fallbackId;
        let chatUsername = '';
        if ((!chatId || chatId === 'undefined') && message?.peerId) {
            try {
                chatId = telegram_1.utils.getPeerId(message.peerId, false).toString();
            }
            catch {
                // keep fallback
            }
        }
        try {
            const chat = await event.message?.getChat();
            if (chat) {
                const chatRaw = chat;
                if (chatRaw.id != null)
                    chatId = String(chatRaw.id);
                chatUsername = (chatRaw.username ?? '').toLowerCase();
            }
        }
        catch {
            // Fallback to event.chatId / peerId if entity lookup fails.
        }
        return {
            chatId,
            chatIdVariants: toChannelIdVariants(chatId),
            chatUsername,
        };
    }
    /**
     * Single insert path used by both live events (handleMessage) and
     * catch-up (catchUpChannel). Idempotent via the unique partial index
     * on signals(user_id, channel_id, telegram_message_id) — a row that already exists
     * is left untouched and parse-signal is not re-fired.
     */
    async waitForCatchUpParseSlot() {
        const max = catchUpParseConcurrency();
        while (this.catchUpParseActive >= max) {
            await new Promise(r => setTimeout(r, 50));
        }
        this.catchUpParseActive++;
    }
    releaseCatchUpParseSlot() {
        this.catchUpParseActive = Math.max(0, this.catchUpParseActive - 1);
    }
    async deferCatchUpWhileLiveBusy() {
        const pauseMs = livePriorityPauseMs();
        if (pauseMs <= 0)
            return;
        while (Date.now() - this.lastLiveMessageAt < pauseMs) {
            await new Promise(r => setTimeout(r, 200));
        }
    }
    async logSignal(channelRow, message, opts) {
        const isCatchUp = opts?.source === 'catchup';
        if (isCatchUp) {
            await this.deferCatchUpWhileLiveBusy();
            await this.waitForCatchUpParseSlot();
        }
        else {
            (0, workerMetrics_1.incMetric)('telegram_live_log_signal');
        }
        try {
            return await this.logSignalInner(channelRow, message, opts);
        }
        finally {
            if (isCatchUp)
                this.releaseCatchUpParseSlot();
        }
    }
    async logSignalInner(channelRow, message, opts) {
        if (await this.skipMessageWhileCopierPaused(channelRow, String(message.id)))
            return false;
        const signalChannelId = await (0, channelListenerIntegration_1.resolveSignalChannelIdForRow)(this.supabase, channelRow);
        if (signalChannelId) {
            channelRow.signal_channel_id = signalChannelId;
            if (await (0, channelListenerIntegration_1.shouldSkipPassiveChannelIngest)(this.supabase, this.userId, signalChannelId, this.passiveSignalChannelIds)) {
                (0, workerMetrics_1.incMetric)('channel_passive_ingest_skipped');
                return false;
            }
        }
        const messageId = String(message.id);
        const rawMessage = (0, signalTelegramReconcile_1.telegramMessageText)(message);
        const isReply = !!message.replyTo;
        const messageEpochSec = this.messageEpochSec(message);
        // Stamp listener arrival as early as possible so telegram_to_listener_ms
        // reflects only Telegram delivery time (not our dedup/parent lookup DB calls).
        const tListenerReceived = Date.now();
        if (opts?.source === 'catchup' && messageEpochSec > 0) {
            const ageMs = Date.now() - messageEpochSec * 1000;
            if (ageMs > catchUpMaxAgeMs()) {
                await this.bumpLastSeen(channelRow.id, messageId);
                console.log(`[userListener] catch-up skipped stale message user=${this.userId} channelRow=${channelRow.id}`
                    + ` messageId=${messageId} ageMin=${Math.round(ageMs / 60000)}`);
                return false;
            }
        }
        const replyToMessageId = extractReplyToMsgId(message.replyTo);
        let parentSignalId = null;
        if (replyToMessageId) {
            parentSignalId = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId);
        }
        const heuristicCtx = await (0, channelKeywordsCache_1.getChannelParseContext)(this.supabase, channelRow.id);
        if (!(0, signalTradingHeuristic_1.looksLikeTradingSignal)(rawMessage, isReply, heuristicCtx)) {
            console.log(`[userListener] skipped non-signal user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`);
            void this.persistNonSignalSkip({
                channelRow,
                rawMessage,
                messageId,
                parentSignalId,
                replyToMessageId,
                isReply,
            });
            return false;
        }
        const dedupKey = `${channelRow.id}:${messageId}`;
        const { count: dupCount } = await this.supabase
            .from('signals')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', this.userId)
            .eq('channel_id', channelRow.id)
            .eq('telegram_message_id', messageId);
        if ((dupCount ?? 0) > 0) {
            const revised = await this.tryApplyMessageRevision({
                channelRow,
                messageId,
                rawMessage,
                source: opts?.source === 'catchup' ? 'catchup' : 'duplicate_fallback',
                telegramEditDateSeen: (0, signalTelegramReconcile_1.telegramEditDateSec)(message),
            });
            if (revised)
                return true;
            console.log(`[userListener] duplicate message ignored user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`);
            return false;
        }
        const dedupAt = this.liveMessageDedup.get(dedupKey);
        if (dedupAt != null && Date.now() - dedupAt < 120000) {
            return false;
        }
        const signalId = (0, node_crypto_1.randomUUID)();
        const pipelineTs = {
            t_telegram_event: messageEpochSec > 0 ? messageEpochSec * 1000 : undefined,
            t_listener_received: tListenerReceived,
        };
        let parseResult;
        let aiMeta;
        let channelKeywords;
        try {
            const parsed = await this.parseSignalForListener({
                channelRowId: channelRow.id,
                rawMessage,
                signalId,
                isReply,
                parentSignalId,
            });
            parseResult = parsed.parseResult;
            aiMeta = parsed.aiMeta;
            channelKeywords = parsed.channelKeywords;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[userListener] parse failed user=${this.userId} signalId=${signalId}:`, errMsg);
            void this.persistSignalBackground({
                signalId,
                channelRow,
                rawMessage,
                messageId,
                parentSignalId,
                replyToMessageId,
                isReply,
                parseResult: {
                    parsed: {
                        action: 'ignore',
                        symbol: null,
                        entry_price: null,
                        entry_zone_low: null,
                        entry_zone_high: null,
                        sl: null,
                        tp: [],
                        lot_size: null,
                        confidence: 0,
                        raw_instruction: rawMessage,
                        open_tp: false,
                    },
                    status: 'error',
                    skip_reason: errMsg,
                },
            });
            return false;
        }
        pipelineTs.t_parse_done = Date.now();
        if (aiMeta)
            pipelineTs.t_ai_parse_done = pipelineTs.t_parse_done;
        if (aiMeta && parseResult.status === 'parsed') {
            const eventType = aiMeta.intent === 'entry' ? 'ai_entry_parsed' : 'ai_modification_parsed';
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType,
                channelRowId: channelRow.id,
                telegramMessageId: messageId,
                detail: {
                    signal_id: signalId,
                    intent: aiMeta.intent,
                    ai_source: aiMeta.source,
                },
            });
        }
        else if (aiMeta && parseResult.status !== 'parsed') {
            const eventType = aiMeta.intent === 'entry' ? 'ai_entry_skipped' : 'ai_modification_skipped';
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType,
                channelRowId: channelRow.id,
                telegramMessageId: messageId,
                detail: {
                    signal_id: signalId,
                    intent: aiMeta.intent,
                    skip_reason: parseResult.skip_reason,
                },
            });
        }
        const executionEligibility = (0, signalExecutionEligibility_1.evaluateParsedSignalExecutionEligibility)(parseResult.parsed, rawMessage, channelKeywords);
        const effectiveParseResult = (parseResult.status === 'parsed' && !executionEligibility.eligible)
            ? {
                ...parseResult,
                parsed: {
                    ...parseResult.parsed,
                    action: 'ignore',
                    confidence: 0,
                },
                status: 'skipped',
                skip_reason: executionEligibility.skipReason ?? parseResult.skip_reason,
            }
            : parseResult;
        if (effectiveParseResult.status !== 'parsed') {
            if (signalChannelId) {
                const channelResult = await (0, channelListenerIntegration_1.handlePostParseChannelIngest)({
                    supabase: this.supabase,
                    userId: this.userId,
                    channelRow,
                    signalChannelId,
                    messageId,
                    rawMessage,
                    replyToMessageId,
                    parseResult: {
                        parsed: effectiveParseResult.parsed,
                        status: effectiveParseResult.status,
                        skip_reason: effectiveParseResult.skip_reason,
                    },
                    pipelineTs: pipelineTs,
                });
                if (channelResult.skipPerUserIngest)
                    return true;
            }
            void this.persistSignalBackground({
                signalId,
                channelRow,
                rawMessage,
                messageId,
                parentSignalId,
                replyToMessageId,
                isReply,
                parseResult: effectiveParseResult,
            });
            return true;
        }
        if (signalChannelId) {
            const channelResult = await (0, channelListenerIntegration_1.handlePostParseChannelIngest)({
                supabase: this.supabase,
                userId: this.userId,
                channelRow,
                signalChannelId,
                messageId,
                rawMessage,
                replyToMessageId,
                parseResult: {
                    parsed: effectiveParseResult.parsed,
                    status: effectiveParseResult.status,
                    skip_reason: effectiveParseResult.skip_reason,
                },
                pipelineTs: pipelineTs,
                dispatch: this.onSignalParsed ?? undefined,
            });
            if (channelResult.skipPerUserIngest) {
                this.liveMessageDedup.set(dedupKey, Date.now());
                await this.bumpLastSeen(channelRow.id, messageId);
                return true;
            }
            if (channelResult.canonicalWritten && (0, channelListenerConfig_1.channelListenerShadowMode)()) {
                // shadow mode: fall through to per-user ingest below
            }
        }
        pipelineTs.t_dispatch_sent = Date.now();
        const dispatchRow = {
            id: signalId,
            user_id: this.userId,
            channel_id: channelRow.id,
            parsed_data: effectiveParseResult.parsed,
            status: effectiveParseResult.status,
            parent_signal_id: parentSignalId,
            is_modification: isReply,
            telegram_message_id: messageId,
            reply_to_message_id: replyToMessageId,
            created_at: new Date().toISOString(),
            pipeline_ts: pipelineTs,
        };
        console.log(`[userListener] dispatch signal user=${this.userId} signalId=${signalId} channelRow=${channelRow.id} messageId=${messageId}`);
        this.liveMessageDedup.set(dedupKey, Date.now());
        const dispatchedInProcess = this.onSignalParsed ? this.onSignalParsed(dispatchRow) === true : false;
        this.routeDispatchToTradeWorker(dispatchRow, dispatchedInProcess);
        if ((0, signalRevision_1.entryDispatchLooksSettleable)(effectiveParseResult.parsed)) {
            this.scheduleEntryMessageSettlePoll(channelRow, messageId);
        }
        void this.persistSignalBackground({
            signalId,
            channelRow,
            rawMessage,
            messageId,
            parentSignalId,
            replyToMessageId,
            isReply,
            parseResult: effectiveParseResult,
        });
        return true;
    }
    /** Fire-and-forget handoff to trade worker (in-process, queue, or HTTP push). */
    routeDispatchToTradeWorker(dispatchRow, dispatchedInProcess) {
        const shouldPush = workerConfig_1.workerConfig.runsListener && (!workerConfig_1.workerConfig.runsTrade || !dispatchedInProcess);
        if (!shouldPush)
            return;
        void (0, signalQueuePublisher_1.enqueueParsedSignal)(this.supabase, dispatchRow).then(async (queueResult) => {
            const queueCfg = (0, signalQueueConfig_1.signalQueueConfig)();
            const queueSucceeded = queueResult?.ok === true;
            const shouldHttpPush = !queueSucceeded
                && (queueCfg.pushFallbackOnQueueFail || !queueResult || queueResult.skipped);
            let httpPushOk = null;
            if (shouldHttpPush) {
                const action = (0, tradeSignalActions_1.parsedAction)(dispatchRow.parsed_data);
                if ((0, tradeSignalActions_1.isManagementAction)(action)) {
                    httpPushOk = await (0, tradeSignalPush_1.pushParsedSignalToTradeWorkerAccept)(dispatchRow);
                }
                else {
                    (0, tradeSignalPush_1.pushParsedSignalToTradeWorker)(dispatchRow);
                    httpPushOk = true;
                }
            }
            void this.supabase.from('trade_execution_logs').insert({
                user_id: this.userId,
                signal_id: dispatchRow.id,
                action: 'dispatch_route_decision',
                status: 'success',
                request_payload: {
                    dispatched_in_process: dispatchedInProcess,
                    should_push: shouldPush,
                    queue_enabled: queueCfg.enabled,
                    queue_enqueued: queueSucceeded,
                    queue_skipped_reason: queueResult?.skipped ? queueResult.reason : null,
                    queue_error: queueResult?.error ?? null,
                    http_push_fallback: shouldHttpPush,
                    http_push_ok: httpPushOk,
                    mgmt_push_accept_only: (0, tradeSignalActions_1.isManagementAction)((0, tradeSignalActions_1.parsedAction)(dispatchRow.parsed_data)),
                    runs_trade: workerConfig_1.workerConfig.runsTrade,
                    runs_listener: workerConfig_1.workerConfig.runsListener,
                    persist_before_dispatch: false,
                },
            });
        });
    }
    /** @deprecated Use persistSignalBackground after dispatch-first handoff. */
    async persistSignalSync(args) {
        const { signalId, channelRow, rawMessage, messageId, parentSignalId, replyToMessageId, isReply, parseResult, } = args;
        const { error: insertErr } = await this.supabase.from('signals').upsert({
            id: signalId,
            user_id: this.userId,
            channel_id: channelRow.id,
            raw_message: rawMessage,
            raw_image_url: null,
            status: parseResult.status,
            parsed_data: parseResult.parsed,
            skip_reason: parseResult.skip_reason,
            telegram_message_id: messageId,
            is_modification: isReply,
            parent_signal_id: parentSignalId,
            reply_to_message_id: replyToMessageId,
        }, { onConflict: 'user_id,channel_id,telegram_message_id', ignoreDuplicates: true });
        if (insertErr) {
            console.error(`[userListener] signal upsert failed signalId=${signalId}:`, insertErr.message);
            return false;
        }
        await this.bumpLastSeen(channelRow.id, messageId);
        let resolvedParent = parentSignalId;
        if (replyToMessageId && !resolvedParent) {
            resolvedParent = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId);
            if (resolvedParent) {
                await this.supabase
                    .from('signals')
                    .update({ parent_signal_id: resolvedParent })
                    .eq('id', signalId);
            }
        }
        await this.relinkReplyOrphansAfterParentInsert(channelRow.id, messageId, signalId);
        return true;
    }
    /** Edge parse fallback when LISTENER_INLINE_PARSE=false (UI preview path unchanged on edge). */
    async parseViaEdgeFunction(signalId, rawMessage, channelRowId) {
        if (!PARSE_SIGNAL_URL) {
            return (0, parseSignal_1.parseRawChannelMessage)(this.supabase, channelRowId, rawMessage);
        }
        const parseTimeoutMs = Math.max(2000, Math.min(15000, Number(process.env.PARSE_SIGNAL_TIMEOUT_MS ?? 6000)));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('parse-timeout'), parseTimeoutMs);
        try {
            await this.supabase.from('signals').upsert({
                id: signalId,
                user_id: this.userId,
                channel_id: channelRowId,
                raw_message: rawMessage,
                raw_image_url: null,
                status: 'pending',
            });
            const res = await fetch(PARSE_SIGNAL_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${PARSE_SIGNAL_AUTH_KEY}`,
                    apikey: PARSE_SIGNAL_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ signal_id: signalId }),
                signal: controller.signal,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(body.error ?? `parse-signal returned ${res.status}`);
            }
            return {
                parsed: (body.parsed ?? {}),
                status: String(body.status ?? 'parsed'),
                skip_reason: body.skip_reason ?? null,
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    persistNonSignalSkip(args) {
        const { channelRow, rawMessage, messageId, parentSignalId, replyToMessageId, isReply } = args;
        void (async () => {
            void rawMessage;
            void parentSignalId;
            void replyToMessageId;
            void isReply;
            // Non-trade chatter should not be persisted as skipped signal rows.
            await this.bumpLastSeen(channelRow.id, messageId);
        })().catch(err => {
            console.error('[userListener] persistNonSignalSkip failed:', err);
        });
    }
    persistSignalBackground(args) {
        const { signalId, channelRow, rawMessage, messageId, parentSignalId, replyToMessageId, isReply, parseResult, } = args;
        void (async () => {
            const rowPatch = {
                id: signalId,
                user_id: this.userId,
                channel_id: channelRow.id,
                raw_message: rawMessage,
                raw_image_url: null,
                status: parseResult.status,
                parsed_data: parseResult.parsed,
                skip_reason: parseResult.skip_reason,
                telegram_message_id: messageId,
                is_modification: isReply,
                parent_signal_id: parentSignalId,
                reply_to_message_id: replyToMessageId,
            };
            const { error: insertErr } = await this.supabase.from('signals').upsert(rowPatch, { onConflict: 'user_id,channel_id,telegram_message_id', ignoreDuplicates: true });
            if (insertErr) {
                console.error(`[userListener] signal upsert failed signalId=${signalId}:`, insertErr.message);
                return;
            }
            await this.bumpLastSeen(channelRow.id, messageId);
            let resolvedParent = parentSignalId;
            if (replyToMessageId && !resolvedParent) {
                resolvedParent = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId);
                if (resolvedParent) {
                    await this.supabase
                        .from('signals')
                        .update({ parent_signal_id: resolvedParent })
                        .eq('id', signalId);
                }
            }
            await this.relinkReplyOrphansAfterParentInsert(channelRow.id, messageId, signalId);
        })().catch(err => {
            console.error(`[userListener] persistSignalBackground failed signalId=${signalId}:`, err);
        });
    }
    /** Resolve `signals.id` of the parent message in this channel (telegram_channels row id). */
    async resolveParentSignalIdForReply(channelRowId, replyToMessageId) {
        const { data } = await this.supabase
            .from('signals')
            .select('id')
            .eq('user_id', this.userId)
            .eq('channel_id', channelRowId)
            .eq('telegram_message_id', replyToMessageId)
            .maybeSingle();
        return data?.id ?? null;
    }
    /** Link orphan replies that pointed at this Telegram message id before the parent row existed. */
    async relinkReplyOrphansAfterParentInsert(channelRowId, parentTelegramMessageId, parentSignalUuid) {
        await this.supabase
            .from('signals')
            .update({ parent_signal_id: parentSignalUuid })
            .eq('user_id', this.userId)
            .eq('channel_id', channelRowId)
            .eq('reply_to_message_id', parentTelegramMessageId)
            .is('parent_signal_id', null);
    }
    startReplyChainSweep() {
        if (this.replyChainSweepTimer)
            return;
        this.replyChainSweepTimer = setInterval(() => {
            this.runReplyChainSweep().catch(err => console.error(`[userListener] reply-chain sweep error for ${this.userId}:`, err));
        }, REPLY_CHAIN_SWEEP_MS);
        this.replyChainSweepTimer.unref?.();
    }
    startSignalReconcileSweep() {
        if (this.signalReconcileSweepTimer)
            return;
        this.signalReconcileSweepTimer = setInterval(() => {
            this.runSignalTelegramReconcile('reconcile_sweep').catch(err => console.error(`[userListener] signal reconcile sweep error for ${this.userId}:`, err));
        }, signalTelegramReconcile_1.RECONCILE_SWEEP_INTERVAL_MS);
        this.signalReconcileSweepTimer.unref?.();
        console.log(`[userListener] signal reconcile sweep started user=${this.userId}`
            + ` intervalMs=${signalTelegramReconcile_1.RECONCILE_SWEEP_INTERVAL_MS}`);
    }
    /**
     * Fetch live Telegram text for recent signals and reconcile mismatches with AI revision.
     */
    async runSignalTelegramReconcile(source, channelRow) {
        const stats = { checked: 0, mismatches: 0, revised: 0, errors: 0 };
        if (this.signalReconcileInFlight)
            return stats;
        this.signalReconcileInFlight = true;
        try {
            const windowMs = source === 'reconcile_poll_hook' ? signalTelegramReconcile_1.RECONCILE_POLL_HOOK_WINDOW_MS : undefined;
            const maxSignals = source === 'reconcile_poll_hook' ? signalTelegramReconcile_1.RECONCILE_POLL_HOOK_MAX_SIGNALS : undefined;
            const signals = await (0, signalTelegramReconcile_1.loadSignalsForReconcile)(this.supabase, {
                userId: this.userId,
                windowMs,
                maxSignals,
                channelRowId: channelRow?.id,
            });
            if (!signals.length)
                return stats;
            const grouped = (0, signalTelegramReconcile_1.groupSignalsByChannel)(signals);
            for (const [channelRowId, rows] of grouped) {
                const row = channelRow?.id === channelRowId
                    ? channelRow
                    : this.fastPollRows.find(r => r.id === channelRowId)
                        ?? (await this.supabase
                            .from('telegram_channels')
                            .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
                            .eq('id', channelRowId)
                            .maybeSingle()).data;
                if (!row)
                    continue;
                const channelStats = await this.runSignalReconcileForChannel(row, rows, source);
                stats.checked += channelStats.checked;
                stats.mismatches += channelStats.mismatches;
                stats.revised += channelStats.revised;
                stats.errors += channelStats.errors;
            }
            return stats;
        }
        finally {
            this.signalReconcileInFlight = false;
        }
    }
    async runSignalReconcileForChannel(channelRow, signals, source) {
        const stats = { checked: 0, mismatches: 0, revised: 0, errors: 0 };
        const signalChannelId = channelRow.signal_channel_id
            ?? await (0, channelListenerIntegration_1.resolveSignalChannelIdForRow)(this.supabase, channelRow);
        if ((0, channelListenerIntegration_1.isChannelRowPassive)(signalChannelId, this.passiveSignalChannelIds)) {
            (0, workerMetrics_1.incMetric)('channel_passive_reconcile_skipped');
            return stats;
        }
        let peer;
        try {
            peer = await this.resolveChannelPeer(channelRow);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stats.errors += 1;
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'signal_reconcile_sweep_error',
                channelRowId: channelRow.id,
                detail: { source, error: msg.slice(0, 300), phase: 'peer_resolve' },
            });
            return stats;
        }
        const snapshots = new Map();
        const ids = signals.map(s => s.telegram_message_id);
        for (const chunk of (0, signalTelegramReconcile_1.chunkTelegramMessageIds)(ids)) {
            const numericIds = chunk
                .map(id => Number(id))
                .filter(n => Number.isFinite(n) && n > 0);
            if (!numericIds.length)
                continue;
            try {
                const batch = (await this.client.getMessages(peer, {
                    ids: numericIds,
                }));
                for (const [id, snap] of (0, signalTelegramReconcile_1.snapshotsFromTelegramMessages)(batch ?? [])) {
                    snapshots.set(id, snap);
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                stats.errors += 1;
                (0, workerMetrics_1.incMetric)('signal_reconcile_get_messages_failed');
                void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                    userId: this.userId,
                    eventType: 'signal_reconcile_sweep_error',
                    channelRowId: channelRow.id,
                    detail: {
                        source,
                        error: msg.slice(0, 300),
                        phase: 'get_messages',
                        ids: chunk.slice(0, 10),
                    },
                });
            }
        }
        const checkedIds = [];
        const editDateBySignalId = new Map();
        for (const signal of signals) {
            const mid = signal.telegram_message_id?.trim();
            const snap = mid ? snapshots.get(mid) : undefined;
            if (!snap)
                continue;
            checkedIds.push(signal.id);
            editDateBySignalId.set(signal.id, snap.editDateSec);
        }
        stats.checked = checkedIds.length;
        const mismatches = (0, signalTelegramReconcile_1.findSignalsNeedingReconcile)(signals, snapshots);
        const mismatchIds = new Set(mismatches.map(m => m.signal.id));
        const reconciledIds = checkedIds.filter(id => !mismatchIds.has(id));
        if (reconciledIds.length) {
            await (0, signalTelegramReconcile_1.markSignalsReconciled)(this.supabase, {
                signalIds: reconciledIds,
                editDateBySignalId,
            });
        }
        if (!mismatches.length) {
            if (stats.checked > 0) {
                void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                    userId: this.userId,
                    eventType: 'signal_reconcile_checked',
                    channelRowId: channelRow.id,
                    detail: { source, checked: stats.checked, mismatches: 0 },
                });
            }
            return stats;
        }
        stats.mismatches = mismatches.length;
        for (const candidate of mismatches) {
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'signal_reconcile_mismatch',
                channelRowId: channelRow.id,
                telegramMessageId: candidate.signal.telegram_message_id,
                detail: {
                    source,
                    signal_id: candidate.signal.id,
                    edit_date_sec: candidate.editDateSec,
                },
            });
            try {
                const revised = await this.tryApplyMessageRevision({
                    channelRow,
                    messageId: candidate.signal.telegram_message_id,
                    rawMessage: candidate.rawMessage,
                    source: `reconcile_${source}`,
                    telegramEditDateSeen: candidate.editDateSec,
                });
                if (revised) {
                    stats.revised += 1;
                    await (0, signalTelegramReconcile_1.markSignalsReconciled)(this.supabase, {
                        signalIds: [candidate.signal.id],
                        editDateBySignalId,
                    });
                }
            }
            catch {
                stats.errors += 1;
            }
        }
        return stats;
    }
    /** Re-resolve `parent_signal_id` for recent replies (parent may have arrived later). */
    async runReplyChainSweep() {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: orphans, error } = await this.supabase
            .from('signals')
            .select('id, channel_id, reply_to_message_id')
            .eq('user_id', this.userId)
            .not('reply_to_message_id', 'is', null)
            .is('parent_signal_id', null)
            .gte('created_at', since)
            .limit(80);
        if (error || !orphans?.length)
            return;
        for (const row of orphans) {
            const rid = row.reply_to_message_id?.trim();
            if (!rid || !row.channel_id)
                continue;
            const parentId = await this.resolveParentSignalIdForReply(row.channel_id, rid);
            if (parentId) {
                await this.supabase
                    .from('signals')
                    .update({ parent_signal_id: parentId })
                    .eq('id', row.id);
            }
        }
    }
    async skipMessageWhileCopierPaused(channelRow, messageId) {
        if (!(await (0, copierPause_1.loadCachedUserCopierPaused)(this.supabase, this.userId)))
            return false;
        await this.bumpLastSeen(channelRow.id, messageId);
        return true;
    }
    subscribeCopierPauseState() {
        if (this.userProfilesCopierPauseChannel)
            return;
        this.userProfilesCopierPauseChannel = this.supabase
            .channel(`user_listener_copier_pause_${this.userId}`)
            .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'user_profiles',
            filter: `user_id=eq.${this.userId}`,
        }, (payload) => {
            const row = payload.new;
            if (!row)
                return;
            const copierPaused = row.copier_paused === true;
            const previousPaused = payload.old?.copier_paused === true;
            const transition = (0, copierPause_1.applyCopierPauseProfileUpdate)(this.userId, copierPaused, previousPaused);
            if (transition === 'resumed') {
                void this.advanceAllChannelsLastSeenToLatest();
            }
        })
            .subscribe();
    }
    async advanceChannelLastSeenToLatest(row, peer) {
        try {
            const resolvedPeer = peer ?? await this.resolveChannelPeer(row);
            const latest = await this.client.getMessages(resolvedPeer, { limit: 1 });
            const latestId = Number(latest[0]?.id);
            if (!Number.isFinite(latestId))
                return;
            await this.bumpLastSeen(row.id, String(latestId));
            row.last_seen_message_id = latestId;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[userListener] advance last_seen failed user=${this.userId} channel=${row.id}:`, msg);
        }
    }
    async advanceAllChannelsLastSeenToLatest() {
        const { data: rows } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username, last_seen_message_id')
            .eq('user_id', this.userId)
            .eq('is_active', true);
        for (const row of (rows ?? [])) {
            await this.advanceChannelLastSeenToLatest(row);
        }
    }
    async bumpLastSeen(channelRowId, messageId) {
        const num = Number(messageId);
        if (!Number.isFinite(num))
            return;
        // Only advance the high-water mark forwards.
        await this.supabase
            .from('telegram_channels')
            .update({
            last_seen_message_id: num,
            last_seen_at: new Date().toISOString(),
        })
            .eq('id', channelRowId)
            .or(`last_seen_message_id.is.null,last_seen_message_id.lt.${num}`);
    }
    async bumpLastLive(channelRowId) {
        this.lastLiveByRow.set(channelRowId, Date.now());
        await this.supabase
            .from('telegram_channels')
            .update({ last_live_at: new Date().toISOString() })
            .eq('id', channelRowId);
    }
    /** Resolve + join every monitored channel so live NewMessage fires for all of them. */
    async warmAllMonitoredChannelEntities() {
        const { data: rows } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username')
            .eq('user_id', this.userId)
            .eq('is_active', true);
        for (const row of (rows ?? [])) {
            await this.ensureJoinedPublicChannel(row).catch(() => { });
            await this.warmChannelEntity(row).catch(() => { });
        }
    }
    /**
     * Join public channels by @username so getMessages and live updates work for
     * external signal providers the user has not opened in Telegram yet.
     */
    async ensureJoinedPublicChannel(row) {
        const username = normalizeChannelUsername(row.channel_username);
        if (!username)
            return;
        try {
            const entity = await this.client.getInputEntity(username);
            await (0, telegramClient_1.tgInvoke)(this.client, new tl_1.Api.channels.JoinChannel({ channel: entity }));
            (0, workerMetrics_1.incMetric)('channel_join_ok');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('USER_ALREADY_PARTICIPANT')
                || msg.includes('CHANNELS_TOO_MUCH')
                || msg.includes('INVITE_HASH_EMPTY')) {
                return;
            }
            console.warn(`[userListener] ensureJoinedPublicChannel @${username} channel=${row.id}:`, msg.slice(0, 200));
        }
    }
    // ── catch-up after connect/reconnect ──────────────────────────────────
    /** Non-blocking so live NewMessage handling is not delayed behind history replay. */
    scheduleCatchUpOnStart() {
        if (!catchUpOnStartEnabled()) {
            console.log(`[userListener] catch-up on start disabled user=${this.userId}`);
            return;
        }
        console.log(`[userListener] catch-up scheduled (background) user=${this.userId} maxAgeMin=${Math.round(catchUpMaxAgeMs() / 60000)}`);
        void this.runCatchUp().catch(err => console.error(`[userListener] catch-up failed for ${this.userId}:`, err));
    }
    async runCatchUp() {
        if (this.catchUpInFlight)
            return;
        this.catchUpInFlight = true;
        try {
            const { data: rows } = await this.supabase
                .from('telegram_channels')
                .select('id, channel_id, channel_username, last_seen_message_id')
                .eq('user_id', this.userId)
                .eq('is_active', true);
            for (const row of (rows ?? [])) {
                await this.catchUpChannel(row).catch(err => console.error(`[userListener] catchUp failed for channel ${row.id}:`, err));
            }
        }
        finally {
            this.catchUpInFlight = false;
        }
    }
    async runRecentCatchUp() {
        if (this.catchUpInFlight)
            return;
        this.catchUpInFlight = true;
        try {
            const { data: rows } = await this.supabase
                .from('telegram_channels')
                .select('id, channel_id, channel_username, last_seen_message_id')
                .eq('user_id', this.userId)
                .eq('is_active', true);
            for (const row of (rows ?? [])) {
                await this.catchUpChannelRecent(row).catch(err => console.error(`[userListener] recent catchUp failed for channel ${row.id}:`, err));
            }
        }
        finally {
            this.catchUpInFlight = false;
        }
    }
    async pollMonitoredChannelsForMessages() {
        if (!this.isConnected)
            return;
        const { data: rows } = await this.supabase
            .from('telegram_channels')
            .select('id, channel_id, channel_username, signal_channel_id, last_seen_message_id, last_seen_at, last_live_at')
            .eq('user_id', this.userId)
            .eq('is_active', true);
        for (const row of (rows ?? [])) {
            await this.pollChannelNewMessages(row).catch(err => console.warn(`[userListener] poll failed channel=${row.id}:`, err));
        }
    }
    /**
     * Poll Telegram history for channels where live NewMessage updates are missing
     * (common when the linked account broadcasts to its own channel).
     */
    async pollChannelNewMessages(row) {
        const signalChannelId = row.signal_channel_id
            ?? await (0, channelListenerIntegration_1.resolveSignalChannelIdForRow)(this.supabase, row);
        if ((0, channelListenerIntegration_1.isChannelRowPassive)(signalChannelId, this.passiveSignalChannelIds)) {
            (0, workerMetrics_1.incMetric)('channel_passive_poll_skipped');
            return;
        }
        let peer;
        try {
            peer = await this.resolveChannelPeer(row);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[userListener] poll peer resolve failed user=${this.userId} channel=${row.id}:`, msg);
            (0, workerMetrics_1.incMetric)('poll_peer_resolve_failed');
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'poll_peer_resolve_failed',
                channelRowId: row.id,
                detail: { error: msg.slice(0, 300) },
            });
            return;
        }
        let minId = Number(row.last_seen_message_id ?? 0);
        if (!Number.isFinite(minId) || minId < 0)
            minId = 0;
        let batch;
        try {
            batch = (await this.client.getMessages(peer, {
                limit: minId === 0 ? 20 : 30,
                ...(minId > 0 ? { minId } : {}),
            }));
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[userListener] poll getMessages failed user=${this.userId} channel=${row.id}:`, msg);
            (0, workerMetrics_1.incMetric)('poll_get_messages_failed');
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'poll_error',
                channelRowId: row.id,
                detail: { error: msg.slice(0, 300), min_id: minId },
            });
            return;
        }
        this.lastSuccessfulPollAt = Date.now();
        if (!batch.length) {
            await this.runSignalTelegramReconcile('reconcile_poll_hook', row);
            return;
        }
        const sorted = [...batch].sort((a, b) => Number(a.id) - Number(b.id));
        const latestId = Number(sorted[sorted.length - 1]?.id);
        if (!Number.isFinite(latestId))
            return;
        if (await (0, copierPause_1.loadCachedUserCopierPaused)(this.supabase, this.userId)) {
            await this.bumpLastSeen(row.id, String(latestId));
            row.last_seen_message_id = latestId;
            return;
        }
        if (minId === 0) {
            const now = Date.now();
            const recentWindowMs = 15 * 60000;
            for (const m of sorted) {
                const mid = Number(m.id);
                if (!Number.isFinite(mid))
                    continue;
                const epoch = this.messageEpochSec(m);
                if (epoch > 0 && now - epoch * 1000 <= recentWindowMs) {
                    await this.logSignal(row, m, { source: 'catchup' });
                }
            }
            await this.bumpLastSeen(row.id, String(latestId));
            row.last_seen_message_id = latestId;
            console.log(`[userListener] poll seeded channel=${row.id} username=${row.channel_username || '-'} lastMsg=${latestId}`);
            return;
        }
        const toProcess = sorted.filter(m => Number(m.id) > minId);
        if (!toProcess.length) {
            await this.runSignalTelegramReconcile('reconcile_poll_hook', row);
            return;
        }
        for (const m of toProcess) {
            await this.logSignal(row, m, { source: 'catchup' });
        }
        // Advance the caller's row in place so cached rows (fast poll) don't
        // refetch the same batch on the next tick while the DB bump lags.
        row.last_seen_message_id = latestId;
        await this.runSignalTelegramReconcile('reconcile_poll_hook', row);
    }
    async catchUpChannelRecent(row) {
        let peer;
        try {
            peer = await this.resolveChannelPeer(row);
        }
        catch {
            return;
        }
        const minIdRaw = row.last_seen_message_id;
        const minId = minIdRaw == null ? 0 : Number(minIdRaw);
        if (!Number.isFinite(minId) || minId <= 0)
            return;
        let batch;
        try {
            batch = (await this.client.getMessages(peer, {
                limit: 20,
                minId,
            }));
        }
        catch {
            return;
        }
        if (!batch.length)
            return;
        if (await (0, copierPause_1.loadCachedUserCopierPaused)(this.supabase, this.userId)) {
            const sorted = [...batch].sort((a, b) => Number(a.id) - Number(b.id));
            const latestId = Number(sorted[sorted.length - 1]?.id);
            if (Number.isFinite(latestId) && latestId > minId) {
                await this.bumpLastSeen(row.id, String(latestId));
                row.last_seen_message_id = latestId;
            }
            return;
        }
        const now = Date.now();
        const maxAgeMs = 60000;
        const recent = batch
            .filter(m => {
            const mid = Number(m.id);
            if (!Number.isFinite(mid) || mid <= minId)
                return false;
            const epoch = this.messageEpochSec(m);
            return epoch > 0 && (now - epoch * 1000) <= maxAgeMs;
        })
            .sort((a, b) => Number(a.id) - Number(b.id));
        for (const m of recent) {
            await this.logSignal(row, m, { source: 'catchup' });
        }
    }
    async warmChannelEntity(row) {
        try {
            await this.resolveChannelPeer(row);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[userListener] warmChannelEntity failed channel=${row.id}:`, msg);
            void (0, listenerEvents_1.persistListenerEvent)(this.supabase, {
                userId: this.userId,
                eventType: 'peer_resolve_failed',
                channelRowId: row.id,
                detail: { error: msg.slice(0, 300) },
            });
        }
    }
    async resolveChannelPeer(row) {
        const key = row.channel_username?.replace(/^@/, '') || row.channel_id;
        try {
            return await this.client.getInputEntity(key);
        }
        catch {
            // Entity cache miss — warm from dialogs (common right after connect).
        }
        const wantUser = (row.channel_username ?? '').replace(/^@/, '').toLowerCase();
        const idVariants = new Set(toChannelIdVariants(row.channel_id));
        try {
            const dialogs = await this.fetchAllDialogs();
            for (const d of dialogs) {
                if (!d.isChannel && !d.isGroup)
                    continue;
                const entity = d.entity;
                if (!entity)
                    continue;
                const id = String(d.id ?? '');
                const username = String(entity.username ?? '').toLowerCase();
                const matches = (wantUser && username === wantUser)
                    || idVariants.has(id)
                    || [...idVariants].some(v => id === v || id.endsWith(v));
                if (matches) {
                    return await this.client.getInputEntity(entity);
                }
            }
            return await this.client.getInputEntity(key);
        }
        catch (err) {
            (0, telegramClient_1.rethrowIfSessionInvalid)(err);
            throw new Error('Failed to resolve Telegram channel entity');
        }
    }
    async catchUpChannel(row) {
        let peer;
        try {
            peer = await this.resolveChannelPeer(row);
        }
        catch (err) {
            console.warn(`[userListener] resolveChannelPeer miss for channel ${row.id}; skipping catch-up this round`, err);
            return;
        }
        if (await (0, copierPause_1.loadCachedUserCopierPaused)(this.supabase, this.userId)) {
            await this.advanceChannelLastSeenToLatest(row, peer);
            return;
        }
        const minIdRaw = row.last_seen_message_id;
        const minId = minIdRaw == null ? 0 : Number(minIdRaw);
        if (!Number.isFinite(minId) || minId < 0) {
            console.warn(`[userListener] invalid last_seen for channel ${row.id}; skipping catch-up`);
            return;
        }
        if (minId === 0) {
            // Seed-only on first-ever listen — do not backfill historical messages.
            // Without this, a user picking a 5-year-old signal channel would
            // import its entire history.
            try {
                const latest = await this.client.getMessages(peer, { limit: 1 });
                if (latest[0])
                    await this.bumpLastSeen(row.id, String(latest[0].id));
            }
            catch (err) {
                console.warn(`[userListener] seed last_seen failed for channel ${row.id}:`, err);
            }
            return;
        }
        const collected = [];
        let offsetId = 0;
        const batchSize = 50;
        while (collected.length < CATCHUP_PER_CHANNEL_CAP) {
            let batch;
            try {
                batch = (await this.client.getMessages(peer, {
                    limit: batchSize,
                    offsetId,
                    minId,
                }));
            }
            catch (err) {
                console.error(`[userListener] getMessages failed for channel ${row.id}:`, err);
                break;
            }
            if (!batch.length)
                break;
            for (const m of batch)
                collected.push(m);
            offsetId = Number(batch[batch.length - 1].id);
            if (batch.length < batchSize)
                break;
            await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS));
        }
        // gramjs returns newest-first; insert oldest-first so last_seen
        // monotonically advances and parse-signal sees signals in order.
        collected.sort((a, b) => Number(a.id) - Number(b.id));
        const toProcess = collected.filter(m => {
            const mid = Number(m.id);
            return Number.isFinite(mid) && mid > minId;
        });
        (0, workerMetrics_1.incMetric)('catchup_messages_queued', toProcess.length);
        await this.mapWithConcurrency(toProcess, catchUpParseConcurrency(), async (m) => {
            await this.logSignal(row, m, { source: 'catchup' });
        });
        console.log(`[userListener] catch-up channel done user=${this.userId} channelRow=${row.id} processed=${toProcess.length}`);
    }
    messageEpochSec(m) {
        const dateRaw = m.date;
        if (typeof dateRaw === 'number')
            return dateRaw;
        if (dateRaw instanceof Date)
            return Math.floor(dateRaw.getTime() / 1000);
        if (typeof dateRaw === 'string') {
            const t = Date.parse(dateRaw);
            return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
        }
        return 0;
    }
    /** All non-empty messages in range (no trading heuristic) — used for backtest import only. */
    async fetchMessagesBetweenForBacktest(row, fromMs, toMs) {
        return this.fetchMessagesBetween(row, fromMs, toMs, { forBacktest: true });
    }
    async fetchMessagesBetween(row, fromMs, toMs, opts) {
        const fromSec = Math.floor(fromMs / 1000);
        const toSec = Math.floor(toMs / 1000);
        let peer;
        try {
            peer = await this.resolveChannelPeer(row);
        }
        catch {
            throw new Error('Failed to resolve Telegram channel entity');
        }
        const collected = [];
        let offsetId = 0;
        const batchSize = 100;
        const heuristicCtx = await (0, channelKeywordsCache_1.getChannelParseContext)(this.supabase, row.id);
        while (collected.length < BACKFILL_PER_CHANNEL_CAP) {
            let batch;
            try {
                batch = (await this.client.getMessages(peer, {
                    limit: batchSize,
                    offsetId,
                }));
            }
            catch {
                break;
            }
            if (!batch.length)
                break;
            let reachedOlderThanRange = false;
            for (const m of batch) {
                const msgEpochSec = this.messageEpochSec(m);
                if (msgEpochSec && msgEpochSec < fromSec) {
                    reachedOlderThanRange = true;
                    continue;
                }
                if (msgEpochSec && msgEpochSec > toSec) {
                    continue;
                }
                const raw = (0, signalTelegramReconcile_1.telegramMessageText)(m);
                if (!raw)
                    continue;
                const isReply = !!m.replyTo;
                const fetchAllForBacktest = process.env.BACKTEST_FETCH_ALL_MESSAGES === 'true';
                if (!opts?.forBacktest) {
                    if (!(0, signalTradingHeuristic_1.looksLikeTradingSignal)(raw, isReply, heuristicCtx))
                        continue;
                }
                else if (!fetchAllForBacktest) {
                    if (!(0, signalTradingHeuristic_1.looksLikeTradingSignal)(raw, isReply, heuristicCtx))
                        continue;
                }
                collected.push(m);
            }
            offsetId = Number(batch[batch.length - 1].id);
            if (batch.length < batchSize || reachedOlderThanRange)
                break;
            await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS));
        }
        collected.sort((a, b) => Number(a.id) - Number(b.id));
        return collected;
    }
    async backfillChannelFromDate(row, days, opts) {
        let peer;
        try {
            peer = await this.resolveChannelPeer(row);
        }
        catch {
            throw new Error('Failed to resolve Telegram channel entity');
        }
        const sinceEpochSec = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
        const collected = [];
        let offsetId = 0;
        const batchSize = 100;
        const heuristicCtx = opts?.forTraining
            ? null
            : await (0, channelKeywordsCache_1.getChannelParseContext)(this.supabase, row.id);
        while (collected.length < BACKFILL_PER_CHANNEL_CAP) {
            let batch;
            try {
                batch = (await this.client.getMessages(peer, {
                    limit: batchSize,
                    offsetId,
                }));
            }
            catch {
                break;
            }
            if (!batch.length)
                break;
            for (const m of batch) {
                const dateRaw = m.date;
                const msgEpochSec = (() => {
                    if (typeof dateRaw === 'number')
                        return dateRaw;
                    if (dateRaw instanceof Date)
                        return Math.floor(dateRaw.getTime() / 1000);
                    if (typeof dateRaw === 'string') {
                        const t = Date.parse(dateRaw);
                        return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
                    }
                    return 0;
                })();
                if (msgEpochSec && msgEpochSec < sinceEpochSec) {
                    // We've reached older-than-lookback history.
                    offsetId = Number(batch[batch.length - 1].id);
                    break;
                }
                collected.push(m);
            }
            offsetId = Number(batch[batch.length - 1].id);
            if (batch.length < batchSize)
                break;
            const oldest = batch[batch.length - 1];
            const oldestEpochSec = (() => {
                const dateRaw = oldest?.date;
                if (typeof dateRaw === 'number')
                    return dateRaw;
                if (dateRaw instanceof Date)
                    return Math.floor(dateRaw.getTime() / 1000);
                if (typeof dateRaw === 'string') {
                    const t = Date.parse(dateRaw);
                    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
                }
                return 0;
            })();
            if (oldestEpochSec && oldestEpochSec < sinceEpochSec)
                break;
            await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS));
        }
        collected.sort((a, b) => Number(a.id) - Number(b.id));
        const out = [];
        for (const m of collected) {
            const raw = (0, signalTelegramReconcile_1.telegramMessageText)(m);
            if (!raw)
                continue;
            const isReply = !!m.replyTo;
            const passes = opts?.forTraining
                ? (0, signalTradingHeuristic_1.looksLikeTrainingCandidate)(raw)
                : (0, signalTradingHeuristic_1.looksLikeTradingSignal)(raw, isReply, heuristicCtx);
            if (!passes)
                continue;
            out.push(raw);
            if (out.length >= 300)
                break;
        }
        return out;
    }
    // ── watchdog ──────────────────────────────────────────────────────────
    startWatchdog() {
        if (this.watchdogTimer)
            return;
        this.watchdogTimer = setInterval(() => {
            this.runWatchdog().catch(err => console.error(`[userListener] watchdog tick error for ${this.userId}:`, err));
        }, WATCHDOG_INTERVAL_MS);
        this.watchdogTimer.unref?.();
    }
    /**
     * Probe MTProto with a cheap authenticated call. With library autoReconnect
     * disabled (see `buildClient`), TCP drops and zombie sockets are handled here:
     * the probe forces a round-trip; consecutive failures trigger an explicit
     * disconnect + cooldown + reconnect in `forceReconnect`.
     */
    async runWatchdog() {
        try {
            await (0, telegramClient_1.tgInvoke)(this.client, new tl_1.Api.updates.GetState());
            this.consecutiveProbeFailures = 0;
            this.lastEventAt = this.lastEventAt || Date.now();
        }
        catch (err) {
            this.consecutiveProbeFailures++;
            console.warn(`[watchdog] probe failed (${this.consecutiveProbeFailures}/${WATCHDOG_FAILURE_THRESHOLD}) for ${this.userId}:`, err instanceof Error ? err.message : String(err));
            if (this.consecutiveProbeFailures >= WATCHDOG_FAILURE_THRESHOLD) {
                await this.forceReconnect();
            }
        }
    }
    async forceReconnect() {
        console.log(`[userListener] force reconnect for ${this.userId}`);
        this.clearDialogsCache();
        this.lastReconnectAt = Date.now();
        this.consecutiveProbeFailures = 0;
        this.isConnected = false;
        const cooldown = reconnectCooldownMs();
        try {
            await this.client.disconnect();
        }
        catch { /* ignore */ }
        await new Promise(r => setTimeout(r, cooldown));
        try {
            await this.client.connect();
            this.isConnected = true;
        }
        catch (err) {
            console.error(`[userListener] reconnect failed for ${this.userId}:`, err);
            if (!(0, telegramClient_1.isAuthKeyDuplicated)(err))
                return;
            (0, workerMetrics_1.incMetric)('auth_key_duplicated');
            console.warn(`[userListener] AUTH_KEY_DUPLICATED for ${this.userId} — waiting 15s then one retry`
                + ' (overlapping worker instance or session still closing on Telegram)');
            try {
                await this.client.disconnect();
            }
            catch { /* ignore */ }
            await new Promise(r => setTimeout(r, 15000));
            try {
                await this.client.connect();
                this.isConnected = true;
            }
            catch (err2) {
                console.error(`[userListener] reconnect retry failed for ${this.userId}:`, err2);
                return;
            }
        }
        // Rebind handler — the previous one was attached to the disconnected
        // session and may not survive the reconnect cleanly.
        this.removeCurrentHandler();
        this.monitoredChannels.clear();
        // Warm entity cache BEFORE registering the handler so gramjs can
        // deliver NewMessage events for all monitored channels.
        await this.warmEntityCache();
        await this.refreshChannelSubscription();
        // Run a lightweight catch-up for very recent messages (last 60s) that
        // may have arrived during the reconnect window. Full history replay is
        // NOT done here to avoid stale trade execution.
        void this.runRecentCatchUp().catch(err => console.error(`[userListener] recent catch-up after reconnect failed for ${this.userId}:`, err));
        await this.runReplyChainSweep();
    }
    // ── safety poll (Realtime drop fallback) ──────────────────────────────
    startSafetyPoll() {
        if (this.safetyPollTimer)
            return;
        this.safetyPollTimer = setInterval(() => {
            this.refreshChannelSubscription().catch(err => console.error(`[userListener] safety poll error for ${this.userId}:`, err));
            this.warmAllMonitoredChannelEntities().catch(err => console.error(`[userListener] entity warm (poll tick) error for ${this.userId}:`, err));
            this.pollMonitoredChannelsForMessages().catch(err => console.error(`[userListener] channel poll error for ${this.userId}:`, err));
        }, SAFETY_POLL_INTERVAL_MS);
        this.safetyPollTimer.unref?.();
    }
    // ── fast poll (channels with no live push from Telegram) ──────────────
    startFastPoll() {
        if (this.fastPollTimer)
            return;
        this.fastPollTimer = setInterval(() => {
            this.runFastPoll().catch(err => console.error(`[userListener] fast poll error for ${this.userId}:`, err));
        }, FAST_POLL_INTERVAL_MS);
        this.fastPollTimer.unref?.();
        console.log(`[userListener] fast poll started user=${this.userId}`
            + ` intervalMs=${FAST_POLL_INTERVAL_MS} liveStaleMs=${FAST_POLL_LIVE_STALE_MS}`);
    }
    /**
     * Poll only the channels Telegram is not delivering live NewMessage updates
     * for (last_live_at null or stale). Channels with healthy live push are left
     * to the event handler + 30s safety poll. The channel list is cached and
     * refreshed every SAFETY_POLL_INTERVAL_MS to keep DB load flat.
     */
    async runFastPoll() {
        if (!this.isConnected || this.fastPollInFlight)
            return;
        this.fastPollInFlight = true;
        try {
            const now = Date.now();
            if (now - this.fastPollRowsAt > SAFETY_POLL_INTERVAL_MS) {
                const { data } = await this.supabase
                    .from('telegram_channels')
                    .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
                    .eq('user_id', this.userId)
                    .eq('is_active', true);
                this.fastPollRows = (data ?? []);
                this.fastPollRowsAt = now;
            }
            for (const row of this.fastPollRows) {
                const liveDb = row.last_live_at ? new Date(row.last_live_at).getTime() : 0;
                const liveMem = this.lastLiveByRow.get(row.id) ?? 0;
                const lastLive = Math.max(liveDb, liveMem);
                if (lastLive > 0 && now - lastLive < FAST_POLL_LIVE_STALE_MS)
                    continue;
                await this.pollChannelNewMessages(row).catch(err => console.warn(`[userListener] fast poll failed channel=${row.id}:`, err));
            }
        }
        finally {
            this.fastPollInFlight = false;
        }
    }
    // ── entity cache warmup ────────────────────────────────────────────────
    startEntityWarmup() {
        if (this.entityWarmupTimer)
            return;
        this.entityWarmupTimer = setInterval(() => {
            this.warmEntityCache().catch(err => console.error(`[userListener] entity warmup error for ${this.userId}:`, err));
        }, ENTITY_WARMUP_INTERVAL_MS);
        this.entityWarmupTimer.unref?.();
    }
    async warmEntityCache() {
        if (!this.isConnected)
            return;
        try {
            const dialogs = await this.client.getDialogs({ limit: DIALOG_MAX_SCAN });
            const channelCount = dialogs.filter((d) => d.isChannel || d.isGroup).length;
            console.log(`[userListener] entity cache warmed user=${this.userId} dialogs=${dialogs.length} channels=${channelCount}`);
            (0, workerMetrics_1.incMetric)('entity_cache_warmed');
            await this.warmAllMonitoredChannelEntities();
        }
        catch (err) {
            if ((0, telegramClient_1.isAuthKeyDuplicated)(err))
                return;
            if ((0, telegramClient_1.isAuthKeyUnregistered)(err))
                (0, telegramClient_1.rethrowIfSessionInvalid)(err);
            console.warn(`[userListener] entity warmup getDialogs failed for ${this.userId}:`, err instanceof Error ? err.message : String(err));
        }
    }
    // ── session string rotation ───────────────────────────────────────────
    startSessionPersist() {
        if (this.sessionPersistTimer)
            return;
        this.sessionPersistTimer = setInterval(() => {
            this.persistSessionIfChanged().catch(err => console.error(`[userListener] session persist error for ${this.userId}:`, err));
        }, SESSION_PERSIST_INTERVAL_MS);
        this.sessionPersistTimer.unref?.();
    }
    /**
     * gramjs occasionally rotates auth_key state inside the session. If we
     * crash without persisting the new state, the next start re-handshakes
     * from a stale snapshot which can look suspicious to Telegram. Persist
     * on a 30-min cadence and on graceful shutdown.
     */
    async persistSessionIfChanged() {
        let current;
        try {
            current = this.client.session.save();
        }
        catch {
            return;
        }
        if (!current || current === this.lastSavedSession)
            return;
        const { error } = await this.supabase
            .from('telegram_sessions')
            .update({ session_string: current })
            .eq('user_id', this.userId);
        if (error) {
            console.error(`[userListener] session_string update failed for ${this.userId}:`, error.message);
            return;
        }
        this.lastSavedSession = current;
    }
}
exports.UserListener = UserListener;
