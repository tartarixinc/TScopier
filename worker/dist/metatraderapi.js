"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetatraderApiClient = exports.MT_SESSION_EXPIRED_HINT = exports.MetatraderApiError = void 0;
exports.orderOperationRequiresPrice = orderOperationRequiresPrice;
exports.normalizeOrderResponse = normalizeOrderResponse;
exports.normalizeSymbolParams = normalizeSymbolParams;
exports.formatMtApiDateTime = formatMtApiDateTime;
exports.unwrapOrderList = unwrapOrderList;
exports.resolveBasicAuthHeader = resolveBasicAuthHeader;
exports.isMtApiAuthConfigured = isMtApiAuthConfigured;
exports.isCheckConnectOk = isCheckConnectOk;
exports.isMtSessionGoneMessage = isMtSessionGoneMessage;
exports.isBrokerDisconnectedMessage = isBrokerDisconnectedMessage;
exports.isMtSessionGoneError = isMtSessionGoneError;
exports.mtPlatformFrom = mtPlatformFrom;
exports.hasMetatraderApiConfigured = hasMetatraderApiConfigured;
exports.getMetatraderApi = getMetatraderApi;
const undici_1 = require("undici");
const mtTradeFields_1 = require("./mtTradeFields");
/**
 * MetatraderAPI (metatraderapi.dev) Node client tuned for low order-send latency.
 *
 * - Singleton undici Agent keeps TLS-warm pools per platform host (mt4/mt5.mt4api.dev).
 * - Basic Auth; platform-specific paths (OrderSendSafe vs OrderSend). See docs/mt4api-endpoint-map.md.
 */
const DEFAULT_MT5_BASE = 'https://mt5.mt4api.dev';
const DEFAULT_MT4_BASE = 'https://mt4.mt4api.dev';
const MT4API_HTTP_CONNECTIONS = Math.max(8, Math.min(512, Number(process.env.MT4API_HTTP_CONNECTIONS ?? 128)));
const KEEP_ALIVE_AGENT = new undici_1.Agent({
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 600000,
    connections: MT4API_HTTP_CONNECTIONS,
    pipelining: 1,
});
/** Pending / stop entry types require a positive limit/stop price on OrderSend. */
function orderOperationRequiresPrice(operation) {
    return (operation === 'BuyLimit'
        || operation === 'SellLimit'
        || operation === 'BuyStop'
        || operation === 'SellStop'
        || operation === 'BuyStopLimit'
        || operation === 'SellStopLimit');
}
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
 * MetatraderAPI JSON often follows protobuf names: PascalCase on the `Order`
 * object, and `OrderSendReply` wraps the order as `{ result: { ... }, error }`.
 * Normalize to our camelCase `OrderResult` so callers always see `ticket`.
 */
function normalizeOrderResponse(body) {
    if (body == null || typeof body !== 'object') {
        return { ticket: NaN };
    }
    const root = body;
    // OrderSendReply / OrderModifyReply / OrderCloseReply: { result: Order, error?: ... }
    let o = root;
    if ('result' in root && root.result != null && typeof root.result === 'object') {
        o = root.result;
    }
    const ticketRaw = o.ticket ??
        o.Ticket ??
        o.orderId ??
        o.OrderId ??
        nestedTicket(o, 'deal') ??
        nestedTicket(o, 'Deal') ??
        nestedTicket(o, 'DealInternalIn') ??
        nestedTicket(o, 'ex');
    const ticket = typeof ticketRaw === 'number' ? ticketRaw : Number(ticketRaw);
    return {
        ticket: Number.isFinite(ticket) ? ticket : NaN,
        openPrice: num(o.openPrice ?? o.OpenPrice),
        stopLoss: num(o.stopLoss ?? o.StopLoss),
        takeProfit: num(o.takeProfit ?? o.TakeProfit),
        lots: num(o.lots ?? o.Lots ?? o.volume ?? o.Volume),
        symbol: typeof o.symbol === 'string' ? o.symbol : typeof o.Symbol === 'string' ? o.Symbol : undefined,
        orderType: typeof o.orderType === 'string' ? o.orderType : typeof o.OrderType === 'string' ? String(o.OrderType) : undefined,
        state: typeof o.state === 'string' ? o.state : typeof o.State === 'string' ? String(o.State) : undefined,
        closePrice: num(o.closePrice ?? o.ClosePrice),
        profit: num(o.profit ?? o.Profit),
        swap: num(o.swap ?? o.Swap),
        commission: num(o.commission ?? o.Commission),
        fee: num(o.fee ?? o.Fee),
        comment: typeof o.comment === 'string' ? o.comment : typeof o.Comment === 'string' ? o.Comment : undefined,
    };
}
function assertNoApiError(body) {
    if (body == null || typeof body !== 'object')
        return;
    const root = body;
    // Shape A: { error: { message, code } }
    const err = root.error;
    if (err && typeof err === 'object') {
        const e = err;
        const m = String(e.message ?? e.Message ?? '').trim();
        if (m && m !== 'null' && m !== 'undefined') {
            throw new MetatraderApiError(m, 200, e.code != null ? String(e.code) : undefined);
        }
    }
    // Shape B: top-level { message, code, stackTrace } (no `error` wrapper, no `result`).
    // This is what mt5rest returns for things like "Symbol not found".
    if (!('result' in root) && !('ticket' in root) && !('Ticket' in root)) {
        const m = root.message ?? root.Message;
        const code = root.code ?? root.Code;
        if (typeof m === 'string' && m.trim()) {
            // Treat code 'OK' / 'DONE' with a message as still-an-error when there's no order payload.
            throw new MetatraderApiError(m.trim(), 200, code != null ? String(code) : undefined);
        }
    }
}
/**
 * Read a numeric field tolerating camelCase, PascalCase, and snake_case keys.
 * MT5 bridges (and the underlying MqlSymbolInfo struct) ship every casing in
 * the wild, so we accept any of them rather than guess.
 */
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
/** Normalise a /SymbolParams response across the casing variants we've seen. */
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
        minLot: readNum(grp, 'minLot', 'MinLot', 'min_lot', 'volume_min', 'VolumeMin', 'volumeMin'),
        maxLot: readNum(grp, 'maxLot', 'MaxLot', 'max_lot', 'volume_max', 'VolumeMax', 'volumeMax'),
        lotStep: readNum(grp, 'lotStep', 'LotStep', 'lot_step', 'volume_step', 'VolumeStep', 'volumeStep'),
    };
}
class MetatraderApiError extends Error {
    constructor(message, status, code) {
        super(message);
        this.name = 'MetatraderApiError';
        this.status = status;
        this.code = code;
    }
}
exports.MetatraderApiError = MetatraderApiError;
function buildQuery(params) {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '')
            continue;
        out.set(k, String(v));
    }
    return out.toString();
}
/** MetatraderAPI date query format (yyyy-MM-ddTHH:mm:ss). */
function formatMtApiDateTime(d) {
    return d.toISOString().slice(0, 19);
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
/** Strip copy-paste junk from env URLs, e.g. `(https://mt4.mt4api.dev/)` → `https://mt4.mt4api.dev` */
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
        console.warn(`[metatraderapi] invalid base URL "${raw.slice(0, 80)}", using default`);
        return fallback.replace(/\/+$/, '');
    }
}
/** RFC 7617: Authorization: Basic base64(username + ":" + password) */
function basicAuthHeaderFromUserPass(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}
function normalizeAuthorizationHeader(value) {
    const v = value.trim();
    if (!v)
        return '';
    return /^Basic\s+/i.test(v) ? v : `Basic ${v}`;
}
/**
 * Resolve MT API Basic Auth from env. Prefer plain USER + PASSWORD (we base64-encode).
 * Optional: MT4API_BASIC_TOKEN = already-encoded base64(user:pass), or
 * MT4API_AUTHORIZATION = full header value ("Basic …").
 */
function resolveBasicAuthHeader(env) {
    const authorization = trimEnv(env.MT4API_AUTHORIZATION);
    if (authorization)
        return normalizeAuthorizationHeader(authorization);
    const token = trimEnv(env.MT4API_BASIC_TOKEN);
    if (token)
        return normalizeAuthorizationHeader(token);
    const user = trimEnv(env.MT4API_BASIC_USER ?? env.METATRADERAPI_BASIC_USER);
    const password = trimEnv(env.MT4API_BASIC_PASSWORD ?? env.METATRADERAPI_BASIC_PASSWORD);
    if (!user || !password) {
        throw new Error('MT4API_BASIC_USER and MT4API_BASIC_PASSWORD are required (plain text, not base64)');
    }
    return basicAuthHeaderFromUserPass(user, password);
}
function isMtApiAuthConfigured(env = process.env) {
    try {
        resolveBasicAuthHeader(env);
        return true;
    }
    catch {
        return false;
    }
}
/** Interpret /CheckConnect payloads across MT4/MT5 bridge versions. */
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
        if (s === 'true' || s === 'ok' || s === 'connected' || s === 'yes' || s === '1')
            return true;
        if (s === 'false'
            || s === '0'
            || s.includes('not connected')
            || s.includes('disconnected')
            || s.includes('notconnected')) {
            return false;
        }
        return true;
    }
    if (body && typeof body === 'object') {
        const r = body;
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
/** MT bridge no longer holds this session id (restart, expiry, or never connected). */
function isMtSessionGoneMessage(message) {
    const m = message.trim().toLowerCase();
    if (!m)
        return false;
    return (m.includes('client with id')
        || m.includes('client not found')
        || (m.includes('not found') && (m.includes('client') || m.includes('id =')))
        || m.includes('unknown client')
        || m.includes('session not found')
        || m.includes('account not found'));
}
/** OrderSend/CheckConnect rejected because the MT terminal session is offline. */
function isBrokerDisconnectedMessage(message) {
    const m = message.trim().toLowerCase();
    if (!m)
        return false;
    if (isMtSessionGoneMessage(message))
        return true;
    return m.includes('not connected') || m.includes('broker session is not connected');
}
function isMtSessionGoneError(err) {
    if (err instanceof MetatraderApiError)
        return isMtSessionGoneMessage(err.message);
    if (err instanceof Error)
        return isMtSessionGoneMessage(err.message);
    return isMtSessionGoneMessage(String(err));
}
exports.MT_SESSION_EXPIRED_HINT = 'Trading session expired on the broker API. In Account Configuration, use Reconnect and enter your MT password (or remove and link the account again).';
function parseToken(body, fallbackId) {
    if (typeof body === 'string') {
        const t = body.trim().replace(/^"|"$/g, '');
        if (t)
            return t;
    }
    if (body && typeof body === 'object') {
        const o = body;
        const id = o.id ?? o.Id ?? o.token ?? o.Token;
        if (id != null && String(id).trim())
            return String(id).trim();
    }
    return fallbackId;
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
        freeMargin: num(o.freeMargin ?? o.FreeMargin ?? o.marginFree ?? o.MarginFree),
        marginLevel: num(o.marginLevel ?? o.MarginLevel),
        leverage: num(o.leverage ?? o.Leverage),
        currency: typeof o.currency === 'string' ? o.currency : typeof o.Currency === 'string' ? o.Currency : undefined,
    };
}
function pathsFor(platform) {
    if (platform === 'MT5') {
        return {
            orderSend: '/OrderSendSafe',
            orderModify: '/OrderModifySafe',
            orderClose: '/OrderCloseSafe',
            quote: '/GetQuote',
        };
    }
    return {
        orderSend: '/OrderSend',
        orderModify: '/OrderModify',
        orderClose: '/OrderClose',
        quote: '/Quote',
    };
}
function mtPlatformFrom(s) {
    return s === 'MT4' ? 'MT4' : 'MT5';
}
function hasMetatraderApiConfigured() {
    return isMtApiAuthConfigured(process.env);
}
class MetatraderApiClient {
    constructor(platform, authHeader, baseUrl, timeoutMs = 30000) {
        const header = authHeader.trim();
        if (!header) {
            throw new Error('MetatraderApiClient: Authorization header required');
        }
        this.platform = platform;
        const defaultBase = platform === 'MT5' ? DEFAULT_MT5_BASE : DEFAULT_MT4_BASE;
        this.baseUrl = normalizeBaseUrl(baseUrl ?? '', defaultBase);
        this.authHeader = normalizeAuthorizationHeader(header);
        this.timeoutMs = timeoutMs;
        this.paths = pathsFor(platform);
    }
    async get(path, params, timeoutMs) {
        const qs = buildQuery(params);
        const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
        const t = timeoutMs ?? this.timeoutMs;
        const res = await (0, undici_1.request)(url, {
            method: 'GET',
            headers: { Authorization: this.authHeader, accept: 'application/json, text/plain' },
            dispatcher: KEEP_ALIVE_AGENT,
            headersTimeout: t,
            bodyTimeout: t,
        });
        const text = await res.body.text();
        let body = null;
        if (text) {
            try {
                body = JSON.parse(text);
            }
            catch {
                body = text;
            }
        }
        const status = res.statusCode;
        if (status < 200 || status >= 300) {
            const obj = (body && typeof body === 'object') ? body : null;
            const msg = obj?.message ? String(obj.message)
                : obj?.error ? String(obj.error)
                    : text || `HTTP ${status}`;
            const code = obj?.code ? String(obj.code) : undefined;
            throw new MetatraderApiError(msg, status, code);
        }
        return body;
    }
    async connectEx(args) {
        const userNum = Number(args.login);
        if (!Number.isFinite(userNum)) {
            throw new MetatraderApiError('Invalid MT login number', 400);
        }
        const raw = await this.get('/ConnectEx', {
            id: args.id,
            user: userNum,
            password: args.password,
            server: args.server,
        });
        return parseToken(raw, args.id);
    }
    async connectByToken(id) {
        const raw = await this.get('/ConnectByToken', { id });
        assertNoApiError(raw);
    }
    async ensureConnected(id) {
        const alive = await this.keepSessionAlive(id);
        if (!alive)
            throw new MetatraderApiError('Broker session is not connected', 502);
    }
    /**
     * Ping session; call ConnectByToken only when the session exists but CheckConnect
     * failed for a transient reason. When the bridge reports "client not found",
     * ConnectByToken cannot recreate the session — user must ConnectEx with password.
     */
    async keepSessionAlive(id) {
        try {
            await this.checkConnect(id);
            return true;
        }
        catch (first) {
            if (isMtSessionGoneError(first)) {
                console.warn(`[metatraderapi] MT session gone id=${id} — ${exports.MT_SESSION_EXPIRED_HINT}`);
                return false;
            }
            const msg = first instanceof Error ? first.message : String(first);
            console.warn(`[metatraderapi] CheckConnect failed id=${id}: ${msg}; trying ConnectByToken`);
        }
        try {
            await this.connectByToken(id);
            await this.checkConnect(id);
            return true;
        }
        catch (second) {
            if (isMtSessionGoneError(second)) {
                console.warn(`[metatraderapi] MT session gone id=${id} (ConnectByToken) — ${exports.MT_SESSION_EXPIRED_HINT}`);
                return false;
            }
            const msg = second instanceof Error ? second.message : String(second);
            console.warn(`[metatraderapi] keepSessionAlive failed id=${id}: ${msg}`);
            return false;
        }
    }
    /**
     * CheckConnect alone can report "connected" while OrderSend still fails with
     * "Not connected (:login)". Confirm the terminal can serve trading APIs.
     */
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
            console.warn(`[metatraderapi] verifyTradingReady failed id=${id}: ${msg}`);
            return false;
        }
    }
    async disconnect(id) {
        await this.get('/Disconnect', { id });
    }
    async openedOrders(id) {
        const raw = await this.get('/OpenedOrders', { id });
        assertNoApiError(raw);
        return unwrapOrderList(raw);
    }
    /** Last ~100 closed orders in the current session only (see GET /ClosedOrders). */
    async closedOrders(id) {
        const raw = await this.get('/ClosedOrders', { id });
        assertNoApiError(raw);
        return unwrapOrderList(raw);
    }
    async orderHistory(id, from, to) {
        const raw = await this.get('/OrderHistory', { id, from, to });
        assertNoApiError(raw);
        return unwrapOrderList(raw);
    }
    async historyPositions(id, from, to) {
        const raw = await this.get('/HistoryPositions', { id, from, to });
        assertNoApiError(raw);
        return unwrapOrderList(raw);
    }
    async orderHistoryPage(id, from, to, pageNumber, ordersPerPage = 500) {
        const raw = await this.get('/OrderHistoryPagination', {
            id,
            from,
            to,
            pageNumber,
            ordersPerPage,
        });
        assertNoApiError(raw);
        if (raw && typeof raw === 'object') {
            const root = raw;
            const result = root.result ?? root.Result;
            if (result && typeof result === 'object') {
                const pr = result;
                const orders = pr.Orders ?? pr.orders;
                return {
                    orders: Array.isArray(orders) ? orders : [],
                    pagesCount: Number(pr.PagesCount ?? pr.pagesCount ?? 1) || 1,
                };
            }
        }
        return { orders: unwrapOrderList(raw), pagesCount: 1 };
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
    async accountSummary(id) {
        const raw = await this.get('/AccountSummary', { id });
        assertNoApiError(raw);
        return normalizeAccountSummary(raw);
    }
    async checkConnect(id) {
        const checkTimeoutMs = Math.max(500, Math.min(5000, Number(process.env.MT4API_CHECK_CONNECT_TIMEOUT_MS ?? 1500)));
        const raw = await this.get('/CheckConnect', { id }, checkTimeoutMs);
        assertNoApiError(raw);
        if (!isCheckConnectOk(raw)) {
            throw new MetatraderApiError('Broker session is not connected', 502);
        }
    }
    symbolParams(id, symbol) {
        return this.get('/SymbolParams', { id, symbol });
    }
    /** Returns the broker's full instrument list. Some servers return string[], others SymbolInfo[]. */
    symbols(id) {
        return this.get('/Symbols', { id });
    }
    /**
     * Live bid/ask quote for a symbol. The MetatraderAPI proto names the fields
     * Bid/Ask/Time in PascalCase; some server builds also return camelCase. Normalise
     * both shapes here so callers always see `{ symbol, bid, ask, time }`.
     */
    async quote(id, symbol) {
        // Endpoint name in the API2Trade / metatraderapi.dev REST surface is
        // `/GetQuote` (not `/Quote`). Calling `/Quote` returns HTTP 404 and breaks
        // anchor resolution for averaging-down ladders that don't carry an
        // explicit signal entry price.
        const raw = await this.get(this.paths.quote, { id, symbol });
        assertNoApiError(raw);
        const root = (raw && typeof raw === 'object') ? raw : {};
        const r = (root.result && typeof root.result === 'object') ? root.result : root;
        const bid = num(r.bid ?? r.Bid);
        const ask = num(r.ask ?? r.Ask);
        const time = typeof r.time === 'string' ? r.time : typeof r.Time === 'string' ? r.Time : undefined;
        if (bid == null || ask == null || bid <= 0 || ask <= 0) {
            throw new MetatraderApiError(`Quote: invalid bid/ask for ${symbol} (bid=${String(r.Bid ?? r.bid)} ask=${String(r.Ask ?? r.ask)})`, 200);
        }
        return {
            symbol: typeof r.symbol === 'string' ? r.symbol : typeof r.Symbol === 'string' ? r.Symbol : symbol,
            bid,
            ask,
            time,
        };
    }
    async orderSend(id, args) {
        const op = String(args.operation);
        const px = Number(args.price);
        if (orderOperationRequiresPrice(op) && (!Number.isFinite(px) || px <= 0)) {
            throw new MetatraderApiError(`OrderSend: ${op} requires a positive price (got ${String(args.price)}); refusing to send price=0 to MetatraderAPI`, 400);
        }
        const raw = await this.get(this.paths.orderSend, {
            id,
            symbol: args.symbol,
            operation: args.operation,
            volume: args.volume,
            price: Number.isFinite(px) ? px : 0,
            slippage: args.slippage ?? 20,
            stoploss: args.stoploss ?? 0,
            takeprofit: args.takeprofit ?? 0,
            comment: args.comment,
            expertID: args.expertID ?? 0,
            expiration: args.expiration,
            expirationType: args.expirationType,
        });
        assertNoApiError(raw);
        const out = normalizeOrderResponse(raw);
        if (!Number.isFinite(out.ticket) || out.ticket <= 0) {
            const preview = typeof raw === 'object' && raw !== null ? JSON.stringify(raw).slice(0, 500) : String(raw);
            throw new MetatraderApiError(`OrderSend returned no ticket (response: ${preview})`, 200);
        }
        return out;
    }
    async orderModify(id, args) {
        const raw = await this.get(this.paths.orderModify, {
            id,
            ticket: args.ticket,
            stoploss: args.stoploss ?? 0,
            takeprofit: args.takeprofit ?? 0,
            price: args.price ?? 0,
            expiration: args.expiration,
            expirationType: args.expirationType,
        });
        assertNoApiError(raw);
        return normalizeOrderResponse(raw);
    }
    async orderClose(id, args) {
        const raw = await this.get(this.paths.orderClose, {
            id,
            ticket: args.ticket,
            lots: args.lots ?? 0,
            price: args.price ?? 0,
            slippage: args.slippage ?? 20,
        });
        assertNoApiError(raw);
        return normalizeOrderResponse(raw);
    }
}
exports.MetatraderApiClient = MetatraderApiClient;
const clientCache = new Map();
function getMetatraderApi(platform = 'MT5') {
    if (clientCache.has(platform))
        return clientCache.get(platform) ?? null;
    let authHeader;
    try {
        authHeader = resolveBasicAuthHeader(process.env);
    }
    catch {
        clientCache.set(platform, null);
        return null;
    }
    const defaultBase = platform === 'MT5' ? DEFAULT_MT5_BASE : DEFAULT_MT4_BASE;
    const rawBase = platform === 'MT5'
        ? trimEnv(process.env.MT4API_MT5_BASE_URL)
        : trimEnv(process.env.MT4API_MT4_BASE_URL);
    const baseUrl = normalizeBaseUrl(rawBase, defaultBase);
    const client = new MetatraderApiClient(platform, authHeader, baseUrl);
    clientCache.set(platform, client);
    return client;
}
