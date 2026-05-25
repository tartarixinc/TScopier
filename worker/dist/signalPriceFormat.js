"use strict";
/**
 * Parse signal price tokens including US thousands commas (4,572.25).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SIGNAL_PRICE_NUM = void 0;
exports.parseSignalPriceToken = parseSignalPriceToken;
exports.parseSignalPriceListBlock = parseSignalPriceListBlock;
exports.signalPriceTokenRegex = signalPriceTokenRegex;
/** Regex capture group for prices like 4572.25 or 4,572.25 */
exports.SIGNAL_PRICE_NUM = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
function parseSignalPriceToken(raw) {
    if (raw == null || String(raw).trim() === '')
        return null;
    const n = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0)
        return null;
    return n;
}
function parseSignalPriceListBlock(block) {
    const out = [];
    const seen = new Set();
    for (const part of block.split(/\s*(?:\/|,|\band\b|\|)\s*/i)) {
        const v = parseSignalPriceToken(part.trim());
        if (v == null || seen.has(v))
            continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}
/** Global regex for scanning unlabeled price tokens in free text. */
function signalPriceTokenRegex(flags = 'g') {
    return new RegExp(exports.SIGNAL_PRICE_NUM, flags);
}
