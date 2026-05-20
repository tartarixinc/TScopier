"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeBrokerConnectionStatus = writeBrokerConnectionStatus;
exports.clearBrokerConnectionStatusCache = clearBrokerConnectionStatusCache;
const MIN_WRITE_INTERVAL_MS = Math.max(30000, Number(process.env.BROKER_CONNECTION_STATUS_MIN_WRITE_MS ?? 60000));
const lastWritten = new Map();
/**
 * Debounced broker connection_status writer — worker is the sole DB writer.
 * Skips no-op updates and enforces a minimum interval per broker id.
 */
async function writeBrokerConnectionStatus(supabase, brokerId, status) {
    const now = Date.now();
    const prev = lastWritten.get(brokerId);
    if (prev?.status === status && now - prev.at < MIN_WRITE_INTERVAL_MS)
        return;
    const { error } = await supabase
        .from('broker_accounts')
        .update({ connection_status: status })
        .eq('id', brokerId);
    if (error) {
        console.warn(`[brokerConnectionStatus] update failed broker=${brokerId}:`, error.message);
        return;
    }
    lastWritten.set(brokerId, { status, at: now });
}
function clearBrokerConnectionStatusCache(brokerId) {
    if (brokerId)
        lastWritten.delete(brokerId);
    else
        lastWritten.clear();
}
