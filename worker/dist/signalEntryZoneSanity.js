"use strict";
/**
 * Reject entry zones / anchors implausibly far from the live quote (channel typos like 4516 vs 4216).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTRY_ZONE_FAR_FROM_MARKET_REASON = void 0;
exports.resolvedEntryAnchorFromParsed = resolvedEntryAnchorFromParsed;
exports.entryZoneFarFromQuote = entryZoneFarFromQuote;
const tradableSymbol_1 = require("./tradableSymbol");
exports.ENTRY_ZONE_FAR_FROM_MARKET_REASON = 'entry_zone_far_from_market';
function positive(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}
function resolvedEntryAnchorFromParsed(parsed) {
    const ep = positive(parsed.entry_price);
    if (ep != null)
        return ep;
    const lo = positive(parsed.entry_zone_low);
    const hi = positive(parsed.entry_zone_high);
    if (lo != null && hi != null)
        return (lo + hi) / 2;
    if (lo != null)
        return lo;
    if (hi != null)
        return hi;
    return null;
}
function maxEntryZoneDistanceFromQuote(symbol) {
    const sym = (0, tradableSymbol_1.sanitizeParsedSymbol)(symbol)?.toUpperCase() ?? '';
    if (sym.includes('XAU') || sym.includes('GOLD'))
        return 120;
    if (sym.includes('XAG') || sym.includes('SILVER'))
        return 8;
    if (sym.includes('BTC'))
        return 8000;
    if (sym.includes('ETH'))
        return 400;
    return null;
}
function entryZoneFarFromQuote(args) {
    const anchor = resolvedEntryAnchorFromParsed(args.parsed);
    if (anchor == null)
        return false;
    const symbol = String(args.parsed.symbol ?? 'XAUUSD');
    const maxDist = maxEntryZoneDistanceFromQuote(symbol);
    if (maxDist == null)
        return false;
    const ref = args.direction === 'buy' ? args.quoteAsk : args.quoteBid;
    if (!Number.isFinite(ref) || ref <= 0)
        return false;
    return Math.abs(anchor - ref) > maxDist;
}
