"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectChannelSignalAliases = collectChannelSignalAliases;
exports.looksLikeTrainingCandidate = looksLikeTrainingCandidate;
exports.looksLikeTradingSignal = looksLikeTradingSignal;
const signalCommentaryGuard_1 = require("./signalCommentaryGuard");
const signalManagementIntent_1 = require("./signalManagementIntent");
const multilingualSignalTerms_1 = require("./multilingualSignalTerms");
const tradableSymbol_1 = require("./tradableSymbol");
const normalizeTelegramMessageText_1 = require("./normalizeTelegramMessageText");
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function splitKeywordAliases(raw, delimiters = '') {
    const extra = String(delimiters ?? '').replace(/\s+/g, '');
    const chars = [',', ';', '\n', '|', ...extra.split('')].filter(Boolean).map(c => escapeRegExp(c));
    const splitter = new RegExp(`[${chars.join('')}]+`);
    return String(raw ?? '')
        .split(splitter)
        .map(x => x.trim())
        .filter(Boolean);
}
function keywordRegex(phrase) {
    const p = escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, 'iu');
}
function hasAnyKeyword(text, words) {
    return words.some(w => w && keywordRegex(w).test(text));
}
/** Collect configured channel aliases used by the ingest gate. */
function collectChannelSignalAliases(ctx) {
    const keywords = ctx?.keywords;
    const lexicon = ctx?.lexicon;
    if (!keywords)
        return [];
    const delim = keywords.additional.delimiters;
    const actionAliases = lexicon?.action_aliases && typeof lexicon.action_aliases === 'object'
        ? lexicon.action_aliases
        : {};
    return Array.from(new Set([
        ...splitKeywordAliases(keywords.signal.buy, delim),
        ...splitKeywordAliases(keywords.signal.sell, delim),
        ...splitKeywordAliases(keywords.signal.sl, delim),
        ...splitKeywordAliases(keywords.signal.tp, delim),
        ...splitKeywordAliases(keywords.signal.entry_point, delim),
        ...splitKeywordAliases(keywords.signal.market_order, delim),
        ...splitKeywordAliases(keywords.update.break_even, delim),
        ...splitKeywordAliases(keywords.update.close_full, delim),
        ...splitKeywordAliases(keywords.update.close_half, delim),
        ...splitKeywordAliases(keywords.update.close_partial, delim),
        ...splitKeywordAliases(keywords.update.close_tp1, delim),
        ...splitKeywordAliases(keywords.update.close_tp2, delim),
        ...splitKeywordAliases(keywords.update.close_tp3, delim),
        ...splitKeywordAliases(keywords.update.close_tp4, delim),
        ...splitKeywordAliases(keywords.update.set_sl, delim),
        ...splitKeywordAliases(keywords.update.adjust_sl, delim),
        ...splitKeywordAliases(keywords.update.set_tp, delim),
        ...splitKeywordAliases(keywords.update.adjust_tp, delim),
        ...splitKeywordAliases(keywords.additional.close_all, delim),
        ...(actionAliases.buy ?? []),
        ...(actionAliases.sell ?? []),
        ...(actionAliases.modify ?? []),
        ...(lexicon?.tp_aliases ?? []),
        ...(lexicon?.target_aliases ?? []),
    ].map(a => String(a).trim()).filter(Boolean)));
}
const ENGLISH_DIRECTION = /\b(buy|sell|long|short|tp|take profit|sl|stop loss|breakeven|be)\b/;
const ENGLISH_PRICE_CTX = /\b(entry|zone|between|above|below|now)\b/;
const ENGLISH_TRADE_STRUCTURE = /\b(tp\s*\d*|sl|entry|signal|setup)\b/;
const ENGLISH_REPLY_MGMT = /\b(move|set|update|adjust|tp|sl|breakeven|be|close)\b/;
function hasNumericPriceContext(normalized) {
    return /\b\d{1,5}(?:\.\d{1,5})?\b/.test(normalized);
}
/** Relaxed gate for training backfill: instrument + price, no English keyword requirement. */
function looksLikeTrainingCandidate(text) {
    const raw = (0, normalizeTelegramMessageText_1.normalizeTelegramMessageText)(text).trim();
    const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
    if (!normalized || (0, signalCommentaryGuard_1.looksLikeCasualNonTradeMessage)(normalized))
        return false;
    return (0, tradableSymbol_1.hasTradableInstrumentInText)(raw) && hasNumericPriceContext(normalized);
}
/**
 * Score-based gate for live ingest. When channel keywords/lexicon are present,
 * any configured alias counts as direction/action evidence.
 */
function looksLikeTradingSignal(text, isReply, ctx) {
    const normalized = (0, normalizeTelegramMessageText_1.normalizeTelegramMessageText)(text)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized)
        return false;
    if ((0, signalCommentaryGuard_1.looksLikeCasualNonTradeMessage)(normalized))
        return false;
    const channelAliases = collectChannelSignalAliases(ctx);
    const hasChannelKeyword = channelAliases.length > 0 && hasAnyKeyword(text, channelAliases);
    const hasInstrument = (0, tradableSymbol_1.hasTradableInstrumentInText)(normalized);
    const hasDirectionOrAction = ENGLISH_DIRECTION.test(normalized)
        || multilingualSignalTerms_1.MULTILINGUAL_DIRECTION_RE.test(text)
        || (0, signalManagementIntent_1.looksLikeExplicitFullCloseCommand)(normalized, { channelKeywords: ctx?.keywords ?? null, lexicon: ctx?.lexicon ?? null })
        || hasChannelKeyword;
    const hasPriceContext = hasNumericPriceContext(normalized)
        || ENGLISH_PRICE_CTX.test(normalized)
        || (0, multilingualSignalTerms_1.textHasCommonMarketNowIntent)(text);
    const hasTradeStructure = ENGLISH_TRADE_STRUCTURE.test(normalized)
        || (channelAliases.length > 0 && hasChannelKeyword);
    if (isReply && (ENGLISH_REPLY_MGMT.test(normalized) || hasChannelKeyword)) {
        return true;
    }
    if ((0, signalManagementIntent_1.looksLikeChannelManagementUpdate)(normalized, ctx?.keywords ?? null, ctx?.lexicon ?? null))
        return true;
    // Language-neutral: tradable symbol + at least one price is enough for trained/untrained channels.
    if (hasInstrument && hasNumericPriceContext(normalized) && (hasChannelKeyword || hasDirectionOrAction)) {
        return true;
    }
    const score = Number(hasDirectionOrAction)
        + Number(hasInstrument)
        + Number(hasPriceContext)
        + Number(hasTradeStructure);
    return score >= 2;
}
