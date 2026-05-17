"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tradeableFromParsed = tradeableFromParsed;
const tradableSymbol_1 = require("./tradableSymbol");
/** Map parse-signal JSON into backtest_channel_signals upsert fields. */
function tradeableFromParsed(parsed) {
    const action = String(parsed.action ?? '').toLowerCase();
    if (action !== 'buy' && action !== 'sell')
        return null;
    const symbol = (0, tradableSymbol_1.sanitizeParsedSymbol)(typeof parsed.symbol === 'string' ? parsed.symbol : null);
    if (!symbol || !(0, tradableSymbol_1.isTradableInstrumentSymbol)(symbol))
        return null;
    const entryExplicit = num(parsed.entry_price) ??
        num(parsed.entry_zone_low) ??
        num(parsed.entry_zone_high);
    const sl = num(parsed.sl);
    const tpRaw = parsed.tp;
    const tp_levels = Array.isArray(tpRaw)
        ? tpRaw.map((v) => num(v)).filter((n) => n != null)
        : [];
    if (sl == null && tp_levels.length === 0)
        return null;
    const entry_price = entryExplicit != null && entryExplicit > 0 ? entryExplicit : 0;
    return {
        direction: action,
        symbol,
        entry_price,
        sl,
        tp_levels,
        lot_size: num(parsed.lot_size),
    };
}
function num(v) {
    if (v == null)
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
