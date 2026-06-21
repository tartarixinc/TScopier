"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUserCopierPausedCached = isUserCopierPausedCached;
exports.setUserCopierPausedCached = setUserCopierPausedCached;
exports.invalidateCopierPauseCache = invalidateCopierPauseCache;
exports.loadCachedUserCopierPaused = loadCachedUserCopierPaused;
exports.primeCopierPauseCache = primeCopierPauseCache;
exports.noteCopierPaused = noteCopierPaused;
exports.noteCopierResumed = noteCopierResumed;
exports.getCopierResumedAt = getCopierResumedAt;
exports.signalPredatesCopierResume = signalPredatesCopierResume;
exports.applyCopierPauseProfileUpdate = applyCopierPauseProfileUpdate;
const CACHE_TTL_MS = 60000;
const cache = new Map();
/** Signals with created_at before this timestamp are ignored after a resume (pause-window backlog). */
const resumedAtByUser = new Map();
function isUserCopierPausedCached(userId) {
    const hit = cache.get(userId);
    if (hit && hit.expiresAt > Date.now())
        return hit.paused;
    return false;
}
function setUserCopierPausedCached(userId, paused) {
    cache.set(userId, { paused, expiresAt: Date.now() + CACHE_TTL_MS });
}
function invalidateCopierPauseCache(userId) {
    if (userId) {
        cache.delete(userId);
        return;
    }
    cache.clear();
}
async function loadCachedUserCopierPaused(supabase, userId) {
    const hit = cache.get(userId);
    if (hit && hit.expiresAt > Date.now())
        return hit.paused;
    const { data, error } = await supabase
        .from('user_profiles')
        .select('copier_paused')
        .eq('user_id', userId)
        .maybeSingle();
    const paused = !error && data?.copier_paused === true;
    cache.set(userId, { paused, expiresAt: Date.now() + CACHE_TTL_MS });
    return paused;
}
/** Prime cache from a batch profile load (e.g. loadBrokers). */
function primeCopierPauseCache(profiles) {
    for (const p of profiles) {
        const uid = String(p.user_id ?? '');
        if (!uid)
            continue;
        setUserCopierPausedCached(uid, p.copier_paused === true);
    }
}
function noteCopierPaused(userId) {
    resumedAtByUser.delete(userId);
    setUserCopierPausedCached(userId, true);
}
function noteCopierResumed(userId) {
    resumedAtByUser.set(userId, Date.now());
    setUserCopierPausedCached(userId, false);
}
function getCopierResumedAt(userId) {
    return resumedAtByUser.get(userId) ?? null;
}
function signalPredatesCopierResume(userId, createdAt) {
    const resumedAt = getCopierResumedAt(userId);
    if (resumedAt == null)
        return false;
    const createdMs = Date.parse(String(createdAt ?? ''));
    if (!Number.isFinite(createdMs))
        return false;
    return createdMs < resumedAt;
}
/** Apply a user_profiles copier_paused transition to in-memory worker state. */
function applyCopierPauseProfileUpdate(userId, copierPaused, previousPaused) {
    invalidateCopierPauseCache(userId);
    if (copierPaused) {
        if (previousPaused === true) {
            setUserCopierPausedCached(userId, true);
            return 'unchanged';
        }
        noteCopierPaused(userId);
        return 'paused';
    }
    if (previousPaused === true) {
        noteCopierResumed(userId);
        return 'resumed';
    }
    setUserCopierPausedCached(userId, false);
    return 'unchanged';
}
