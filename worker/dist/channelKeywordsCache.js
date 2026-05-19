"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CHANNEL_KEYWORDS = void 0;
exports.invalidateChannelParseCache = invalidateChannelParseCache;
exports.setChannelParseCache = setChannelParseCache;
exports.getChannelParseContext = getChannelParseContext;
exports.getCachedChannelKeywords = getCachedChannelKeywords;
const parseSignal_1 = require("./parseSignal");
Object.defineProperty(exports, "DEFAULT_CHANNEL_KEYWORDS", { enumerable: true, get: function () { return parseSignal_1.DEFAULT_CHANNEL_KEYWORDS; } });
const CACHE_TTL_MS = Math.max(60000, Math.min(30 * 60000, Number(process.env.CHANNEL_PARSE_CACHE_TTL_MS ?? 5 * 60000)));
const cache = new Map();
function invalidateChannelParseCache(channelId) {
    cache.delete(channelId);
}
function setChannelParseCache(channelId, keywords, lexicon) {
    cache.set(channelId, { keywords, lexicon, loadedAt: Date.now() });
}
async function getChannelParseContext(supabase, channelId) {
    const hit = cache.get(channelId);
    if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) {
        return { keywords: hit.keywords, lexicon: hit.lexicon };
    }
    const [keywords, lexicon] = await Promise.all([
        (0, parseSignal_1.loadChannelKeywords)(supabase, channelId),
        (0, parseSignal_1.loadChannelLexicon)(supabase, channelId),
    ]);
    cache.set(channelId, { keywords, lexicon, loadedAt: Date.now() });
    return { keywords, lexicon };
}
function getCachedChannelKeywords(channelId) {
    const hit = cache.get(channelId);
    if (!hit || Date.now() - hit.loadedAt >= CACHE_TTL_MS)
        return null;
    return hit.keywords;
}
