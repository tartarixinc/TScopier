"use strict";
/**
 * Canonical signal pip size — shared by backtest P/L and trade-config pip fields.
 * Mirror of `src/lib/signalPip.ts`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSignalSymbol = normalizeSignalSymbol;
exports.getPipMultiplierForSymbol = getPipMultiplierForSymbol;
exports.signalPipPrice = signalPipPrice;
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
