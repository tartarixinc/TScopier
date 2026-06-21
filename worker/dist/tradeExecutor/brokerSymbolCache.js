"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectPrewarmSymbolsForBroker = collectPrewarmSymbolsForBroker;
exports.prewarmSymbolsEnabled = prewarmSymbolsEnabled;
exports.prewarmBrokerCaches = prewarmBrokerCaches;
exports.sessionHeartbeatTick = sessionHeartbeatTick;
exports.reconnectCachedBrokers = reconnectCachedBrokers;
exports.pingBrokerSession = pingBrokerSession;
exports.symbolCacheKeepaliveTick = symbolCacheKeepaliveTick;
exports.markBrokerSessionDown = markBrokerSessionDown;
exports.ensureBrokerSession = ensureBrokerSession;
exports.ensureBrokerSessionLiveFast = ensureBrokerSessionLiveFast;
exports.brokersWarmForLiveEntry = brokersWarmForLiveEntry;
exports.prewarmForDispatch = prewarmForDispatch;
exports.prewarmBrokersForLiveEntry = prewarmBrokersForLiveEntry;
exports.getSymbolParams = getSymbolParams;
exports.refreshSymbolParams = refreshSymbolParams;
exports.getSymbolList = getSymbolList;
exports.fetchSymbolList = fetchSymbolList;
exports.resolveBrokerSymbolFromInventory = resolveBrokerSymbolFromInventory;
exports.resolveBrokerSymbolForLiveEntry = resolveBrokerSymbolForLiveEntry;
exports.resolveBrokerSymbol = resolveBrokerSymbol;
const fxsocketClient_1 = require("../fxsocketClient");
const brokerConnectionStatus_1 = require("../brokerConnectionStatus");
const brokerSignalReplay_1 = require("../brokerSignalReplay");
const helpers_1 = require("./helpers");
const types_1 = require("./types");
const HEARTBEAT_FAILURES_BEFORE_DOWN = Math.max(2, Number(process.env.BROKER_HEARTBEAT_FAILURES_BEFORE_DOWN ?? 4) || 4);
const HEARTBEAT_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BROKER_HEARTBEAT_CONCURRENCY ?? 2) || 2));
const HEARTBEAT_BATCH_GAP_MS = Math.max(0, Math.min(2000, Number(process.env.BROKER_HEARTBEAT_BATCH_GAP_MS ?? 250) || 250));
const SYMBOL_KEEPALIVE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SYMBOL_KEEPALIVE_CONCURRENCY ?? 2) || 2));
const heartbeatFailCounts = new Map();
function activeBrokersForHeartbeat(ctx) {
    return [...ctx.brokersById.values()].filter(b => b.is_active && (0, helpers_1.brokerSessionUuid)(b));
}
function collectPrewarmSymbolsForBroker(broker) {
    const manual = (broker.manual_settings ?? {});
    const symbols = (0, helpers_1.parseSymbolToTradeList)(manual.symbol_to_trade);
    const base = symbols.length > 0 ? symbols : ['XAUUSD', 'EURUSD'];
    const out = new Set();
    for (const sym of base) {
        out.add(sym);
        out.add((0, helpers_1.applySymbolMapping)(sym, broker).symbol);
    }
    return [...out];
}
function prewarmBrokerSymbolCaches(ctx, broker) {
    const uuid = (0, helpers_1.brokerSessionUuid)(broker);
    if (!uuid)
        return;
    void ctx.getSymbolList(uuid).catch(() => null);
    for (const sym of collectPrewarmSymbolsForBroker(broker)) {
        void ctx.getSymbolParams(uuid, sym).catch(() => null);
    }
}
async function pingBrokerSessionInner(ctx, broker, api, uuid, opts) {
    const now = Date.now();
    const last = ctx.sessionPingAt.get(uuid) ?? 0;
    if (!opts?.force && now - last < types_1.SESSION_PING_MIN_INTERVAL_MS)
        return true;
    if (ctx.sessionCheckInflight.has(uuid))
        return false;
    const wasBlocked = ctx.sessionOrderBlocked.has(broker.id);
    try {
        const alive = await api.keepSessionAlive(uuid);
        if (alive) {
            heartbeatFailCounts.delete(uuid);
            ctx.sessionPingAt.set(uuid, Date.now());
            if (wasBlocked) {
                ctx.sessionOrderBlocked.delete(broker.id);
                void (0, brokerSignalReplay_1.replayParsedSignalsForBroker)(ctx, broker);
            }
            return true;
        }
    }
    catch (err) {
        if ((0, fxsocketClient_1.isApiThrottleError)(err)) {
            const backoff = (0, fxsocketClient_1.parseApiThrottleBackoffMs)(err);
            ctx.sessionPingAt.set(uuid, Date.now());
            console.warn(`[tradeExecutor] keepSessionAlive throttled broker=${broker.id} uuid=${uuid}; backoff ${backoff}ms`);
            return true;
        }
        /* fall through to failure count */
    }
    const fails = (heartbeatFailCounts.get(uuid) ?? 0) + 1;
    heartbeatFailCounts.set(uuid, fails);
    if (fails >= HEARTBEAT_FAILURES_BEFORE_DOWN) {
        heartbeatFailCounts.delete(uuid);
        await ctx.markBrokerSessionDown(broker, uuid, 'heartbeat keepSessionAlive failed');
    }
    return false;
}
function prewarmSymbolsEnabled(ctx) {
    const v = String(process.env.EXECUTOR_PREWARM_SYMBOLS ?? 'true').toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'no';
}
async function prewarmBrokerCaches(ctx) {
    if (!ctx.prewarmSymbolsEnabled() || !(0, fxsocketClient_1.hasFxsocketConfigured)())
        return;
    for (const row of ctx.brokersById.values()) {
        const uuid = (0, helpers_1.brokerSessionUuid)(row);
        if (!uuid)
            continue;
        prewarmBrokerSymbolCaches(ctx, row);
    }
}
async function sessionHeartbeatTick(ctx) {
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return;
    const brokers = activeBrokersForHeartbeat(ctx);
    if (!brokers.length)
        return;
    for (let i = 0; i < brokers.length; i += HEARTBEAT_CONCURRENCY) {
        if (i > 0 && HEARTBEAT_BATCH_GAP_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, HEARTBEAT_BATCH_GAP_MS));
        }
        const batch = brokers.slice(i, i + HEARTBEAT_CONCURRENCY);
        await Promise.all(batch.map(async (broker) => {
            const uuid = (0, helpers_1.brokerSessionUuid)(broker);
            if (!uuid)
                return;
            const api = ctx.apiFor(broker);
            if (!api)
                return;
            await pingBrokerSessionInner(ctx, broker, api, uuid);
        }));
    }
}
async function reconnectCachedBrokers(_ctx) {
    /* FxSocket manages terminal lifecycle */
}
async function pingBrokerSession(ctx, row) {
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)() || !row.is_active)
        return;
    const uuid = (0, helpers_1.brokerSessionUuid)(row);
    if (!uuid)
        return;
    const api = ctx.apiFor(row);
    if (!api)
        return;
    await pingBrokerSessionInner(ctx, row, api, uuid, { force: true });
}
async function symbolCacheKeepaliveTick(ctx) {
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return;
    if (!ctx.prewarmSymbolsEnabled())
        return;
    const uuidsWithList = [...ctx.symbolListCache.keys()];
    for (let i = 0; i < uuidsWithList.length; i += SYMBOL_KEEPALIVE_CONCURRENCY) {
        const batch = uuidsWithList.slice(i, i + SYMBOL_KEEPALIVE_CONCURRENCY);
        await Promise.all(batch.map(async (uuid) => {
            try {
                const fresh = await ctx.fetchSymbolList(uuid);
                if (fresh)
                    ctx.symbolListCache.set(uuid, fresh);
            }
            catch { /* best-effort */ }
        }));
        if (i + SYMBOL_KEEPALIVE_CONCURRENCY < uuidsWithList.length && HEARTBEAT_BATCH_GAP_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, HEARTBEAT_BATCH_GAP_MS));
        }
    }
    const paramsKeys = [...ctx.symbolCache.keys()];
    for (let i = 0; i < paramsKeys.length; i += SYMBOL_KEEPALIVE_CONCURRENCY) {
        const batch = paramsKeys.slice(i, i + SYMBOL_KEEPALIVE_CONCURRENCY);
        await Promise.all(batch.map(async (key) => {
            const sepIdx = key.indexOf(':');
            if (sepIdx < 0)
                return;
            const uuid = key.slice(0, sepIdx);
            const symbol = key.slice(sepIdx + 1);
            if (!(0, helpers_1.isMtUuid)(uuid) || !symbol)
                return;
            const api = ctx.apiForUuid(uuid);
            if (!api)
                return;
            try {
                const p = await api.symbolParams(uuid, symbol);
                const n = (0, fxsocketClient_1.normalizeSymbolParams)(p);
                ctx.symbolCache.set(key, {
                    digits: n.digits ?? 5,
                    point: n.point ?? 0.00001,
                    minLot: n.minLot ?? 0.01,
                    maxLot: n.maxLot ?? 100,
                    lotStep: n.lotStep ?? 0.01,
                    contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
                    stopsLevel: Math.max(0, n.stopsLevel ?? 0),
                    freezeLevel: Math.max(0, n.freezeLevel ?? 0),
                    loadedAt: Date.now(),
                });
            }
            catch { /* best-effort */ }
        }));
        if (i + SYMBOL_KEEPALIVE_CONCURRENCY < paramsKeys.length && HEARTBEAT_BATCH_GAP_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, HEARTBEAT_BATCH_GAP_MS));
        }
    }
}
async function markBrokerSessionDown(ctx, broker, uuid, reason) {
    ctx.sessionPingAt.delete(uuid);
    ctx.sessionOrderBlocked.add(broker.id);
    console.warn(`[tradeExecutor] broker ${broker.id} session down: ${reason}`);
    broker.connection_status = 'error';
    await (0, brokerConnectionStatus_1.writeBrokerConnectionStatus)(ctx.supabase, broker.id, 'error', { rawError: reason });
}
async function ensureBrokerSession(ctx, api, uuid, broker, opts) {
    const now = Date.now();
    const last = ctx.sessionPingAt.get(uuid) ?? 0;
    const blocked = ctx.sessionOrderBlocked.has(broker.id);
    if (!opts?.force && !blocked && now - last < types_1.SESSION_PING_MIN_INTERVAL_MS)
        return true;
    const ready = await api.verifyTradingReady(uuid);
    if (ready) {
        ctx.sessionPingAt.set(uuid, now);
        if (blocked)
            void (0, brokerSignalReplay_1.replayParsedSignalsForBroker)(ctx, broker);
        ctx.sessionOrderBlocked.delete(broker.id);
        return true;
    }
    await ctx.markBrokerSessionDown(broker, uuid, blocked
        ? 'session blocked after prior OrderSend disconnect'
        : 'verifyTradingReady failed before OrderSend');
    return false;
}
async function ensureBrokerSessionLiveFast(ctx, api, uuid, broker) {
    const now = Date.now();
    const last = ctx.sessionPingAt.get(uuid) ?? 0;
    const blocked = ctx.sessionOrderBlocked.has(broker.id);
    if (!blocked && now - last < types_1.SESSION_PING_MIN_INTERVAL_MS)
        return true;
    const inflight = ctx.sessionCheckInflight.get(uuid);
    if (inflight)
        return inflight;
    const check = (async () => {
        try {
            const alive = await api.keepSessionAlive(uuid);
            if (alive) {
                ctx.sessionPingAt.set(uuid, Date.now());
                if (blocked)
                    void (0, brokerSignalReplay_1.replayParsedSignalsForBroker)(ctx, broker);
                ctx.sessionOrderBlocked.delete(broker.id);
                return true;
            }
            await ctx.markBrokerSessionDown(broker, uuid, blocked
                ? 'session blocked after prior OrderSend disconnect'
                : 'keepSessionAlive failed before live OrderSend');
            return false;
        }
        finally {
            ctx.sessionCheckInflight.delete(uuid);
        }
    })();
    ctx.sessionCheckInflight.set(uuid, check);
    return check;
}
function brokersWarmForLiveEntry(ctx, brokers, signalSymbol) {
    if (!brokers.length)
        return true;
    const now = Date.now();
    for (const broker of brokers) {
        const uuid = (0, helpers_1.brokerSessionUuid)(broker);
        if (!uuid)
            continue;
        if (ctx.sessionOrderBlocked.has(broker.id))
            return false;
        const lastPing = ctx.sessionPingAt.get(uuid) ?? 0;
        if (now - lastPing >= types_1.SESSION_PING_MIN_INTERVAL_MS)
            return false;
        const symbolList = ctx.symbolListCache.get(uuid);
        if (!symbolList || now - symbolList.loadedAt >= types_1.SYMBOL_LIST_TTL_MS)
            return false;
        const mapping = (0, helpers_1.applySymbolMapping)(signalSymbol, broker);
        const requested = mapping.symbol;
        const key = `${uuid}:${requested.toUpperCase()}`;
        const params = ctx.symbolCache.get(key);
        if (!params || now - params.loadedAt >= types_1.SYMBOL_CACHE_TTL_MS)
            return false;
    }
    return true;
}
function prewarmForDispatch(ctx, row) {
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return;
    const parsed = row.parsed_data;
    const signalSymbol = parsed?.symbol;
    if (!signalSymbol)
        return;
    const brokers = ctx.brokersByUser.get(row.user_id) ?? [];
    if (!brokers.length)
        return;
    for (const broker of brokers) {
        const uuid = (0, helpers_1.brokerSessionUuid)(broker);
        if (!uuid)
            continue;
        const api = ctx.apiFor(broker);
        if (!api)
            continue;
        const mapping = (0, helpers_1.applySymbolMapping)(signalSymbol, broker);
        const requested = mapping.symbol;
        void ctx.ensureBrokerSessionLiveFast(api, uuid, broker);
        void ctx.getSymbolList(uuid).catch(() => null);
        void ctx.getSymbolParams(uuid, requested).catch(() => null);
    }
}
async function prewarmBrokersForLiveEntry(ctx, brokers, signalSymbol) {
    await Promise.all(brokers.map(async (broker) => {
        const uuid = (0, helpers_1.brokerSessionUuid)(broker);
        if (!uuid)
            return;
        const api = ctx.apiFor(broker);
        if (!api)
            return;
        const mapping = (0, helpers_1.applySymbolMapping)(signalSymbol, broker);
        const requested = mapping.symbol;
        await Promise.all([
            ctx.ensureBrokerSessionLiveFast(api, uuid, broker),
            ctx.getSymbolList(uuid).catch(() => null),
            ctx.getSymbolParams(uuid, requested).catch(() => null),
        ]);
    }));
}
async function getSymbolParams(ctx, uuid, symbol) {
    const key = `${uuid}:${symbol.toUpperCase()}`;
    const cached = ctx.symbolCache.get(key);
    const now = Date.now();
    // Stale-while-revalidate: if we have ANY cached value, return it
    // immediately and kick off a background refresh when stale. The live
    // entry hot path therefore never waits on a broker round-trip after the
    // first signal for a symbol.
    if (cached) {
        const age = now - cached.loadedAt;
        if (age >= types_1.SYMBOL_CACHE_STALE_MS && age < types_1.SYMBOL_CACHE_TTL_MS) {
            void ctx.refreshSymbolParams(uuid, symbol, key);
        }
        if (age < types_1.SYMBOL_CACHE_TTL_MS)
            return cached;
    }
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return null;
    return ctx.refreshSymbolParams(uuid, symbol, key);
}
async function refreshSymbolParams(ctx, uuid, symbol, key) {
    const cacheKey = key ?? `${uuid}:${symbol.toUpperCase()}`;
    const existing = ctx.symbolParamsInflight.get(cacheKey);
    if (existing)
        return existing;
    const api = ctx.apiForUuid(uuid);
    if (!api)
        return null;
    const promise = (async () => {
        try {
            const p = await api.symbolParams(uuid, symbol);
            const n = (0, fxsocketClient_1.normalizeSymbolParams)(p);
            const entry = {
                digits: n.digits ?? 5,
                point: n.point ?? 0.00001,
                minLot: n.minLot ?? 0.01,
                maxLot: n.maxLot ?? 100,
                lotStep: n.lotStep ?? 0.01,
                contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
                stopsLevel: Math.max(0, n.stopsLevel ?? 0),
                freezeLevel: Math.max(0, n.freezeLevel ?? 0),
                loadedAt: Date.now(),
            };
            // First-time-per-symbol diagnostic so we can confirm we actually see the
            // broker's stops/freeze levels (not silent zeros from a casing mismatch).
            if (!ctx.symbolCache.has(cacheKey)) {
                console.log(`[tradeExecutor] symbol params loaded uuid=${uuid} symbol=${symbol} digits=${entry.digits} point=${entry.point} contractSize=${entry.contractSize ?? 'default'} stopsLevel=${entry.stopsLevel} freezeLevel=${entry.freezeLevel} minLot=${entry.minLot} lotStep=${entry.lotStep}`);
            }
            ctx.symbolCache.set(cacheKey, entry);
            return entry;
        }
        catch (e) {
            console.warn(`[tradeExecutor] /SymbolParams failed uuid=${uuid} symbol=${symbol}:`, e instanceof Error ? e.message : e);
            return null;
        }
        finally {
            ctx.symbolParamsInflight.delete(cacheKey);
        }
    })();
    ctx.symbolParamsInflight.set(cacheKey, promise);
    return promise;
}
async function getSymbolList(ctx, uuid) {
    const cached = ctx.symbolListCache.get(uuid);
    const now = Date.now();
    if (cached) {
        const age = now - cached.loadedAt;
        if (age >= types_1.SYMBOL_CACHE_STALE_MS && age < types_1.SYMBOL_LIST_TTL_MS) {
            if (!ctx.symbolListInflight.has(uuid)) {
                const refresh = ctx.fetchSymbolList(uuid).finally(() => {
                    ctx.symbolListInflight.delete(uuid);
                });
                ctx.symbolListInflight.set(uuid, refresh);
            }
        }
        if (age < types_1.SYMBOL_LIST_TTL_MS)
            return cached;
    }
    const inflight = ctx.symbolListInflight.get(uuid);
    if (inflight)
        return inflight;
    const fetchPromise = ctx.fetchSymbolList(uuid).finally(() => {
        ctx.symbolListInflight.delete(uuid);
    });
    ctx.symbolListInflight.set(uuid, fetchPromise);
    return fetchPromise;
}
async function fetchSymbolList(ctx, uuid) {
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)())
        return null;
    const api = ctx.apiForUuid(uuid);
    if (!api)
        return null;
    try {
        const raw = await api.symbols(uuid);
        const list = [];
        const set = new Set();
        if (Array.isArray(raw)) {
            for (const item of raw) {
                let name = null;
                if (typeof item === 'string')
                    name = item;
                else if (item && typeof item === 'object') {
                    const o = item;
                    const n = o.symbolName ?? o.SymbolName ?? o.symbol ?? o.Symbol ?? o.name ?? o.Name;
                    if (typeof n === 'string')
                        name = n;
                }
                if (name && name.trim()) {
                    list.push(name);
                    set.add(name.toUpperCase());
                }
            }
        }
        if (!list.length)
            return null;
        const entry = { set, list, loadedAt: Date.now() };
        ctx.symbolListCache.set(uuid, entry);
        return entry;
    }
    catch {
        return null;
    }
}
function resolveBrokerSymbolFromInventory(ctx, inventory, requested, opts) {
    const target = requested.toUpperCase();
    if (opts?.userDecorated === true) {
        if (inventory.set.has(target)) {
            const exact = inventory.list.find(s => s.toUpperCase() === target);
            return exact ?? requested;
        }
        console.warn(`[tradeExecutor] user-decorated symbol not in broker /Symbols list: ${requested}`);
        return requested;
    }
    if (inventory.set.has(target)) {
        const exact = inventory.list.find(s => s.toUpperCase() === target);
        return exact ?? requested;
    }
    const SUFFIXES = ['', 'M', '.M', 'M.RAW', '.RAW', '.PRO', '.R', '_R', '.I', '_I', '.C', '_C', '.S', '_S', '.X', '_X', '#', '+'];
    const PREFIXES = ['', '#', '_'];
    const candidates = [];
    for (const p of PREFIXES)
        for (const s of SUFFIXES) {
            const c = `${p}${target}${s}`;
            if (c !== target && inventory.set.has(c))
                candidates.push(c);
        }
    if (candidates.length) {
        candidates.sort((a, b) => a.length - b.length);
        const winner = candidates[0];
        const exact = inventory.list.find(s => s.toUpperCase() === winner);
        return exact ?? winner;
    }
    const contains = inventory.list.filter(s => s.toUpperCase().includes(target));
    if (contains.length === 1)
        return contains[0];
    if (contains.length > 1) {
        contains.sort((a, b) => a.length - b.length);
        return contains[0];
    }
    return requested;
}
async function resolveBrokerSymbolForLiveEntry(ctx, uuid, requested, opts) {
    const cached = ctx.symbolListCache.get(uuid);
    if (cached && (Date.now() - cached.loadedAt) < types_1.SYMBOL_LIST_TTL_MS) {
        return ctx.resolveBrokerSymbolFromInventory(cached, requested, opts);
    }
    const inventory = await ctx.getSymbolList(uuid);
    if (!inventory)
        return requested;
    return ctx.resolveBrokerSymbolFromInventory(inventory, requested, opts);
}
async function resolveBrokerSymbol(ctx, uuid, requested, opts) {
    const inventory = await ctx.getSymbolList(uuid);
    if (!inventory)
        return requested;
    return ctx.resolveBrokerSymbolFromInventory(inventory, requested, opts);
}
