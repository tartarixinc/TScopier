"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.manualSettingsUseAdvancedFeatures = exports.effectivePlan = exports.isSubscriptionActive = void 0;
exports.loadCachedUserSubscription = loadCachedUserSubscription;
exports.loadCachedUserIsAdmin = loadCachedUserIsAdmin;
exports.brokerManualSettingsUseAdvancedFeatures = brokerManualSettingsUseAdvancedFeatures;
exports.subscriptionBlocksSignalExecution = subscriptionBlocksSignalExecution;
const planLimits_1 = require("./planLimits");
Object.defineProperty(exports, "effectivePlan", { enumerable: true, get: function () { return planLimits_1.effectivePlan; } });
Object.defineProperty(exports, "isSubscriptionActive", { enumerable: true, get: function () { return planLimits_1.isSubscriptionActive; } });
Object.defineProperty(exports, "manualSettingsUseAdvancedFeatures", { enumerable: true, get: function () { return planLimits_1.manualSettingsUseAdvancedFeatures; } });
const adminAccess_1 = require("./adminAccess");
const CACHE_TTL_MS = 60000;
const cache = new Map();
const adminCache = new Map();
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
function adminUserIdsFromEnv() {
    const raw = process.env.TSCOPIER_ADMIN_USER_IDS ?? '';
    return new Set(raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean));
}
async function loadCachedUserIsAdmin(supabase, userId) {
    const hit = adminCache.get(userId);
    if (hit && hit.expiresAt > Date.now())
        return hit.isAdmin;
    let isAdmin = adminUserIdsFromEnv().has(userId);
    if (!isAdmin) {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('is_admin, admin_until')
            .eq('user_id', userId)
            .maybeSingle();
        if (!error && (0, adminAccess_1.isAdminAccessActive)(data))
            isAdmin = true;
    }
    if (!isAdmin) {
        try {
            const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(userId);
            if (!authErr && authData?.user) {
                const meta = authData.user.app_metadata ?? {};
                if (meta.is_admin === true || meta.role === 'admin')
                    isAdmin = true;
            }
        }
        catch {
            /* best-effort */
        }
    }
    adminCache.set(userId, { isAdmin, expiresAt: Date.now() + CACHE_TTL_MS });
    return isAdmin;
}
function brokerManualSettingsUseAdvancedFeatures(manualSettings) {
    if (!manualSettings || typeof manualSettings !== 'object')
        return false;
    return (0, planLimits_1.manualSettingsUseAdvancedFeatures)(manualSettings);
}
function subscriptionBlocksSignalExecution(sub, manualSettings, isAdmin = false) {
    if (isAdmin)
        return null;
    if (!(0, planLimits_1.isSubscriptionActive)(sub?.status))
        return 'subscription_inactive';
    const plan = (0, planLimits_1.effectivePlan)(sub?.plan, sub?.status);
    if (plan === 'basic' && brokerManualSettingsUseAdvancedFeatures(manualSettings)) {
        return 'plan_advanced_feature_required';
    }
    return null;
}
