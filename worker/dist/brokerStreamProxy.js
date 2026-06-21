"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachBrokerStreamProxy = attachBrokerStreamProxy;
const ws_1 = require("ws");
const mtApiByAccount_1 = require("./mtApiByAccount");
const fxsocketClient_1 = require("./fxsocketClient");
const DEFAULT_SUBSCRIPTIONS = [
    { topic: 'account' },
    { topic: 'positions' },
    { topic: 'trades' },
    { topic: 'terminal' },
];
function parseUrlQuery(url) {
    const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    return new URLSearchParams(q);
}
async function verifyUserToken(supabase, token) {
    if (!token)
        return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user?.id)
        return null;
    return data.user.id;
}
async function loadOwnedBroker(supabase, userId, brokerAccountId) {
    const { data, error } = await supabase
        .from('broker_accounts')
        .select('fxsocket_account_id,metaapi_account_id,platform')
        .eq('id', brokerAccountId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error || !data)
        return null;
    const sessionId = (0, mtApiByAccount_1.brokerSessionId)(data);
    if (!sessionId)
        return null;
    return data;
}
/**
 * JWT-gated WebSocket proxy: browser → worker → FxSocket upstream.
 * Path: GET /broker/stream?broker_account_id=…&token=… (or Authorization: Bearer)
 */
function attachBrokerStreamProxy(server, supabase, streamManager) {
    const wss = new ws_1.WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path !== '/broker/stream')
            return;
        void (async () => {
            try {
                const params = parseUrlQuery(req.url ?? '');
                const brokerAccountId = params.get('broker_account_id')?.trim() ?? '';
                const token = params.get('token')?.trim()
                    ?? req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()
                    ?? '';
                if (!brokerAccountId || !token) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                const userId = await verifyUserToken(supabase, token);
                if (!userId) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                const broker = await loadOwnedBroker(supabase, userId, brokerAccountId);
                if (!broker) {
                    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                    socket.destroy();
                    return;
                }
                const sessionId = (0, mtApiByAccount_1.brokerSessionId)(broker);
                const platform = (0, fxsocketClient_1.mtPlatformFrom)(broker.platform);
                wss.handleUpgrade(req, socket, head, (clientWs) => {
                    void handleClientConnection(clientWs, sessionId, streamManager, platform);
                });
            }
            catch (err) {
                console.warn('[brokerStreamProxy] upgrade failed:', err instanceof Error ? err.message : err);
                socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                socket.destroy();
            }
        })();
    });
}
function handleClientConnection(clientWs, sessionId, streamManager, platform) {
    const relay = (msg) => {
        if (clientWs.readyState !== ws_1.WebSocket.OPEN)
            return;
        try {
            clientWs.send(JSON.stringify(msg));
        }
        catch {
            /* ignore */
        }
    };
    const unsub = streamManager.subscribe(sessionId, relay, DEFAULT_SUBSCRIPTIONS, platform);
    clientWs.on('message', (raw) => {
        try {
            const frame = JSON.parse(String(raw));
            const action = String(frame.action ?? '');
            if (action === 'subscribe' || action === 'unsubscribe') {
                const topic = String(frame.topic ?? '');
                const sub = {
                    topic,
                    symbol: frame.symbol != null ? String(frame.symbol) : undefined,
                    timeframe: frame.timeframe != null ? String(frame.timeframe) : undefined,
                };
                if (action === 'subscribe') {
                    streamManager.ensureTopic(sessionId, sub);
                }
            }
        }
        catch {
            /* ignore malformed client frames */
        }
    });
    clientWs.on('close', () => {
        unsub();
    });
    clientWs.on('error', () => {
        unsub();
    });
}
