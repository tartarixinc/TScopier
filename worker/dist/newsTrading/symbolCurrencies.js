"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.currenciesForSymbol = currenciesForSymbol;
exports.eventMatchesSymbol = eventMatchesSymbol;
const METAL_PREFIXES = new Set(['XAU', 'XAG', 'XPT', 'XPD']);
/** Extract quote currencies from a broker symbol (e.g. EURUSD → EUR, USD). */
function currenciesForSymbol(symbol) {
    const s = String(symbol ?? '')
        .replace(/[^A-Za-z]/g, '')
        .toUpperCase();
    if (s.length < 3)
        return [];
    if (s.length === 3)
        return [s];
    if (s.length >= 6) {
        const base = s.slice(0, 3);
        const quote = s.slice(3, 6);
        const out = new Set([base, quote]);
        if (METAL_PREFIXES.has(base))
            out.add(base);
        return [...out];
    }
    return [s.slice(0, 3)];
}
function eventMatchesSymbol(event, symbol) {
    const currencies = currenciesForSymbol(symbol);
    if (!currencies.length)
        return true;
    const ec = String(event.currency ?? '').trim().toUpperCase();
    const country = String(event.country ?? '').trim().toUpperCase();
    return currencies.some(c => c === ec || c === country);
}
