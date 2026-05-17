"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isNewsTradingEnabled = isNewsTradingEnabled;
exports.getNewsAvoidImpacts = getNewsAvoidImpacts;
exports.getCloseBeforeNewsMinutes = getCloseBeforeNewsMinutes;
exports.getResumeAfterNewsMinutes = getResumeAfterNewsMinutes;
function isNewsTradingEnabled(manual) {
    if (manual.news_trading_enabled === true)
        return true;
    if (manual.news_trading_enabled === false)
        return false;
    return manual.allow_high_impact_news === true;
}
function getNewsAvoidImpacts(manual) {
    const raw = manual.news_avoid_impacts;
    if (Array.isArray(raw) && raw.length > 0) {
        return raw.filter((i) => i === 'high' || i === 'medium' || i === 'low');
    }
    return ['high'];
}
function getCloseBeforeNewsMinutes(manual) {
    const n = Number(manual.close_before_news_minutes ?? 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(24 * 60, Math.floor(n)) : 10;
}
function getResumeAfterNewsMinutes(manual) {
    const n = Number(manual.resume_after_news_minutes ?? 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(24 * 60, Math.floor(n)) : 10;
}
