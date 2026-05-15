"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetatraderApiClient = exports.MetatraderApiError = void 0;
exports.orderOperationRequiresPrice = orderOperationRequiresPrice;
exports.normalizeOrderResponse = normalizeOrderResponse;
exports.normalizeSymbolParams = normalizeSymbolParams;
exports.mtPlatformFrom = mtPlatformFrom;
exports.hasMetatraderApiConfigured = hasMetatraderApiConfigured;
exports.getMetatraderApi = getMetatraderApi;
const undici_1 = require("undici");
/**
 * MetatraderAPI (metatraderapi.dev) Node client tuned for low order-send latency.
 *
 * - Singleton undici Agent keeps TLS-warm pools per platform host (mt4/mt5.mt4api.dev).
 * - Basic Auth; platform-specific paths (OrderSendSafe vs OrderSend). See docs/mt4api-endpoint-map.md.
 */
const DEFAULT_MT5_BASE = 'https://mt5.mt4api.dev';
const DEFAULT_MT4_BASE = 'https://mt4.mt4api.dev';
const KEEP_ALIVE_AGENT = new undici_1.Agent({
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 600000,
    connections: 32,
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
function basicAuthHeader(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}
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
    const user = process.env.MT4API_BASIC_USER?.trim() ?? '';
    const pass = process.env.MT4API_BASIC_PASSWORD?.trim() ?? '';
    return Boolean(user && pass);
}
class MetatraderApiClient {
    constructor(platform, basicUser, basicPassword, baseUrl, timeoutMs = 30000) {
        if (!basicUser || !basicPassword) {
            throw new Error('MetatraderApiClient: Basic Auth credentials required');
        }
        this.platform = platform;
        const defaultBase = platform === 'MT5' ? DEFAULT_MT5_BASE : DEFAULT_MT4_BASE;
        this.baseUrl = (baseUrl ?? defaultBase).replace(/\/+$/, '');
        this.authHeader = basicAuthHeader(basicUser, basicPassword);
        this.timeoutMs = timeoutMs;
        this.paths = pathsFor(platform);
    }
    async get(path, params) {
        const qs = buildQuery(params);
        const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
        const res = await (0, undici_1.request)(url, {
            method: 'GET',
            headers: { Authorization: this.authHeader, accept: 'application/json, text/plain' },
            dispatcher: KEEP_ALIVE_AGENT,
            headersTimeout: this.timeoutMs,
            bodyTimeout: this.timeoutMs,
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
        await this.get('/ConnectByToken', { id });
    }
    async ensureConnected(id) {
        try {
            await this.checkConnect(id);
            return;
        }
        catch {
            /* reconnect */
        }
        await this.connectByToken(id);
    }
    async disconnect(id) {
        await this.get('/Disconnect', { id });
    }
    openedOrders(id) {
        return this.get('/OpenedOrders', { id });
    }
    /** Recent closed deals / history (see docs: GET /ClosedOrders). */
    closedOrders(id) {
        return this.get('/ClosedOrders', { id });
    }
    async accountSummary(id) {
        const raw = await this.get('/AccountSummary', { id });
        assertNoApiError(raw);
        return normalizeAccountSummary(raw);
    }
    checkConnect(id) {
        return this.get('/CheckConnect', { id });
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
    const user = process.env.MT4API_BASIC_USER?.trim() ?? '';
    const password = process.env.MT4API_BASIC_PASSWORD?.trim() ?? '';
    if (!user || !password) {
        clientCache.set(platform, null);
        return null;
    }
    const baseUrl = platform === 'MT5'
        ? (process.env.MT4API_MT5_BASE_URL?.trim() || DEFAULT_MT5_BASE)
        : (process.env.MT4API_MT4_BASE_URL?.trim() || DEFAULT_MT4_BASE);
    const client = new MetatraderApiClient(platform, user, password, baseUrl);
    clientCache.set(platform, client);
    return client;
}
