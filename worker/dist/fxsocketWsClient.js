"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FxsocketWsClient = void 0;
exports.buildFxsocketWsUrl = buildFxsocketWsUrl;
const ws_1 = __importDefault(require("ws"));
const fxsocketStreamNormalize_1 = require("./fxsocketStreamNormalize");
const DEFAULT_BASE_URL = 'https://api.fxsocket.com';
function trimEnv(v) {
    return (v ?? '').trim();
}
function wsBaseUrl(httpBase) {
    const u = httpBase.replace(/\/+$/, '');
    if (u.startsWith('https://'))
        return `wss://${u.slice('https://'.length)}`;
    if (u.startsWith('http://'))
        return `ws://${u.slice('http://'.length)}`;
    return `wss://${u}`;
}
function subscriptionKey(frame) {
    const parts = [frame.action === 'subscribe' ? 'sub' : 'unsub', frame.topic];
    if (frame.symbol)
        parts.push(frame.symbol);
    if (frame.timeframe)
        parts.push(frame.timeframe);
    return parts.join(':');
}
class FxsocketWsClient {
    constructor(opts) {
        this.ws = null;
        this.handlers = new Set();
        this.activeSubscriptions = new Map();
        this.intentionalClose = false;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        const base = trimEnv(opts.baseUrl) || trimEnv(process.env.FXSOCKET_BASE_URL) || DEFAULT_BASE_URL;
        const id = String(opts.accountId ?? '').trim();
        const key = String(opts.apiKey ?? '').trim();
        if (!id)
            throw new Error('FxsocketWsClient: accountId required');
        if (!key)
            throw new Error('FxsocketWsClient: apiKey required');
        this.accountId = id;
        this.apiKey = key;
        const segment = opts.platform === 'MT4' ? 'mt4' : 'mt5';
        this.wsUrl = `${wsBaseUrl(base)}/${segment}/${encodeURIComponent(id)}/ws?api_key=${encodeURIComponent(key)}`;
        this.reconnect = opts.reconnect !== false;
        this.reconnectDelayMs = Math.max(500, opts.reconnectDelayMs ?? 2000);
        this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, opts.maxReconnectDelayMs ?? 60000);
        this.onConnectionChange = opts.onConnectionChange;
    }
    get connected() {
        return this.ws?.readyState === ws_1.default.OPEN;
    }
    onMessage(handler) {
        this.handlers.add(handler);
        return () => { this.handlers.delete(handler); };
    }
    connect() {
        if (this.ws && (this.ws.readyState === ws_1.default.OPEN || this.ws.readyState === ws_1.default.CONNECTING)) {
            return;
        }
        this.intentionalClose = false;
        this.clearReconnectTimer();
        const ws = new ws_1.default(this.wsUrl, {
            handshakeTimeout: 15000,
            perMessageDeflate: false,
        });
        this.ws = ws;
        ws.on('open', () => {
            this.reconnectAttempt = 0;
            this.onConnectionChange?.(true);
            for (const frame of this.activeSubscriptions.values()) {
                this.sendFrame(frame);
            }
        });
        ws.on('message', (data) => {
            const msg = this.parseMessage(data);
            if (!msg)
                return;
            for (const handler of this.handlers) {
                try {
                    handler(msg);
                }
                catch (e) {
                    console.warn('[fxsocketWsClient] handler error:', e instanceof Error ? e.message : e);
                }
            }
        });
        ws.on('close', () => {
            this.onConnectionChange?.(false);
            if (!this.intentionalClose && this.reconnect && this.handlers.size > 0) {
                this.scheduleReconnect();
            }
        });
        ws.on('error', (err) => {
            console.warn(`[fxsocketWsClient] socket error account=${this.accountId}:`, err.message);
        });
    }
    close() {
        this.intentionalClose = true;
        this.clearReconnectTimer();
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch { /* ignore */ }
            this.ws = null;
        }
    }
    subscribe(frame) {
        const full = { action: 'subscribe', ...frame };
        this.activeSubscriptions.set(subscriptionKey(full), full);
        this.connect();
        this.sendFrame(full);
    }
    unsubscribe(frame) {
        const full = { action: 'unsubscribe', ...frame };
        const key = subscriptionKey({ action: 'subscribe', topic: frame.topic, symbol: frame.symbol, timeframe: frame.timeframe });
        this.activeSubscriptions.delete(key);
        this.sendFrame(full);
        if (this.handlers.size === 0 && this.activeSubscriptions.size === 0) {
            this.close();
        }
    }
    sendFrame(frame) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN)
            return;
        try {
            this.ws.send(JSON.stringify(frame));
        }
        catch (e) {
            console.warn('[fxsocketWsClient] send failed:', e instanceof Error ? e.message : e);
        }
    }
    parseMessage(data) {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        if (!text.trim())
            return null;
        try {
            const parsed = JSON.parse(text);
            return (0, fxsocketStreamNormalize_1.normalizeFxsocketWsMessage)(parsed);
        }
        catch {
            console.warn('[fxsocketWsClient] invalid JSON frame:', text.slice(0, 200));
        }
        return null;
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        const delay = Math.min(this.maxReconnectDelayMs, this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempt));
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.intentionalClose)
                this.connect();
        }, delay);
        this.reconnectTimer.unref?.();
    }
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
exports.FxsocketWsClient = FxsocketWsClient;
function buildFxsocketWsUrl(accountId, apiKey, baseUrl, platform = 'MT5') {
    const base = trimEnv(baseUrl) || trimEnv(process.env.FXSOCKET_BASE_URL) || DEFAULT_BASE_URL;
    const segment = platform === 'MT4' ? 'mt4' : 'mt5';
    return `${wsBaseUrl(base)}/${segment}/${encodeURIComponent(accountId)}/ws?api_key=${encodeURIComponent(apiKey)}`;
}
