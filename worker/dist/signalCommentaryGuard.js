"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeCasualNonTradeMessage = looksLikeCasualNonTradeMessage;
exports.looksLikeProfitResultCommentary = looksLikeProfitResultCommentary;
exports.isPercentagePriceAt = isPercentagePriceAt;
/** Detect lifestyle/commentary messages that mention gold or "buy" but are not trade signals. */
function looksLikeCasualNonTradeMessage(message) {
    const text = String(message ?? '').replace(/\s+/g, ' ').trim();
    if (!text)
        return false;
    if (/\bgold\s+(watches|watch|jewelry|jewellery|chain|ring|bar|coin|necklace|bracelet)\b/i.test(text)) {
        return true;
    }
    if (/\b(watch|watches|rolex|patek)\b/i.test(text) && /\bgold\b/i.test(text)) {
        return true;
    }
    // Colloquial buy in prose ("They buy. We buy.") without executable signal structure.
    if (/\b(they|we|you)\s+buy\.?\b/i.test(text)
        && !/\b(buy|sell|long|short)\s+(now|gold|xauusd|xau|btc|bitcoin|\d)/i.test(text)
        && !/\b(sl|tp|stop\s+loss|take\s+profit|entry)\s*[:=]/i.test(text)) {
        return true;
    }
    if (looksLikeProfitResultCommentary(text))
        return true;
    return false;
}
/** Profit/testimonial posts that mention a past signal side but are not new entries. */
function looksLikeProfitResultCommentary(message) {
    const text = String(message ?? '').replace(/\s+/g, ' ').trim();
    if (!text)
        return false;
    if (/\binsane\s+result\b/i.test(text))
        return true;
    if (/\b(?:£|\$|€)\s*\d[\d,]*(?:\.\d+)?\b/i.test(text)
        && /\bprofit\b/i.test(text)
        && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=\-]/i.test(text)) {
        return true;
    }
    if (/\b\d[\d,]*(?:\.\d+)?\s*(?:usd|gbp|eur|pounds?|dollars?)\b/i.test(text)
        && /\bprofit\b/i.test(text)
        && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=\-]/i.test(text)) {
        return true;
    }
    if (/\btook my\b/i.test(text)
        && /\b(gold|xauusd|xau|buy|sell)\b/i.test(text)
        && /\b(from today|profit|made|result)\b/i.test(text)
        && !/\b(buy|sell)\s+now\b/i.test(text)) {
        return true;
    }
    if (/\b(made|earned|banked|secured)\b/i.test(text)
        && /\b(profit|pips?\s+profit|gains?)\b/i.test(text)
        && /\b(gold|xauusd|xau|buy|sell)\b/i.test(text)
        && !/\b(buy|sell)\s+now\b/i.test(text)
        && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=\-]/i.test(text)) {
        return true;
    }
    return false;
}
function isPercentagePriceAt(message, index, tokenLength) {
    const after = String(message ?? '').slice(index + tokenLength).trimStart();
    return after.startsWith('%');
}
