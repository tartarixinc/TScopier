"use strict";
/**
 * Canonical signal pip size — shared by backtest P/L and trade-config pip fields.
 * Mirror of `src/lib/signalPip.ts`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSignalSymbol = normalizeSignalSymbol;
exports.getPipMultiplierForSymbol = getPipMultiplierForSymbol;
exports.signalPipPrice = signalPipPrice;
exports.roundSignalPips = roundSignalPips;
exports.priceDeltaToPips = priceDeltaToPips;
exports.pipsToPriceOffset = pipsToPriceOffset;
exports.computePipsFromSignalOutcome = computePipsFromSignalOutcome;
const pipMath_1 = require("./pipMath");
const METAL_ALIASES = {
    GOLD: 'XAUUSD',
    XAU: 'XAUUSD',
    XAG: 'XAGUSD',
    SILVER: 'XAGUSD',
};
function normalizeSignalSymbol(userSymbol) {
    const raw = String(userSymbol ?? '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z]/g, '');
    if (METAL_ALIASES[raw])
        return METAL_ALIASES[raw];
    if (raw.length >= 6)
        return raw.slice(0, 6);
    if (raw === 'XAU')
        return 'XAUUSD';
    if (raw === 'XAG')
        return 'XAGUSD';
    return raw;
}
function getPipMultiplierForSymbol(userSymbol) {
    const pair = normalizeSignalSymbol(userSymbol);
    if (pair.length >= 6) {
        const base = pair.slice(0, 3);
        const quote = pair.slice(3, 6);
        if (base === 'XAU' || base === 'XAG' || base === 'XPT' || base === 'XPD')
            return 10;
        if (quote === 'JPY')
            return 100;
        return 10000;
    }
    const klass = (0, pipMath_1.classifySymbol)(userSymbol);
    switch (klass) {
        case 'fx_jpy':
            return 100;
        case 'fx_major':
            return 10000;
        case 'metal':
            return 10;
        case 'index':
            return 1;
        case 'crypto':
        case 'energy':
            return 100;
        default:
            return 10000;
    }
}
function signalPipPrice(symbol) {
    const mult = getPipMultiplierForSymbol(symbol);
    return mult > 0 ? 1 / mult : 0.0001;
}
function roundSignalPips(pips) {
    return Math.round(pips * 100) / 100;
}
function priceDeltaToPips(delta, symbol) {
    const pip = signalPipPrice(symbol);
    if (!Number.isFinite(pip) || pip <= 0 || !Number.isFinite(delta))
        return 0;
    return roundSignalPips(Math.abs(delta) / pip);
}
function pipsToPriceOffset(pips, symbol) {
    if (!Number.isFinite(pips))
        return 0;
    return pips * signalPipPrice(symbol);
}
function sortTpPrices(direction, tpLevels) {
    return [...tpLevels].sort((a, b) => direction === 'buy' ? a - b : b - a);
}
function computePipsFromSignalOutcome(input) {
    const { symbol, direction, entry, sl, tpLevels, outcome, tpsHit } = input;
    if (!(entry > 0))
        return null;
    if (outcome === 'skipped' || outcome === 'no_data' || outcome === 'open')
        return null;
    const mult = getPipMultiplierForSymbol(symbol);
    const sortedTPs = sortTpPrices(direction, tpLevels);
    if (outcome === 'all_tp_hit' && sortedTPs.length > 0) {
        const highestTP = sortedTPs[sortedTPs.length - 1];
        return roundSignalPips(Math.abs(highestTP - entry) * mult);
    }
    if ((outcome === 'tp1_then_sl' || outcome === 'tp_then_be')
        && tpsHit > 0
        && sl != null
        && Number.isFinite(sl)) {
        const lastHitTPPrice = sortedTPs[tpsHit - 1];
        if (lastHitTPPrice == null || !Number.isFinite(lastHitTPPrice))
            return null;
        const tpPips = Math.abs(lastHitTPPrice - entry) * mult;
        const slPips = Math.abs(sl - entry) * mult;
        return roundSignalPips(tpPips - slPips);
    }
    if (outcome === 'breakeven')
        return 0;
    if (outcome === 'sl_before_tp' && sl != null && Number.isFinite(sl)) {
        return roundSignalPips(-(Math.abs(sl - entry) * mult));
    }
    return null;
}
