"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FxsocketStreamManager = void 0;
exports.getFxsocketStreamManager = getFxsocketStreamManager;
const fxsocketWsClient_1 = require("./fxsocketWsClient");
function topicKey(sub) {
    const parts = [sub.topic];
    if (sub.symbol)
        parts.push(sub.symbol);
    if (sub.timeframe)
        parts.push(sub.timeframe);
    return parts.join(':');
}
function frameFromSubscription(sub) {
    return {
        topic: sub.topic,
        symbol: sub.symbol,
        timeframe: sub.timeframe,
    };
}
/**
 * Manages one upstream FxSocket WebSocket per account and fans out messages
 * to multiple in-process subscribers. Topic subscriptions are reference-counted
 * so the upstream socket only subscribes once per unique topic/symbol/timeframe.
 */
class FxsocketStreamManager {
    constructor(opts) {
        this.streams = new Map();
        const key = (opts?.apiKey ?? process.env.FXSOCKET_API_KEY ?? '').trim();
        if (!key)
            throw new Error('FxsocketStreamManager: FXSOCKET_API_KEY required');
        this.apiKey = key;
        this.baseUrl = opts?.baseUrl?.trim() || process.env.FXSOCKET_BASE_URL?.trim() || undefined;
    }
    /**
     * Subscribe to stream messages for an account. Returns an unsubscribe function.
     * Pass `subscriptions` to auto-subscribe upstream topics (reference-counted).
     */
    subscribe(accountId, handler, subscriptions = [], platform = 'MT5') {
        const id = String(accountId ?? '').trim();
        if (!id)
            throw new Error('FxsocketStreamManager.subscribe: accountId required');
        let stream = this.streams.get(id);
        if (!stream) {
            const client = new fxsocketWsClient_1.FxsocketWsClient({
                accountId: id,
                apiKey: this.apiKey,
                baseUrl: this.baseUrl,
                platform,
                onConnectionChange: (connected) => {
                    if (connected)
                        return;
                    if (!this.streams.has(id))
                        return;
                    const current = this.streams.get(id);
                    if (current && current.handlers.size === 0) {
                        this.teardownAccount(id);
                    }
                },
            });
            const relay = (msg) => {
                for (const h of stream.handlers) {
                    try {
                        h(msg);
                    }
                    catch (e) {
                        console.warn('[fxsocketStreamManager] handler error:', e instanceof Error ? e.message : e);
                    }
                }
            };
            client.onMessage(relay);
            stream = { client, handlers: new Set(), topicRefCounts: new Map() };
            this.streams.set(id, stream);
        }
        stream.handlers.add(handler);
        for (const sub of subscriptions) {
            this.addTopicRef(stream, sub);
        }
        stream.client.connect();
        return () => {
            this.unsubscribe(id, handler, subscriptions);
        };
    }
    unsubscribe(accountId, handler, subscriptions = []) {
        const id = String(accountId ?? '').trim();
        const stream = this.streams.get(id);
        if (!stream)
            return;
        stream.handlers.delete(handler);
        for (const sub of subscriptions) {
            this.releaseTopicRef(stream, sub);
        }
        if (stream.handlers.size === 0) {
            this.teardownAccount(id);
        }
    }
    /** Explicit upstream topic subscribe without adding a message handler. */
    ensureTopic(accountId, sub) {
        const id = String(accountId ?? '').trim();
        let stream = this.streams.get(id);
        if (!stream) {
            const noop = () => { };
            const unsub = this.subscribe(id, noop, [sub]);
            stream = this.streams.get(id);
            return () => {
                unsub();
            };
        }
        this.addTopicRef(stream, sub);
        stream.client.connect();
        return () => {
            this.releaseTopicRef(stream, sub);
            if (stream.handlers.size === 0)
                this.teardownAccount(id);
        };
    }
    subscribePrices(accountId, symbol, handler) {
        return this.subscribe(accountId, handler, [{ topic: 'prices', symbol }]);
    }
    subscribePositions(accountId, handler) {
        return this.subscribe(accountId, handler, [{ topic: 'positions' }]);
    }
    subscribeAccount(accountId, handler) {
        return this.subscribe(accountId, handler, [{ topic: 'account' }]);
    }
    subscribeTrades(accountId, handler) {
        return this.subscribe(accountId, handler, [{ topic: 'trades' }]);
    }
    subscribeTerminal(accountId, handler) {
        return this.subscribe(accountId, handler, [{ topic: 'terminal' }]);
    }
    isConnected(accountId) {
        return this.streams.get(accountId)?.client.connected ?? false;
    }
    closeAll() {
        for (const id of [...this.streams.keys()]) {
            this.teardownAccount(id);
        }
    }
    closeAccount(accountId) {
        this.teardownAccount(String(accountId ?? '').trim());
    }
    addTopicRef(stream, sub) {
        const key = topicKey(sub);
        const prev = stream.topicRefCounts.get(key) ?? 0;
        stream.topicRefCounts.set(key, prev + 1);
        if (prev === 0) {
            stream.client.subscribe(frameFromSubscription(sub));
        }
    }
    releaseTopicRef(stream, sub) {
        const key = topicKey(sub);
        const prev = stream.topicRefCounts.get(key) ?? 0;
        if (prev <= 1) {
            stream.topicRefCounts.delete(key);
            stream.client.unsubscribe(frameFromSubscription(sub));
        }
        else {
            stream.topicRefCounts.set(key, prev - 1);
        }
    }
    teardownAccount(accountId) {
        const stream = this.streams.get(accountId);
        if (!stream)
            return;
        this.streams.delete(accountId);
        stream.client.close();
    }
}
exports.FxsocketStreamManager = FxsocketStreamManager;
let managerSingleton;
function getFxsocketStreamManager() {
    if (managerSingleton !== undefined)
        return managerSingleton;
    try {
        managerSingleton = new FxsocketStreamManager();
        return managerSingleton;
    }
    catch {
        managerSingleton = null;
        return null;
    }
}
