"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findActiveNewsBlackout = findActiveNewsBlackout;
exports.findPreNewsCloseTriggers = findPreNewsCloseTriggers;
const settings_1 = require("./settings");
const symbolCurrencies_1 = require("./symbolCurrencies");
function eventTimeMs(event) {
    const t = Date.parse(event.datetime);
    return Number.isFinite(t) ? t : null;
}
/** True when `now` is inside a news blackout for this symbol and manual filter settings. */
function findActiveNewsBlackout(events, manual, symbol, now = new Date()) {
    if ((0, settings_1.isNewsTradingEnabled)(manual))
        return null;
    const avoid = new Set((0, settings_1.getNewsAvoidImpacts)(manual));
    const beforeMs = (0, settings_1.getCloseBeforeNewsMinutes)(manual) * 60000;
    const afterMs = (0, settings_1.getResumeAfterNewsMinutes)(manual) * 60000;
    const nowMs = now.getTime();
    let best = null;
    for (const event of events) {
        if (!avoid.has(event.impact))
            continue;
        if (!(0, symbolCurrencies_1.eventMatchesSymbol)(event, symbol))
            continue;
        const eventMs = eventTimeMs(event);
        if (eventMs == null)
            continue;
        const windowStartMs = eventMs - beforeMs;
        const windowEndMs = eventMs + afterMs;
        if (nowMs < windowStartMs || nowMs > windowEndMs)
            continue;
        const phase = nowMs < eventMs ? 'pre' : 'post';
        const candidate = { event, phase, windowStartMs, windowEndMs };
        if (!best || eventMs < eventTimeMs(best.event)) {
            best = candidate;
        }
    }
    return best;
}
/** Events entering the pre-news close window (for the monitor to flatten positions). */
function findPreNewsCloseTriggers(events, manual, now = new Date()) {
    if ((0, settings_1.isNewsTradingEnabled)(manual))
        return [];
    const avoid = new Set((0, settings_1.getNewsAvoidImpacts)(manual));
    const beforeMs = (0, settings_1.getCloseBeforeNewsMinutes)(manual) * 60000;
    const nowMs = now.getTime();
    const out = [];
    for (const event of events) {
        if (!avoid.has(event.impact))
            continue;
        const eventMs = eventTimeMs(event);
        if (eventMs == null)
            continue;
        const windowStartMs = eventMs - beforeMs;
        if (nowMs >= windowStartMs && nowMs < eventMs)
            out.push(event);
    }
    return out;
}
