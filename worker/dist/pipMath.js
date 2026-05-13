"use strict";
/**
 * Symbol-aware pip math.
 *
 * The MT4/MT5 broker reports a `point` (smallest price increment) and `digits`
 * (decimal places). The "pip" most retail traders mean depends on the symbol:
 *
 *   - FX 4-digit majors (EURUSD = 1.2345)         → pip = point        (0.0001)
 *   - FX 5-digit majors (EURUSD = 1.23456)        → pip = 10 × point   (0.0001)
 *   - FX 2-digit JPY    (USDJPY = 156.12)         → pip = point        (0.01)
 *   - FX 3-digit JPY    (USDJPY = 156.123)        → pip = 10 × point   (0.01)
 *   - XAU/XPT/XPD       any digits                → pip = $0.10 floor
 *   - XAG (silver)      any digits                → pip = $0.01 floor
 *   - Indices, crypto, energy, exotics            → pip = 10 × point
 *
 * Rule of thumb: for **pure FX pairs** the trader-conventional pip = `point`
 * on 2/4-digit quotes and `10 × point` on 3/5-digit "fractional pip" quotes.
 * For **precious metals** the trader-conventional pip is a fixed dollar value
 * regardless of digit count — some brokers list XAUUSD with 5 digits
 * (point=0.00001), and the naive `10 × point` = $0.0001 would make a "10 pip
 * step" render as a tenth of a cent, well inside any reasonable stops_level.
 * For **everything else** (indices, crypto, energy) the conventional pip is
 * `10 × point` — the broker's `point` is the sub-pip increment.
 *
 * Why we need this: on XAUUSD the executor was treating `pip = point = $0.01`,
 * so "10 pips" rendered as $0.10 — well inside the broker's stops_level. Every
 * Invalid Stops error and silent step auto-expand traced back to this.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifySymbol = classifySymbol;
exports.smartPipSize = smartPipSize;
/** Common ISO-4217 currency codes seen in retail FX brokers. */
const FX_CURRENCY_CODES = new Set([
    'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD',
    'SEK', 'NOK', 'DKK', 'ZAR', 'MXN', 'SGD', 'HKD', 'TRY',
    'PLN', 'HUF', 'CZK', 'ILS', 'RUB', 'KRW', 'CNH', 'CNY',
    'INR', 'BRL', 'THB',
]);
/** Symbols that start with these are metals regardless of suffix conventions. */
const METAL_PREFIXES = ['XAU', 'XAG', 'XPT', 'XPD'];
/** Crypto base assets we recognize before doing any deeper checks. */
const CRYPTO_TOKENS = new Set([
    'BTC', 'ETH', 'LTC', 'XRP', 'ADA', 'DOT', 'DOGE', 'SOL',
    'BNB', 'AVAX', 'MATIC', 'LINK', 'TRX', 'XLM', 'BCH', 'EOS',
    'ATOM', 'NEAR', 'FTM', 'ALGO', 'USDT', 'USDC',
]);
/** Energy / commodity tokens. */
const ENERGY_TOKENS = ['WTI', 'BRENT', 'XBR', 'XTI', 'NATGAS', 'NGAS', 'UKOIL', 'USOIL', 'OIL'];
/** Common index roots (substring match against the cleaned symbol). */
const INDEX_ROOTS = [
    'US30', 'US500', 'US100', 'USTEC', 'NAS', 'SPX', 'DJI', 'DJ30',
    'UK100', 'FTSE', 'GER40', 'DE40', 'DAX', 'EU50', 'STOXX', 'STX',
    'JPN225', 'JP225', 'NIKKEI', 'NIK', 'HK50', 'HSI', 'AUS200', 'AU200',
    'F40', 'FRA40', 'SPA35', 'IBEX', 'NETH25', 'SWI20', 'SMI',
    'CHINA50', 'CHN50', 'INDIA50',
];
/**
 * Strip broker-specific decorations so "EURUSDm", "EURUSD.r", "EURUSD#",
 * "EURUSD_pro", "EURUSD.x" all normalise back to "EURUSD".
 */
function cleanSymbol(symbol) {
    const upper = String(symbol || '').toUpperCase().trim();
    if (!upper)
        return '';
    // Drop trailing punctuation + the suffix that follows it (e.g. ".r", "_pro", ".x").
    const punctMatch = upper.match(/^([A-Z0-9]+)[.#_-]/);
    let core = punctMatch ? punctMatch[1] : upper;
    // Strip trailing single lower/upper char broker tag like "m", "c", "i", "pro" — only
    // when the residue is still a recognisable instrument (length ≥ 6 keeps EURUSD intact).
    while (core.length > 6 && /[A-Z]$/.test(core)) {
        const stripped = core.slice(0, -1);
        if (stripped.length < 6)
            break;
        core = stripped;
    }
    return core;
}
function classifySymbol(symbol) {
    const s = cleanSymbol(symbol);
    if (!s)
        return 'other';
    // Metals first — XAUUSD, XAGUSD, XPTUSD, XPDUSD share the FX pair shape
    // (6 letters, both halves look like currency codes), so they must be detected
    // ahead of the FX rule.
    for (const p of METAL_PREFIXES) {
        if (s.startsWith(p))
            return 'metal';
    }
    // Crypto — match common base-asset prefixes or "USDT" / "USDC" quote.
    for (const tok of CRYPTO_TOKENS) {
        if (s.startsWith(tok) || s.endsWith(tok))
            return 'crypto';
    }
    // Energy — substring match (WTI, BRENT, USOIL, etc.).
    for (const tok of ENERGY_TOKENS) {
        if (s.includes(tok))
            return 'energy';
    }
    // Indices — substring match against well-known roots.
    for (const root of INDEX_ROOTS) {
        if (s.includes(root))
            return 'index';
    }
    // FX: exactly 6 letters and both halves are known currency codes.
    if (s.length === 6 && /^[A-Z]{6}$/.test(s)) {
        const base = s.slice(0, 3);
        const quote = s.slice(3, 6);
        if (FX_CURRENCY_CODES.has(base) && FX_CURRENCY_CODES.has(quote)) {
            return base === 'JPY' || quote === 'JPY' ? 'fx_jpy' : 'fx_major';
        }
    }
    return 'other';
}
/**
 * Trader-conventional pip size for a symbol (price units).
 *
 * @deprecated Use `pipCalculator(symbol, point, digits, contractSize?)` from
 *   `./pipCalculator` instead. The new calculator returns the same
 *   `pipPrice` and additionally exposes the dollar pip value per std/mini/
 *   micro lot — needed for risk hints and (future) auto-sizing. This
 *   wrapper is kept so existing call sites compile while we migrate.
 *
 *   The pipPrice math below is intentionally identical to
 *   `pipCalculator(...).pipPrice` so both functions stay in lockstep; we
 *   inline it here to avoid a top-level cycle between `pipMath` and
 *   `pipCalculator` (the calculator imports `classifySymbol` from this
 *   file).
 *
 * @param symbol Broker symbol (with or without prefix/suffix decoration).
 * @param point  Broker `point` (smallest price increment) from /SymbolParams.
 * @param digits Broker `digits` (decimal places) from /SymbolParams.
 */
function smartPipSize(symbol, point, digits) {
    if (!Number.isFinite(point) || point <= 0)
        return 0.0001;
    const d = Number.isFinite(digits) ? Math.max(0, Math.floor(digits)) : 5;
    const klass = classifySymbol(symbol);
    if (klass === 'fx_major' || klass === 'fx_jpy') {
        return d === 3 || d === 5 ? point * 10 : point;
    }
    if (klass === 'metal') {
        const cleaned = (symbol || '').toUpperCase();
        const floor = cleaned.includes('XAG') ? 0.01 : 0.10;
        return Math.max(point * 10, floor);
    }
    if (klass === 'index') {
        return Math.max(point * 10, 1);
    }
    return point * 10;
}
