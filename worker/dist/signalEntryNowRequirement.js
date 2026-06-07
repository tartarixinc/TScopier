"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTRY_REQUIRES_NOW_REASON = void 0;
exports.parsedHasSlOrTp = parsedHasSlOrTp;
exports.messageHasMarketNowIntent = messageHasMarketNowIntent;
exports.messageHasExplicitSlTpLabels = messageHasExplicitSlTpLabels;
exports.entryMissingSlTpRequiresNow = entryMissingSlTpRequiresNow;
exports.ENTRY_REQUIRES_NOW_REASON = 'entry_requires_now_without_sl_tp';
function positivePrice(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}
function parsedHasSlOrTp(parsed) {
    const sl = positivePrice(parsed.sl);
    const tp = Array.isArray(parsed.tp)
        ? parsed.tp.map(positivePrice).filter((n) => n != null)
        : [];
    return sl != null || tp.length > 0;
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function keywordRegex(phrase) {
    const p = escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|\\b)${p}(?:\\b|$)`, 'i');
}
function splitKeywordAliases(raw, delim) {
    return String(raw ?? '').split(delim).map(s => s.trim()).filter(Boolean);
}
/** True when the message declares an immediate / market entry (NOW, MARKET, etc.). */
function messageHasMarketNowIntent(message, channelKeywords) {
    const raw = String(message ?? '');
    if (/\b(at\s+market|@\s*market)\b/i.test(raw))
        return true;
    const defaults = ['now', 'instant', 'market', 'mkt'];
    const delim = channelKeywords?.additional?.delimiters ?? '|';
    const custom = channelKeywords?.signal?.market_order
        ? splitKeywordAliases(channelKeywords.signal.market_order, delim)
        : [];
    return [...defaults, ...custom].some(token => token && keywordRegex(token).test(raw));
}
/** True when SL/TP appear as labeled parameters in the message (not inferred from prose). */
function messageHasExplicitSlTpLabels(message) {
    const text = String(message ?? '');
    if (/\b(?:sl|stop\s*loss)\s*[:=\-]?\s*\d/i.test(text))
        return true;
    if (/\b(?:sl|stop\s*loss)\s+to\s+\d/i.test(text))
        return true;
    if (/\b(?:tp|take\s*profit|target(?:\s+level)?)\s*#?\s*\d+\s*[:=\-]\s*\d/i.test(text))
        return true;
    if (/\b(?:tp|take\s*profit|target(?:\s+level)?)\s*[:=\-]\s*\d/i.test(text))
        return true;
    if (/\btp\s*\d+\s*[:=\-]\s*\d/i.test(text))
        return true;
    return false;
}
/**
 * Buy/sell entries need NOW (or MARKET) unless the message includes explicit SL/TP labels.
 * Inferred SL/TP from bare numbers (e.g. £1110 profit) do not count as parameters.
 */
function entryMissingSlTpRequiresNow(parsed, rawMessage, channelKeywords) {
    const action = String(parsed.action ?? '').toLowerCase();
    if (action !== 'buy' && action !== 'sell')
        return false;
    if (messageHasMarketNowIntent(rawMessage, channelKeywords))
        return false;
    if (messageHasExplicitSlTpLabels(rawMessage))
        return false;
    return true;
}
