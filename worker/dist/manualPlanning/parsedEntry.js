"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SKIP_REASON_SIGNAL_ENTRY_RANGE_EXPIRED = exports.SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED = exports.SKIP_REASON_SIGNAL_ENTRY_REQUIRED = void 0;
exports.resolvedParsedEntryPrice = resolvedParsedEntryPrice;
exports.resolvedParsedEntryZone = resolvedParsedEntryZone;
exports.parsedHasExplicitEntryAnchor = parsedHasExplicitEntryAnchor;
exports.lastPositiveParsedTpPrice = lastPositiveParsedTpPrice;
function readPositiveNum(v) {
    if (v === undefined || v === null || v === '')
        return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0)
        return null;
    return n;
}
/**
 * Best-effort entry price from `parsed_data` (handles string decimals and
 * occasional camelCase keys from non–parse-signal writers).
 */
function resolvedParsedEntryPrice(parsed) {
    const ext = parsed;
    return (readPositiveNum(parsed.entry_price)
        ?? readPositiveNum(ext.entryPrice)
        ?? readPositiveNum(ext.entry_point));
}
/** Entry zone low/high with the same coercion as {@link resolvedParsedEntryPrice}. */
function resolvedParsedEntryZone(parsed) {
    const ext = parsed;
    const lo = readPositiveNum(parsed.entry_zone_low) ?? readPositiveNum(ext.entryZoneLow);
    const hi = readPositiveNum(parsed.entry_zone_high) ?? readPositiveNum(ext.entryZoneHigh);
    if (lo == null || hi == null)
        return null;
    return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}
/**
 * True when the parsed signal includes an explicit entry **price** or **zone**
 * (not a bare market “buy now”). Used with strict signal entry so planning
 * only runs when the message specifies an entry anchor.
 */
function parsedHasExplicitEntryAnchor(parsed) {
    if (resolvedParsedEntryPrice(parsed) != null)
        return true;
    const z = resolvedParsedEntryZone(parsed);
    return z != null && z.lo > 0 && z.hi > 0;
}
/**
 * Rightmost positive TP from parsed signal data (TP3 when three levels are present).
 */
function lastPositiveParsedTpPrice(parsed) {
    const arr = parsed?.tp;
    if (!Array.isArray(arr) || arr.length === 0)
        return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        const raw = arr[i];
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    return null;
}
/** Planner / executor skip when strict signal entry is on but the parse has no entry anchor. */
exports.SKIP_REASON_SIGNAL_ENTRY_REQUIRED = 'signal_entry_price_requires_explicit_entry';
/** Planner / executor skip when use signal range is on but the parse has no price or zone. */
exports.SKIP_REASON_SIGNAL_ENTRY_RANGE_REQUIRED = 'signal_entry_range_requires_price';
/** All range-entry waits expired without opening a basket. */
exports.SKIP_REASON_SIGNAL_ENTRY_RANGE_EXPIRED = 'signal_entry_range_expired';
