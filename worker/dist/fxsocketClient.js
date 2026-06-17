"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FxsocketBrokerClient = exports.MT_SESSION_EXPIRED_HINT = exports.FxsocketApiError = void 0;
exports.normalizeOrderResponse = normalizeOrderResponse;
exports.normalizeSymbolParams = normalizeSymbolParams;
exports.unwrapOrderList = unwrapOrderList;
exports.hasFxsocketConfigured = hasFxsocketConfigured;
exports.isCheckConnectOk = isCheckConnectOk;
exports.isMtSessionGoneMessage = isMtSessionGoneMessage;
exports.isBrokerDisconnectedMessage = isBrokerDisconnectedMessage;
exports.isMtSessionGoneError = isMtSessionGoneError;
exports.isTransientMtApiError = isTransientMtApiError;
exports.mtPlatformFrom = mtPlatformFrom;
exports.getFxsocketClient = getFxsocketClient;
const undici_1 = require("undici");
const brokerConnectError_1 = require("./brokerConnectError");
const mtTradeFields_1 = require("./mtTradeFields");
/**
 * FxSocket MT5 REST client for the worker.
 *
 * - Account linking: POST/GET/DELETE https://api.fxsocket.com/v1/accounts
 * - Trading: https://api.fxsocket.com/mt4/{accountId}/… or …/mt5/{accountId}/…
 * - Auth: X-API-Key header (FXSOCKET_API_KEY)
 */
const DEFAULT_BASE_URL = 'https://api.fxsocket.com';
const FXSOCKET_HTTP_CONNECTIONS = Math.max(8, Math.min(512, Number(process.env.FXSOCKET_HTTP_CONNECTIONS ?? 128)));
const KEEP_ALIVE_AGENT = new undici_1.Agent({
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 600000,
    connections: FXSOCKET_HTTP_CONNECTIONS,
    pipelining: 1,
});
function orderOperationRequiresPrice(operation) {
    return (operation === 'BuyLimit'
        || operation === 'SellLimit'
        || operation === 'BuyStop'
        || operation === 'SellStop'
        || operation === 'BuyStopLimit'
        || operation === 'SellStopLimit');
}
class FxsocketApiError extends Error {
    constructor(message, status, code, commandId) {
        super(message);
        this.name = 'FxsocketApiError';
        this.status = status;
        this.code = code;
        this.commandId = commandId;
    }
}
exports.FxsocketApiError = FxsocketApiError;
function num(v) {
    if (v === null || v === undefined)
        return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
}
function nestedTicket(o, key) {
    const nest = o[key];
    if (nest == null || typeof nest !== 'object')
        return undefined;
    const n = nest;
    return n.ticket ?? n.Ticket ?? n.order ?? n.Order;
}
/**
 * Normalize order responses from FxSocket ({ order, deal, success }) and legacy
 * MT REST shapes ({ ticket, Ticket, result: { … } }) into camelCase OrderResult.
 */
function normalizeOrderResponse(body) {
    if (body == null || typeof body !== 'object') {
        return { ticket: NaN };
    }
    const root = body;
    let o = root;
    if ('result' in root && root.result != null && typeof root.result === 'object') {
        o = root.result;
    }
    const ticketRaw = o.ticket
        ?? o.Ticket
        ?? o.order
        ?? o.Order
        ?? o.orderId
        ?? o.OrderId
        ?? o.deal
        ?? o.Deal
        ?? nestedTicket(o, 'deal')
        ?? nestedTicket(o, 'Deal')
        ?? nestedTicket(o, 'DealInternalIn')
        ?? nestedTicket(o, 'ex');
    const ticket = typeof ticketRaw === 'number' ? ticketRaw : Number(ticketRaw);
    return {
        ticket: Number.isFinite(ticket) ? ticket : NaN,
        openPrice: num(o.openPrice ?? o.OpenPrice ?? o.price ?? o.Price),
        stopLoss: num(o.stopLoss ?? o.StopLoss),
        takeProfit: num(o.takeProfit ?? o.TakeProfit),
        lots: num(o.lots ?? o.Lots ?? o.volume ?? o.Volume),
        symbol: typeof o.symbol === 'string' ? o.symbol : typeof o.Symbol === 'string' ? o.Symbol : undefined,
        orderType: typeof o.orderType === 'string' ? o.orderType : typeof o.OrderType === 'string' ? String(o.OrderType) : typeof o.type === 'string' ? o.type : undefined,
        state: typeof o.state === 'string' ? o.state : typeof o.State === 'string' ? String(o.State) : undefined,
        closePrice: num(o.closePrice ?? o.ClosePrice),
        profit: num(o.profit ?? o.Profit),
        swap: num(o.swap ?? o.Swap),
        commission: num(o.commission ?? o.Commission),
        fee: num(o.fee ?? o.Fee),
        comment: typeof o.comment === 'string' ? o.comment : typeof o.Comment === 'string' ? o.Comment : undefined,
    };
}
function parseErrorEnvelope(body) {
    if (body && typeof body === 'object') {
        const o = body;
        if (o.detail != null) {
            const detail = o.detail;
            if (typeof detail === 'string') {
                return { message: detail, code: o.error != null ? String(o.error) : undefined };
            }
            if (Array.isArray(detail))
                return { message: detail.map(String).join('; ') };
        }
        const message = String(o.message ?? o.error ?? o.Message ?? 'FxSocket request failed');
        const code = o.error != null ? String(o.error) : o.code != null ? String(o.code) : undefined;
        const commandId = num(o.command_id ?? o.commandId);
        return { message, code, commandId };
    }
    if (typeof body === 'string' && body.trim())
        return { message: body.trim() };
    return { message: 'FxSocket request failed' };
}
function assertNoApiError(body) {
    if (body == null || typeof body !== 'object')
        return;
    const root = body;
    if (root.success === false) {
        const msg = String(root.retcodeDescription ?? root.message ?? 'Order rejected').trim();
        const code = root.retcode != null ? String(root.retcode) : undefined;
        throw new FxsocketApiError(msg || 'Order rejected', 200, code);
    }
    const err = root.error;
    if (err && typeof err === 'object') {
        const e = err;
        const m = String(e.message ?? e.Message ?? '').trim();
        if (m && m !== 'null' && m !== 'undefined') {
            throw new FxsocketApiError(m, 200, e.code != null ? String(e.code) : undefined);
        }
    }
    if (!('result' in root) && !('ticket' in root) && !('Ticket' in root) && !('order' in root) && !('deal' in root)) {
        const m = root.message ?? root.Message;
        const code = root.code ?? root.Code;
        if (typeof m === 'string' && m.trim()) {
            throw new FxsocketApiError(m.trim(), 200, code != null ? String(code) : undefined);
        }
    }
}
function readNum(obj, ...keys) {
    if (!obj || typeof obj !== 'object')
        return undefined;
    const rec = obj;
    for (const k of keys) {
        const v = rec[k];
        if (v == null)
            continue;
        const n = Number(v);
        if (Number.isFinite(n))
            return n;
    }
    return undefined;
}
function normalizeSymbolParams(p) {
    if (!p || typeof p !== 'object')
        return {};
    const sym = p.symbol ?? p.Symbol ?? p;
    const grp = p.groupParams
        ?? p.GroupParams
        ?? p.group
        ?? p.Group
        ?? p;
    return {
        digits: readNum(sym, 'digits', 'Digits', 'DIGITS'),
        point: readNum(sym, 'point', 'Point', 'POINT'),
        contractSize: readNum(sym, 'contractSize', 'ContractSize', 'contract_size', 'TradeContractSize'),
        stopsLevel: readNum(sym, 'stopsLevel', 'StopsLevel', 'stops_level', 'TradeStopsLevel', 'trade_stops_level'),
        freezeLevel: readNum(sym, 'freezeLevel', 'FreezeLevel', 'freeze_level', 'TradeFreezeLevel', 'trade_freeze_level'),
        minLot: readNum(grp, 'minLot', 'MinLot', 'min_lot', 'volume_min', 'VolumeMin', 'volumeMin', 'volumeMin'),
        maxLot: readNum(grp, 'maxLot', 'MaxLot', 'max_lot', 'volume_max', 'VolumeMax', 'volumeMax', 'volumeMax'),
        lotStep: readNum(grp, 'lotStep', 'LotStep', 'lot_step', 'volume_step', 'VolumeStep', 'volumeStep', 'volumeStep'),
    };
}
function unwrapOrderList(raw) {
    if (Array.isArray(raw))
        return raw;
    if (raw && typeof raw === 'object') {
        const r = raw;
        if (Array.isArray(r.result))
            return r.result;
        if (Array.isArray(r.Result))
            return r.Result;
        if (Array.isArray(r.orders))
            return r.orders;
        if (Array.isArray(r.Orders))
            return r.Orders;
        const nested = r.result ?? r.Result;
        if (nested && typeof nested === 'object') {
            const pr = nested;
            const orders = pr.Orders ?? pr.orders;
            if (Array.isArray(orders))
                return orders;
        }
    }
    return [];
}
function trimEnv(v) {
    return (v ?? '').trim();
}
function normalizeBaseUrl(raw, fallback) {
    let u = trimEnv(raw);
    if (!u)
        return fallback.replace(/\/+$/, '');
    u = u.replace(/^[<\[(]+/, '').replace(/[>\])]+$/, '');
    u = u.replace(/\/+$/, '');
    try {
        const parsed = new URL(u.includes('://') ? u : `https://${u}`);
        return `${parsed.protocol}//${parsed.host}`;
    }
    catch {
        console.warn(`[fxsocketClient] invalid base URL "${raw.slice(0, 80)}", using default`);
        return fallback.replace(/\/+$/, '');
    }
}
function resolveApiKey(env = process.env) {
    const key = trimEnv(env.FXSOCKET_API_KEY);
    if (!key) {
        throw new Error('FXSOCKET_API_KEY is required');
    }
    return key;
}
function hasFxsocketConfigured(env = process.env) {
    try {
        resolveApiKey(env);
        return true;
    }
    catch {
        return false;
    }
}
function isCheckConnectOk(body) {
    if (body === true)
        return true;
    if (body === false)
        return false;
    if (typeof body === 'number')
        return body > 0;
    if (typeof body === 'string') {
        const s = body.trim().toLowerCase();
        if (!s)
            return false;
        if (s === 'connecting')
            return false;
        if (s === 'true' || s === 'ok' || s === 'connected' || s === 'yes' || s === '1')
            return true;
        if (s === 'false'
            || s === '0'
            || s.includes('not connected')
            || s.includes('disconnected')
            || s.includes('notconnected')
            || s === 'error') {
            return false;
        }
        return true;
    }
    if (body && typeof body === 'object') {
        const r = body;
        const status = r.status ?? r.Status;
        if (typeof status === 'string') {
            const s = status.trim().toLowerCase();
            if (s === 'connected')
                return true;
            if (s === 'error' || s === 'disconnected')
                return false;
            if (s === 'connecting')
                return false;
        }
        const nested = r.result ?? r.Result;
        if (nested !== undefined && nested !== r)
            return isCheckConnectOk(nested);
        const flag = r.connected ?? r.Connected ?? r.isConnected ?? r.IsConnected;
        if (typeof flag === 'boolean')
            return flag;
        if (typeof flag === 'string' || typeof flag === 'number')
            return isCheckConnectOk(flag);
    }
    return true;
}
function isMtSessionGoneMessage(message) {
    const m = message.trim().toLowerCase();
    if (!m)
        return false;
    return (m.includes('client with id')
        || m.includes('client not found')
        || (m.includes('not found') && (m.includes('client') || m.includes('account') || m.includes('id')))
        || m.includes('unknown client')
        || m.includes('session not found')
        || m.includes('account not found')
        || m.includes('terminal is down')
        || m.includes('account or endpoint not found')
        || m.includes('unlink'));
}
function isBrokerDisconnectedMessage(message) {
    const m = message.trim().toLowerCase();
    if (!m)
        return false;
    if (isMtSessionGoneMessage(message))
        return true;
    return (m.includes('not connected')
        || m.includes('broker session is not connected')
        || m.includes('status: disconnected')
        || m.includes('status: error'));
}
function isMtSessionGoneError(err) {
    if (err instanceof FxsocketApiError)
        return isMtSessionGoneMessage(err.message) || err.status === 404;
    if (err instanceof Error)
        return isMtSessionGoneMessage(err.message);
    return isMtSessionGoneMessage(String(err));
}
function isTransientMtApiError(err) {
    if (err instanceof FxsocketApiError) {
        const s = err.status;
        if (s === 502 || s === 503 || s === 504)
            return true;
    }
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return /timeout|econnreset|econnrefused|fetch failed|network error|socket hang up|epipe|ehostunreach|abort/.test(msg);
}
exports.MT_SESSION_EXPIRED_HINT = 'Trading session expired on the broker API. In Account Configuration, use Reconnect and enter your MT password (or remove and link the account again).';
function formatMtApiDateTime(d) {
    return d.toISOString().slice(0, 19);
}
function normalizeAccountSummary(body) {
    if (body == null || typeof body !== 'object')
        return {};
    const root = body;
    const o = (root.result && typeof root.result === 'object')
        ? root.result
        : root;
    return {
        balance: num(o.balance ?? o.Balance),
        credit: num(o.credit ?? o.Credit),
        profit: num(o.profit ?? o.Profit),
        equity: num(o.equity ?? o.Equity),
        margin: num(o.margin ?? o.Margin),
        freeMargin: num(o.freeMargin ?? o.FreeMargin ?? o.marginFree ?? o.MarginFree ?? o.free_margin),
        marginLevel: num(o.marginLevel ?? o.MarginLevel ?? o.margin_level),
        leverage: num(o.leverage ?? o.Leverage),
        currency: typeof o.currency === 'string' ? o.currency : typeof o.Currency === 'string' ? o.Currency : undefined,
    };
}
function symbolInfoToParams(info, symbol) {
    return {
        symbolName: typeof info.symbol === 'string' ? info.symbol : symbol,
        symbol: {
            digits: readNum(info, 'digits', 'Digits'),
            point: readNum(info, 'point', 'Point'),
            contractSize: readNum(info, 'contractSize', 'ContractSize', 'contract_size'),
            stopsLevel: readNum(info, 'stopsLevel', 'StopsLevel', 'stops_level'),
            freezeLevel: readNum(info, 'freezeLevel', 'FreezeLevel', 'freeze_level'),
        },
        groupParams: {
            minLot: readNum(info, 'volumeMin', 'VolumeMin', 'minLot', 'MinLot'),
            maxLot: readNum(info, 'volumeMax', 'VolumeMax', 'maxLot', 'MaxLot'),
            lotStep: readNum(info, 'volumeStep', 'VolumeStep', 'lotStep', 'LotStep'),
        },
        ...info,
    };
}
function mtPlatformFrom(value) {
    return String(value ?? '').trim().toUpperCase() === 'MT4' ? 'MT4' : 'MT5';
}
function accountApiPathSegment(platform) {
    return platform === 'MT4' ? 'mt4' : 'mt5';
}
function normalizeV1Account(raw) {
    const o = (raw && typeof raw === 'object') ? raw : {};
    return {
        id: o.id != null ? String(o.id) : '',
        platform: o.platform != null ? String(o.platform) : '',
        status: o.status != null ? String(o.status) : '',
        error: o.error != null ? String(o.error) : '',
    };
}
class FxsocketBrokerClient {
    constructor(_platform = 'MT5', apiKey, baseUrl, timeoutMs = 30000) {
        this.platformCache = new Map();
        const key = (apiKey ?? resolveApiKey()).trim();
        if (!key)
            throw new Error('FxsocketBrokerClient: FXSOCKET_API_KEY required');
        this.apiKey = key;
        this.baseUrl = normalizeBaseUrl(baseUrl ?? trimEnv(process.env.FXSOCKET_BASE_URL), DEFAULT_BASE_URL);
        this.v1BaseUrl = `${this.baseUrl}/v1`;
        this.timeoutMs = timeoutMs;
    }
    /** Seed platform from broker_accounts so REST calls use /mt4/ or /mt5/ without a v1 round-trip. */
    seedPlatformCache(id, platform) {
        const trimmed = String(id ?? '').trim();
        if (!trimmed)
            return;
        this.platformCache.set(trimmed, mtPlatformFrom(platform));
    }
    async resolvePlatform(id, hint) {
        if (hint) {
            this.platformCache.set(id, hint);
            return hint;
        }
        const cached = this.platformCache.get(id);
        if (cached)
            return cached;
        try {
            const v1 = await this.getV1Account(id);
            const platform = mtPlatformFrom(v1.platform);
            this.platformCache.set(id, platform);
            return platform;
        }
        catch {
            return 'MT5';
        }
    }
    async accountBase(accountId, platformHint) {
        const id = String(accountId ?? '').trim();
        if (!id)
            throw new FxsocketApiError('account id required', 400);
        const platform = await this.resolvePlatform(id, platformHint);
        return `${this.baseUrl}/${accountApiPathSegment(platform)}/${encodeURIComponent(id)}`;
    }
    async getV1Account(id) {
        const raw = await this.get(`${this.v1BaseUrl}/accounts/${encodeURIComponent(id)}`);
        assertNoApiError(raw);
        return normalizeV1Account(raw);
    }
    async http(method, url, opts) {
        const t = opts?.timeoutMs ?? this.timeoutMs;
        const headers = {
            'X-API-Key': this.apiKey,
            accept: 'application/json, text/plain',
        };
        let body;
        if (opts?.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(opts.body);
        }
        const res = await (0, undici_1.request)(url, {
            method,
            headers,
            body,
            dispatcher: KEEP_ALIVE_AGENT,
            headersTimeout: t,
            bodyTimeout: t,
        });
        const text = await res.body.text();
        let parsed = null;
        if (text) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = text;
            }
        }
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
            const err = parseErrorEnvelope(parsed);
            if (status === 404 && (url.includes('/mt5/') || url.includes('/mt4/'))) {
                throw new FxsocketApiError('FxSocket account or endpoint not found. Check the account UUID and that the terminal is running.', 404, err.code, err.commandId);
            }
            throw new FxsocketApiError(err.message || text || `HTTP ${status}`, status, err.code, err.commandId);
        }
        return parsed;
    }
    get(path, params, timeoutMs) {
        const out = new URLSearchParams();
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                if (v === undefined || v === null || v === '')
                    continue;
                out.set(k, String(v));
            }
        }
        const qs = out.toString();
        return this.http('GET', `${path}${qs ? `?${qs}` : ''}`, { timeoutMs });
    }
    post(path, body, timeoutMs) {
        return this.http('POST', path, { body, timeoutMs });
    }
    async connectEx(args) {
        const loginNum = Number(String(args.login).trim());
        if (!Number.isFinite(loginNum) || loginNum < 1) {
            throw new FxsocketApiError('Invalid MT5 login number', 400);
        }
        const payload = {
            login: loginNum,
            password: args.password,
            server: args.server.trim(),
        };
        const nickname = args.id?.trim();
        if (nickname)
            payload.nickname = nickname;
        const raw = await this.http('POST', `${this.v1BaseUrl}/accounts`, {
            body: payload,
            timeoutMs: 120000,
        });
        assertNoApiError(raw);
        const acct = normalizeV1Account(raw);
        if (!acct.id) {
            throw new FxsocketApiError('FxSocket link succeeded but no account id was returned.', 502);
        }
        return acct.id;
    }
    /** No-op for FxSocket — sessions are managed server-side; kept for compat. */
    async connectByToken(_id) {
        return;
    }
    async ensureConnected(id) {
        const alive = await this.keepSessionAlive(id);
        if (!alive)
            throw new FxsocketApiError('Broker session is not connected', 502);
    }
    async keepSessionAlive(id) {
        const status = await this.keepSessionAliveDetailed(id);
        return status === 'alive';
    }
    async keepSessionAliveDetailed(id) {
        try {
            await this.checkConnect(id);
            return 'alive';
        }
        catch (first) {
            if (isMtSessionGoneError(first)) {
                console.warn(`[fxsocketClient] MT session gone id=${id} — ${exports.MT_SESSION_EXPIRED_HINT}`);
                return 'session_gone';
            }
            const msg = first instanceof Error ? first.message : String(first);
            console.warn(`[fxsocketClient] CheckConnect failed id=${id}: ${msg}`);
            return 'token_reconnect_failed';
        }
    }
    async verifyTradingReady(id) {
        if (!await this.keepSessionAlive(id))
            return false;
        try {
            const summary = await this.accountSummary(id);
            const hasSummary = summary != null
                && (summary.balance != null || summary.equity != null || summary.currency);
            if (!hasSummary)
                return false;
            await this.openedOrders(id);
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (isBrokerDisconnectedMessage(msg) || isMtSessionGoneError(err))
                return false;
            if ((0, brokerConnectError_1.isMtBridgeGlitchMessage)(msg)) {
                console.warn(`[fxsocketClient] verifyTradingReady bridge glitch id=${id}: ${msg}`);
                return true;
            }
            console.warn(`[fxsocketClient] verifyTradingReady failed id=${id}: ${msg}`);
            return false;
        }
    }
    async disconnect(id) {
        try {
            await this.http('DELETE', `${this.v1BaseUrl}/accounts/${encodeURIComponent(id)}`, { timeoutMs: 30000 });
        }
        catch (e) {
            console.warn('[fxsocketClient] disconnect failed:', e instanceof Error ? e.message : e);
        }
    }
    async openedOrders(id) {
        const raw = await this.get(`${await this.accountBase(id)}/OpenedOrders`);
        assertNoApiError(raw);
        return unwrapOrderList(raw);
    }
    /** FxSocket has no /ClosedOrders — approximate with recent OrderHistory. */
    async closedOrders(id) {
        const to = formatMtApiDateTime(new Date());
        const from = formatMtApiDateTime(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
        try {
            const rows = await this.orderHistory(id, from, to);
            return rows.slice(-100);
        }
        catch {
            return [];
        }
    }
    async orderHistory(id, from, to) {
        const raw = await this.get(`${await this.accountBase(id)}/OrderHistory`, { from, to });
        assertNoApiError(raw);
        return unwrapOrderList(raw);
    }
    /** FxSocket has no /HistoryPositions — filter deal history for position closes. */
    async historyPositions(id, from, to) {
        try {
            const rows = await this.orderHistory(id, from, to);
            return rows.filter((row) => {
                if (!row || typeof row !== 'object')
                    return false;
                const r = row;
                const entry = String(r.entry ?? r.Entry ?? '').toLowerCase();
                return entry === 'out' || entry === 'out_by' || entry === 'inout';
            });
        }
        catch {
            return [];
        }
    }
    async orderHistoryPage(id, from, to, pageNumber, ordersPerPage = 500) {
        const all = await this.orderHistory(id, from, to);
        const pagesCount = Math.max(1, Math.ceil(all.length / ordersPerPage));
        const page = Math.max(0, Math.min(pageNumber, pagesCount - 1));
        const start = page * ordersPerPage;
        return {
            orders: all.slice(start, start + ordersPerPage),
            pagesCount,
        };
    }
    async closedOrdersHistory(id, from, to, profile = 'dashboard') {
        const byKey = new Map();
        const ingest = (rows) => (0, mtTradeFields_1.ingestMtHistoryRows)(byKey, rows, profile);
        try {
            let page = 0;
            let pagesCount = 1;
            while (page < pagesCount && page < 100) {
                const { orders, pagesCount: totalPages } = await this.orderHistoryPage(id, from, to, page);
                ingest(orders);
                pagesCount = Math.max(1, totalPages);
                if (orders.length === 0)
                    break;
                page += 1;
            }
        }
        catch {
            /* optional */
        }
        const settled = profile === 'dashboard'
            ? await Promise.allSettled([
                this.closedOrders(id),
                this.historyPositions(id, from, to),
                this.orderHistory(id, from, to),
            ])
            : await Promise.allSettled([
                this.historyPositions(id, from, to),
                this.orderHistory(id, from, to),
            ]);
        for (const r of settled) {
            if (r.status === 'fulfilled')
                ingest(r.value);
        }
        return [...byKey.values()];
    }
    async closedOrdersHistoryLite(id, from, to, profile = 'dashboard', maxPages = 2, ordersPerPage = 200) {
        const byKey = new Map();
        const ingest = (rows) => (0, mtTradeFields_1.ingestMtHistoryRows)(byKey, rows, profile);
        try {
            ingest(await this.closedOrders(id));
        }
        catch {
            /* optional */
        }
        try {
            const probe = await this.orderHistoryPage(id, from, to, 0, ordersPerPage);
            const pagesCount = Math.max(1, probe.pagesCount);
            if (pagesCount === 1) {
                ingest(probe.orders);
            }
            else {
                const startPage = Math.max(0, pagesCount - maxPages);
                for (let page = startPage; page < pagesCount; page++) {
                    const { orders } = page === 0
                        ? probe
                        : await this.orderHistoryPage(id, from, to, page, ordersPerPage);
                    ingest(orders);
                }
            }
            if (byKey.size > 0)
                return [...byKey.values()];
        }
        catch {
            /* fall through */
        }
        try {
            ingest(await this.orderHistory(id, from, to));
        }
        catch {
            /* ignore */
        }
        return [...byKey.values()];
    }
    async accountSummary(id) {
        const raw = await this.get(`${await this.accountBase(id)}/AccountSummary`);
        assertNoApiError(raw);
        return normalizeAccountSummary(raw);
    }
    async checkConnect(id) {
        const checkTimeoutMs = Math.max(500, Math.min(5000, Number(process.env.FXSOCKET_CHECK_CONNECT_TIMEOUT_MS ?? 1500)));
        const raw = await this.get(`${this.v1BaseUrl}/accounts/${encodeURIComponent(id)}`, undefined, checkTimeoutMs);
        assertNoApiError(raw);
        const acct = normalizeV1Account(raw);
        this.platformCache.set(id, mtPlatformFrom(acct.platform));
        if (acct.status === 'error') {
            throw new FxsocketApiError(acct.error || 'Broker session is not connected', 502);
        }
        if (acct.status === 'disconnected') {
            throw new FxsocketApiError('Broker session is not connected', 502);
        }
        if (!isCheckConnectOk(acct.status)) {
            throw new FxsocketApiError('Broker session is not connected', 502);
        }
    }
    async symbolParams(id, symbol) {
        const raw = await this.get(`${await this.accountBase(id)}/SymbolInfo`, { symbol });
        return symbolInfoToParams(raw ?? {}, symbol);
    }
    async symbols(id) {
        const raw = await this.get(`${await this.accountBase(id)}/symbols`);
        return Array.isArray(raw) ? raw : unwrapOrderList(raw);
    }
    async quote(id, symbol) {
        const raw = await this.get(`${await this.accountBase(id)}/getQuote`, { symbol });
        assertNoApiError(raw);
        const root = (raw && typeof raw === 'object') ? raw : {};
        const r = (root.result && typeof root.result === 'object') ? root.result : root;
        const bid = num(r.bid ?? r.Bid);
        const ask = num(r.ask ?? r.Ask);
        const time = typeof r.time === 'string' ? r.time : typeof r.Time === 'string' ? r.Time : undefined;
        if (bid == null || ask == null || bid <= 0 || ask <= 0) {
            throw new FxsocketApiError(`Quote: invalid bid/ask for ${symbol} (bid=${String(r.Bid ?? r.bid)} ask=${String(r.Ask ?? r.ask)})`, 200);
        }
        return {
            symbol: typeof r.symbol === 'string' ? r.symbol : typeof r.Symbol === 'string' ? r.Symbol : symbol,
            bid,
            ask,
            time,
        };
    }
    async orderSend(id, args) {
        const MAX_ATTEMPTS = Math.max(1, Number(process.env.MT_ORDERSEND_MAX_ATTEMPTS ?? 3) || 3);
        let lastErr;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                return await this.orderSendOnce(id, args);
            }
            catch (err) {
                lastErr = err;
                if (isBrokerDisconnectedMessage(err instanceof Error ? err.message : String(err)))
                    throw err;
                if (isMtSessionGoneError(err))
                    throw err;
                const msg = err instanceof Error ? err.message : String(err);
                const retryable = (0, brokerConnectError_1.isMtBridgeGlitchMessage)(msg) || isTransientMtApiError(err);
                if (!retryable || attempt >= MAX_ATTEMPTS - 1)
                    throw err;
                if ((0, brokerConnectError_1.isMtBridgeGlitchMessage)(msg)) {
                    await this.keepSessionAlive(id).catch(() => { });
                }
                const jitterMs = 600 + Math.random() * 900 + attempt * 400;
                console.warn(`[fxsocketClient] OrderSend retry id=${id} symbol=${args.symbol} attempt=${attempt + 1}/${MAX_ATTEMPTS}: ${msg}`);
                await new Promise(r => setTimeout(r, jitterMs));
            }
        }
        throw lastErr instanceof Error ? lastErr : new FxsocketApiError(String(lastErr), 502);
    }
    async orderSendOnce(id, args) {
        const op = String(args.operation);
        const px = Number(args.price);
        if (orderOperationRequiresPrice(op) && (!Number.isFinite(px) || px <= 0)) {
            throw new FxsocketApiError(`OrderSend: ${op} requires a positive price (got ${String(args.price)}); refusing to send price=0`, 400);
        }
        const payload = {
            symbol: args.symbol,
            operation: args.operation,
            volume: args.volume,
            slippage: args.slippage ?? 20,
            comment: args.comment ?? '',
            expertId: args.expertID ?? 0,
        };
        if (Number.isFinite(px) && px > 0)
            payload.price = px;
        if (args.stoploss != null && args.stoploss !== 0)
            payload.stopLoss = args.stoploss;
        if (args.takeprofit != null && args.takeprofit !== 0)
            payload.takeProfit = args.takeprofit;
        if (args.expiration)
            payload.expiration = args.expiration;
        const raw = await this.post(`${await this.accountBase(id)}/OrderSend`, payload, 90000);
        assertNoApiError(raw);
        const out = normalizeOrderResponse(raw);
        if (!Number.isFinite(out.ticket) || out.ticket <= 0) {
            const preview = typeof raw === 'object' && raw !== null ? JSON.stringify(raw).slice(0, 500) : String(raw);
            throw new FxsocketApiError(`OrderSend returned no ticket (response: ${preview})`, 200);
        }
        return out;
    }
    async orderModify(id, args) {
        const MAX_ATTEMPTS = Math.max(1, Number(process.env.MT_ORDERMODIFY_MAX_ATTEMPTS ?? 3) || 3);
        let lastErr;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                return await this.orderModifyOnce(id, args);
            }
            catch (err) {
                lastErr = err;
                if (isBrokerDisconnectedMessage(err instanceof Error ? err.message : String(err)))
                    throw err;
                if (isMtSessionGoneError(err))
                    throw err;
                const msg = err instanceof Error ? err.message : String(err);
                const retryable = (0, brokerConnectError_1.isMtBridgeGlitchMessage)(msg) || isTransientMtApiError(err);
                if (!retryable || attempt >= MAX_ATTEMPTS - 1)
                    throw err;
                if ((0, brokerConnectError_1.isMtBridgeGlitchMessage)(msg)) {
                    await this.keepSessionAlive(id).catch(() => { });
                }
                const jitterMs = 600 + Math.random() * 900 + attempt * 400;
                console.warn(`[fxsocketClient] OrderModify retry id=${id} ticket=${args.ticket}`
                    + ` attempt=${attempt + 1}/${MAX_ATTEMPTS}: ${msg}`);
                await new Promise(r => setTimeout(r, jitterMs));
            }
        }
        throw lastErr instanceof Error ? lastErr : new FxsocketApiError(String(lastErr), 502);
    }
    async orderModifyOnce(id, args) {
        const payload = { ticket: args.ticket };
        if (args.stoploss != null)
            payload.stopLoss = args.stoploss;
        if (args.takeprofit != null)
            payload.takeProfit = args.takeprofit;
        if (args.price != null)
            payload.price = args.price;
        if (args.expiration)
            payload.expiration = args.expiration;
        const raw = await this.post(`${await this.accountBase(id)}/OrderModify`, payload, 90000);
        assertNoApiError(raw);
        return normalizeOrderResponse(raw);
    }
    async orderClose(id, args) {
        const payload = {
            ticket: args.ticket,
            slippage: args.slippage ?? 20,
        };
        if (args.lots != null && args.lots > 0)
            payload.volume = args.lots;
        if (args.price != null && args.price > 0)
            payload.price = args.price;
        const raw = await this.post(`${await this.accountBase(id)}/OrderClose`, payload, 90000);
        assertNoApiError(raw);
        return normalizeOrderResponse(raw);
    }
}
exports.FxsocketBrokerClient = FxsocketBrokerClient;
let clientSingleton;
function getFxsocketClient() {
    if (clientSingleton !== undefined)
        return clientSingleton;
    try {
        clientSingleton = new FxsocketBrokerClient('MT5');
        return clientSingleton;
    }
    catch {
        clientSingleton = null;
        return null;
    }
}
