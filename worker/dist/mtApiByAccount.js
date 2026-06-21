"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiForMetaapiAccount = exports.loadPlatformByMetaapiId = void 0;
exports.brokerSessionId = brokerSessionId;
exports.loadPlatformByFxsocketId = loadPlatformByFxsocketId;
exports.apiForFxsocketAccount = apiForFxsocketAccount;
const fxsocketClient_1 = require("./fxsocketClient");
/** Resolve broker session id (FxSocket terminal UUID). */
function brokerSessionId(row) {
    const fx = String(row.fxsocket_account_id ?? '').trim();
    if (fx && !fx.includes('|'))
        return fx;
    const legacy = String(row.metaapi_account_id ?? '').trim();
    if (legacy && !legacy.includes('|'))
        return legacy;
    return '';
}
async function loadPlatformByFxsocketId(supabase, sessionIds) {
    const out = new Map();
    const ids = [...new Set(sessionIds.filter(id => id && !id.includes('|')))];
    if (!ids.length)
        return out;
    const { data, error } = await supabase
        .from('broker_accounts')
        .select('fxsocket_account_id,metaapi_account_id,platform')
        .or(`fxsocket_account_id.in.(${ids.join(',')}),metaapi_account_id.in.(${ids.join(',')})`);
    if (error) {
        console.warn(`[fxApi] broker platform lookup failed: ${error.message}`);
        return out;
    }
    for (const row of data ?? []) {
        const id = brokerSessionId(row);
        if (!id)
            continue;
        out.set(id, (0, fxsocketClient_1.mtPlatformFrom)(row.platform));
    }
    return out;
}
/** @deprecated use loadPlatformByFxsocketId */
exports.loadPlatformByMetaapiId = loadPlatformByFxsocketId;
function apiForFxsocketAccount(_platformById, sessionId) {
    if (!sessionId || sessionId.includes('|'))
        return null;
    return (0, fxsocketClient_1.getFxsocketClient)();
}
/** @deprecated use apiForFxsocketAccount */
exports.apiForMetaapiAccount = apiForFxsocketAccount;
