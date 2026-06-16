"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trainedManagementAliases = trainedManagementAliases;
exports.channelHasTrainedManagement = channelHasTrainedManagement;
exports.looksLikeExplicitFullCloseCommand = looksLikeExplicitFullCloseCommand;
exports.looksLikeChannelManagementUpdate = looksLikeChannelManagementUpdate;
exports.partialCloseFractionFromMessage = partialCloseFractionFromMessage;
exports.isPipCountInMessage = isPipCountInMessage;
exports.bareTradePricesExcludingPips = bareTradePricesExcludingPips;
const multilingualManagementTerms_1 = require("./multilingualManagementTerms");
const trainingManagementKeywords_1 = require("./trainingManagementKeywords");
const EXPLICIT_CLOSE_SYMBOL = 'gold|xauusd|xau|silver|xagusd|btc|bitcoin|btcusd|ethusd|eurusd|gbpusd|us30|nas100';
/** All trained management aliases from channel keywords + lexicon buckets. */
function trainedManagementAliases(channelKeywords, lexicon) {
    const fromKeywords = managementAliasesFromKeywords(channelKeywords);
    const legacyGroups = (0, trainingManagementKeywords_1.resolveManagementGroups)({
        management_cues: lexicon?.action_aliases?.modify ?? [],
    });
    return Array.from(new Set([
        ...fromKeywords,
        ...(0, trainingManagementKeywords_1.flattenManagementGroups)(legacyGroups),
        ...(lexicon?.action_aliases?.modify ?? []),
    ].map(a => String(a).trim()).filter(Boolean)));
}
function channelHasTrainedManagement(channelKeywords, lexicon) {
    const modify = lexicon?.action_aliases?.modify ?? [];
    if (modify.length > 0)
        return true;
    const additional = channelKeywords?.additional;
    return Boolean(additional?.ai_management_keyword_groups);
}
/**
 * True for intentional full-close commands (two-word minimum), not prose like "close to our entry".
 */
function looksLikeExplicitFullCloseCommand(message, ctx) {
    const t = String(message ?? '').replace(/\s+/g, ' ').trim();
    if (!t)
        return false;
    if (/\bclose\s+to\b/i.test(t))
        return false;
    const legacyGroups = (0, trainingManagementKeywords_1.resolveManagementGroups)({
        management_cues: ctx?.lexicon?.action_aliases?.modify ?? [],
    });
    const closeAliases = Array.from(new Set([
        ...legacyGroups.close_all,
        ...splitKeywordAliases(ctx?.channelKeywords?.additional?.close_all ?? '', ctx?.channelKeywords?.additional?.delimiters ?? '|'),
        ...splitKeywordAliases(ctx?.channelKeywords?.update?.close_full ?? '', ctx?.channelKeywords?.additional?.delimiters ?? '|'),
    ].filter(Boolean)));
    if (closeAliases.length > 0 && hasAnyKeyword(t, closeAliases))
        return true;
    if (!channelHasTrainedManagement(ctx?.channelKeywords, ctx?.lexicon)) {
        if ((0, multilingualManagementTerms_1.textLooksLikeMultilingualFullClose)(t))
            return true;
    }
    return (/\bclose\s+(?:now|all|full|trade|trades|position|positions|everything|every\s+thing)\b/i.test(t)
        || /\bclose\s+(?:my|the|this|running|active|open)\s+(?:trade|trades|position|positions)\b/i.test(t)
        || new RegExp(`\\bclose\\s+(?:${EXPLICIT_CLOSE_SYMBOL}|[a-z]{6})\\b`, 'i').test(t)
        || /\b(?:flatten|kill\s+zones?)\b/i.test(t)
        || /\bexit\s+(?:trade|trades|position|positions|long|short|now)\b/i.test(t));
}
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
function managementAliasesFromKeywords(keywords) {
    if (!keywords)
        return [];
    const delim = keywords.additional.delimiters;
    return Array.from(new Set([
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
    ].map(a => a.trim()).filter(Boolean)));
}
/** True when text looks like a trade-management instruction (not a fresh entry). */
function looksLikeChannelManagementUpdate(text, channelKeywords, lexicon) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t)
        return false;
    const trained = trainedManagementAliases(channelKeywords, lexicon);
    if (trained.length > 0 && hasAnyKeyword(t, trained))
        return true;
    if (!channelHasTrainedManagement(channelKeywords, lexicon)) {
        if ((0, multilingualManagementTerms_1.textLooksLikeMultilingualManagement)(t))
            return true;
    }
    return (/\b(move\s+stop|move\s+sl|move\s+risk|stop\s+to\s+breakeven|breakeven|break\s*even)\b/i.test(t)
        || /\b(?:adjust|move|set|change|update)\s+(?:sl|stop\s*loss|stoploss|risk)\b/i.test(t)
        || /\b(?:sl|stop\s*loss|stoploss|risk)\s+to\s+\d/i.test(t)
        || /\b(close\s+partial|closing\s+partial|take\s+partial|partial\s+(?:lot|lots|lotsize|position|trade))\b/i.test(t)
        || /\bsecure\s+\d+\s*%\s*profit/i.test(t)
        || /\btake\s+profit\s+(?:target\s+)?(?:is\s+)?hit\b/i.test(t)
        || /\bclose\s+(?:half|50%|25%|partials?)\b/i.test(t)
        || /\b\d{1,3}\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?)\b/i.test(t));
}
/** Percent partial close when message says e.g. "secure 30% profits". */
function partialCloseFractionFromMessage(text) {
    const m = String(text ?? '').match(/\b(?:secure|close|take)\s+(\d{1,2}|100)\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?)?/i);
    if (m?.[1]) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0 && n <= 100)
            return n / 100;
    }
    const pctOnly = String(text ?? '').match(/\b(\d{1,2}|100)\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?)\b/i);
    if (pctOnly?.[1]) {
        const n = Number(pctOnly[1]);
        if (Number.isFinite(n) && n > 0 && n <= 100)
            return n / 100;
    }
    return null;
}
/** Bare prices used only as pip counts (+30 pips) are not entry/SL/TP parameters. */
function isPipCountInMessage(message, price) {
    const s = String(price);
    return new RegExp(`(?:\\+|\\b)${s}\\s*pips?\\b`, 'i').test(String(message ?? ''));
}
function bareTradePricesExcludingPips(message, prices) {
    return prices.filter(p => !isPipCountInMessage(message, p));
}
