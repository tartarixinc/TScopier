"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.manualSettingsUseAdvancedFeatures = exports.effectivePlan = exports.isSubscriptionActive = void 0;
exports.loadCachedUserSubscription = loadCachedUserSubscription;
exports.brokerManualSettingsUseAdvancedFeatures = brokerManualSettingsUseAdvancedFeatures;
exports.subscriptionBlocksSignalExecution = subscriptionBlocksSignalExecution;
const planLimits_1 = require("./planLimits");
Object.defineProperty(exports, "effectivePlan", { enumerable: true, get: function () { return planLimits_1.effectivePlan; } });
Object.defineProperty(exports, "isSubscriptionActive", { enumerable: true, get: function () { return planLimits_1.isSubscriptionActive; } });
Object.defineProperty(exports, "manualSettingsUseAdvancedFeatures", { enumerable: true, get: function () { return planLimits_1.manualSettingsUseAdvancedFeatures; } });
const CACHE_TTL_MS = 60000;
const cache = new Map();
async function loadCachedUserSubscription(supabase, userId) {
    const hit = cache.get(userId);
    if (hit && hit.expiresAt > Date.now())
        return hit.row;
    const { data } = await supabase
        .from('subscriptions')
        .select('plan,status,extra_accounts')
        .eq('user_id', userId)
        .maybeSingle();
    const row = data ?? null;
    cache.set(userId, { row, expiresAt: Date.now() + CACHE_TTL_MS });
    return row;
}
function brokerManualSettingsUseAdvancedFeatures(manualSettings) {
    if (!manualSettings || typeof manualSettings !== 'object')
        return false;
    return (0, planLimits_1.manualSettingsUseAdvancedFeatures)(manualSettings);
}
function subscriptionBlocksSignalExecution(sub, manualSettings) {
    if (!(0, planLimits_1.isSubscriptionActive)(sub?.status))
        return 'subscription_inactive';
    const plan = (0, planLimits_1.effectivePlan)(sub?.plan, sub?.status);
    if (plan === 'basic' && brokerManualSettingsUseAdvancedFeatures(manualSettings)) {
        return 'plan_advanced_feature_required';
    }
    return null;
}
