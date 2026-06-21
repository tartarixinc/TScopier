"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSubscriptionActive = isSubscriptionActive;
exports.effectivePlan = effectivePlan;
exports.manualSettingsUseAdvancedFeatures = manualSettingsUseAdvancedFeatures;
function isSubscriptionActive(status) {
    return status === 'active' || status === 'trialing';
}
function effectivePlan(plan, status) {
    if (!isSubscriptionActive(status))
        return null;
    return plan ?? null;
}
function manualSettingsUseAdvancedFeatures(settings) {
    if (settings.trade_style === 'multi')
        return true;
    if (settings.range_trading === true)
        return true;
    if (settings.reverse_signal === true)
        return true;
    if (settings.close_worse_entries === true)
        return true;
    const beMode = String(settings.move_sl_to_entry_after_mode ?? 'none');
    if (beMode !== 'none' && beMode !== '')
        return true;
    if (settings.rr_for_sl_enabled === true || settings.rr_for_tps_enabled === true)
        return true;
    return false;
}
