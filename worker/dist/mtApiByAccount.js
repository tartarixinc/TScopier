"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPlatformByMetaapiId = loadPlatformByMetaapiId;
exports.apiForMetaapiAccount = apiForMetaapiAccount;
const metatraderapi_1 = require("./metatraderapi");
/** Resolve MT4/MT5 host per stored session id (metaapi_account_id). */
async function loadPlatformByMetaapiId(supabase, metaapiIds) {
    const out = new Map();
    const ids = [...new Set(metaapiIds.filter(id => id && !id.includes('|')))];
    if (!ids.length)
        return out;
    const { data, error } = await supabase
        .from('broker_accounts')
        .select('metaapi_account_id,platform')
        .in('metaapi_account_id', ids);
    if (error) {
        console.warn(`[mtApi] broker platform lookup failed: ${error.message}`);
        return out;
    }
    for (const row of data ?? []) {
        const id = String(row.metaapi_account_id ?? '').trim();
        if (!id)
            continue;
        out.set(id, (0, metatraderapi_1.mtPlatformFrom)(row.platform));
    }
    return out;
}
function apiForMetaapiAccount(platformById, metaapiAccountId) {
    return (0, metatraderapi_1.getMetatraderApi)(platformById.get(metaapiAccountId) ?? 'MT5');
}
