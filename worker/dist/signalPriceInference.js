"use strict";
/**
 * Directional TP/SL inference from bare prices and re-enter intent detection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectReEnterIntent = detectReEnterIntent;
exports.parsedHasReEnterIntent = parsedHasReEnterIntent;
exports.classifyPricesByDirection = classifyPricesByDirection;
exports.extractUnlabeledPrices = extractUnlabeledPrices;
exports.entryReferenceFromParsed = entryReferenceFromParsed;
const signalPriceFormat_1 = require("./signalPriceFormat");
const signalCommentaryGuard_1 = require("./signalCommentaryGuard");
/** True when the channel explicitly asks to add a new trade (not modify existing). */
function detectReEnterIntent(message) {
    return /\b(?:re[-\s]?(?:entry|enter)|reenter)\b/i.test(String(message ?? ''));
}
function parsedHasReEnterIntent(parsed) {
    if (!parsed)
        return false;
    if (parsed.re_enter === true)
        return true;
    return detectReEnterIntent(parsed.raw_instruction ?? '');
}
function positivePrice(v) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0)
        return null;
    return n;
}
function uniquePrices(prices) {
    const out = [];
    const seen = new Set();
    for (const p of prices) {
        const n = positivePrice(p);
        if (n == null || seen.has(n))
            continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}
/**
 * Classify bare prices into SL and TPs relative to trade direction and optional entry.
 * Sell: SL above reference, TPs below. Buy: inverse.
 * Without entry reference: sell uses max as SL; buy uses min as SL.
 */
function classifyPricesByDirection(action, entryRef, prices) {
    const nums = uniquePrices(prices);
    if (!nums.length)
        return { sl: null, tp: [] };
    const isSell = action === 'sell';
    if (entryRef != null && entryRef > 0) {
        const slCandidates = nums.filter(p => (isSell ? p > entryRef : p < entryRef));
        const tpCandidates = nums.filter(p => (isSell ? p < entryRef : p > entryRef));
        const sl = slCandidates.length
            ? (isSell ? Math.max(...slCandidates) : Math.min(...slCandidates))
            : null;
        const tp = isSell
            ? [...tpCandidates].sort((a, b) => b - a)
            : [...tpCandidates].sort((a, b) => a - b);
        return { sl, tp };
    }
    if (nums.length === 1) {
        return { sl: null, tp: nums };
    }
    const sl = isSell ? Math.max(...nums) : Math.min(...nums);
    const tp = nums.filter(p => p !== sl);
    const sortedTp = isSell
        ? [...tp].sort((a, b) => b - a)
        : [...tp].sort((a, b) => a - b);
    return { sl, tp: sortedTp };
}
function collectLabeledSpans(message) {
    const text = String(message ?? '');
    const spans = [];
    const addMatches = (rx) => {
        for (const m of text.matchAll(rx)) {
            const value = (0, signalPriceFormat_1.parseSignalPriceToken)(m[1]);
            if (value == null)
                continue;
            spans.push({
                start: m.index ?? 0,
                end: (m.index ?? 0) + m[0].length,
                value,
            });
        }
    };
    addMatches(new RegExp(`\\b(?:sl|stop\\s*loss)\\s*[:=]?\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\b(?:sl|stop\\s*loss)\\s+to\\s+(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)\\s*#\\s*\\d+\\s*[:=\\-]\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)\\s+\\d+\\s*[:=\\-]\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)\\s*\\d+\\s+(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\b(?:tp|target(?:\\s+level)?)\\s*\\d+\\s*[:=\\-]\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)(?:\\s*[:=\\-]\\s*|\\s+)(${signalPriceFormat_1.SIGNAL_PRICE_NUM})(?!\\s*[:=\\-]\\s*${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\bentry\\s*(?:price|level)?\\s*[:=]\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\bentry\\s+level\\s*[:=]?\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`@\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'g'));
    addMatches(new RegExp(`\\b(?:buy|sell)\\s+at\\s+(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    addMatches(new RegExp(`\\bentry\\s+(${signalPriceFormat_1.SIGNAL_PRICE_NUM})`, 'gi'));
    const addTwoPriceZone = (rx) => {
        for (const m of text.matchAll(rx)) {
            const spanStart = m.index ?? 0;
            const spanEnd = spanStart + m[0].length;
            for (let i = 1; i <= 2; i++) {
                const value = (0, signalPriceFormat_1.parseSignalPriceToken)(m[i]);
                if (value == null)
                    continue;
                spans.push({ start: spanStart, end: spanEnd, value });
            }
        }
    };
    addTwoPriceZone(new RegExp(`\\b(?:between|from)\\s+(${signalPriceFormat_1.SIGNAL_PRICE_NUM})\\s+(?:and|to|-|–)\\s+(${signalPriceFormat_1.SIGNAL_PRICE_NUM})\\b`, 'gi'));
    addTwoPriceZone(new RegExp(`\\b(?:now|instant|market|mkt)\\s+(${signalPriceFormat_1.SIGNAL_PRICE_NUM})\\s*(?:-|–|to)\\s*(${signalPriceFormat_1.SIGNAL_PRICE_NUM})\\b`, 'gi'));
    // TP: 4557 / 4527 — each slash-separated value is labeled
    for (const m of text.matchAll(/\b(?:tp|take\s*profit|target(?:\s+level)?)\s*[:=]?\s*((?:\d+(?:\.\d+)?(?:\s*(?:\/|\band\b|\|)\s*)+)+\d+(?:\.\d+)?)/gi)) {
        const block = m[1] ?? '';
        const base = m.index ?? 0;
        const offset = m[0].indexOf(block);
        for (const value of (0, signalPriceFormat_1.parseSignalPriceListBlock)(block.replace(/,/g, ''))) {
            const partStart = base + offset;
            spans.push({ start: partStart, end: partStart + block.length, value });
        }
    }
    return spans;
}
function isInsideSpan(index, length, spans) {
    const end = index + length;
    return spans.some(s => index >= s.start && end <= s.end);
}
function isInsideParenthetical(index, text) {
    const before = text.slice(0, index);
    const open = before.lastIndexOf('(');
    const close = before.lastIndexOf(')');
    return open > close;
}
/** Prices in the message not already tied to SL/TP/entry labels. */
function extractUnlabeledPrices(message) {
    const text = String(message ?? '');
    const labeled = collectLabeledSpans(text);
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll((0, signalPriceFormat_1.signalPriceTokenRegex)())) {
        const raw = m[0];
        const index = m.index ?? 0;
        if (isInsideSpan(index, raw.length, labeled))
            continue;
        if (isInsideParenthetical(index, text))
            continue;
        if ((0, signalCommentaryGuard_1.isPercentagePriceAt)(text, index, raw.length))
            continue;
        const prefix = text.slice(Math.max(0, index - 3), index);
        if (/[£$€]\s*$/.test(prefix))
            continue;
        const contextBefore = text.slice(Math.max(0, index - 28), index);
        if (/\b(?:profit|made|earned|gains?)\b/i.test(contextBefore)
            && !/\b(?:sl|tp|stop|take)\b/i.test(contextBefore)) {
            continue;
        }
        // Skip parenthetical duplicates: 4577 (4577.10)
        const after = text.slice(index + raw.length).trimStart();
        if (after.startsWith('(')) {
            const close = after.indexOf(')');
            if (close > 0) {
                const inner = after.slice(1, close).trim();
                if (new RegExp(`^${signalPriceFormat_1.SIGNAL_PRICE_NUM}$`).test(inner))
                    continue;
            }
        }
        const value = (0, signalPriceFormat_1.parseSignalPriceToken)(raw);
        if (value == null || seen.has(value))
            continue;
        const digitsOnly = raw.replace(/,/g, '');
        if (/^\d{4}$/.test(digitsOnly)) {
            const year = Number(digitsOnly);
            if (year >= 1900 && year <= 2100)
                continue;
        }
        seen.add(value);
        out.push(value);
    }
    return out;
}
function entryReferenceFromParsed(parsed) {
    const ep = positivePrice(parsed.entry_price);
    if (ep != null)
        return ep;
    const lo = positivePrice(parsed.entry_zone_low);
    const hi = positivePrice(parsed.entry_zone_high);
    if (lo != null && hi != null)
        return (lo + hi) / 2;
    return null;
}
