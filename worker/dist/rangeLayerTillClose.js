"use strict";
/**
 * Per-channel "layer till close" — keep virtual range pendings active until the
 * whole basket is flat (ON), or freeze layering after first TP/CWE close (OFF).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRangeLayerTillCloseEnabled = isRangeLayerTillCloseEnabled;
exports.loadRangeLayerTillCloseForSignal = loadRangeLayerTillCloseForSignal;
exports.freezeRangeLayeringForBasket = freezeRangeLayeringForBasket;
exports.stopRangeLayeringUnlessEnabled = stopRangeLayeringUnlessEnabled;
const channelTradingConfig_1 = require("./channelTradingConfig");
const rangePendingLegDelete_1 = require("./rangePendingLegDelete");
const rangePendingFireGuard_1 = require("./rangePendingFireGuard");
function isRangeLayerTillCloseEnabled(settings) {
    if (!settings || typeof settings !== 'object')
        return false;
    return settings.range_layer_till_close === true;
}
async function loadRangeLayerTillCloseForSignal(supabase, signalId, brokerAccountId) {
    const { data: signal, error: signalErr } = await supabase
        .from('signals')
        .select('channel_id')
        .eq('id', signalId)
        .maybeSingle();
    if (signalErr) {
        console.warn(`[rangeLayerTillClose] signal lookup failed signal=${signalId}: ${signalErr.message}`);
        return false;
    }
    const { data: broker, error: brokerErr } = await supabase
        .from('broker_accounts')
        .select('manual_settings, channel_trading_configs, copier_mode, ai_settings, signal_channel_ids')
        .eq('id', brokerAccountId)
        .maybeSingle();
    if (brokerErr || !broker) {
        console.warn(`[rangeLayerTillClose] broker lookup failed broker=${brokerAccountId}: ${brokerErr?.message ?? 'missing'}`);
        return false;
    }
    const channelId = signal?.channel_id ?? null;
    const resolved = (0, channelTradingConfig_1.resolveChannelTradingConfig)(broker, channelId);
    return isRangeLayerTillCloseEnabled(resolved.manual_settings);
}
/** Delete active pendings and set basket lock (layering stopped). */
async function freezeRangeLayeringForBasket(supabase, scope, reason = 'layering_stopped') {
    if (!scope.userId)
        return;
    await (0, rangePendingFireGuard_1.setTpTouchedLock)(supabase, {
        signalId: scope.signalId,
        brokerAccountId: scope.brokerAccountId,
        symbol: scope.symbol,
        userId: scope.userId,
        lockReason: reason,
    });
}
/**
 * When layer till close is OFF: delete pending legs and freeze further layering.
 * When ON: no-op.
 */
async function stopRangeLayeringUnlessEnabled(supabase, scope, reason) {
    const layerTillClose = await loadRangeLayerTillCloseForSignal(supabase, scope.signalId, scope.brokerAccountId);
    if (layerTillClose)
        return { stopped: false, deleted: 0 };
    const openCount = await (0, rangePendingFireGuard_1.countOpenTradesForBasket)(supabase, scope.signalId, scope.brokerAccountId);
    if (openCount <= 0)
        return { stopped: false, deleted: 0 };
    const deleted = await (0, rangePendingLegDelete_1.deleteRangePendingLegsForBasket)(supabase, { signalId: scope.signalId, brokerAccountId: scope.brokerAccountId }, reason);
    await freezeRangeLayeringForBasket(supabase, scope, reason);
    return { stopped: true, deleted };
}
