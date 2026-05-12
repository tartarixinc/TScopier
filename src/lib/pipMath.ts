/**
 * Frontend mirror of `worker/src/pipMath.ts`.
 *
 * Kept in sync by hand. If you change the classification/multiplier rules,
 * update both files in the same commit.
 */

export type SymbolClass = 'fx_major' | 'fx_jpy' | 'metal' | 'index' | 'crypto' | 'energy' | 'other'

const FX_CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD',
  'SEK', 'NOK', 'DKK', 'ZAR', 'MXN', 'SGD', 'HKD', 'TRY',
  'PLN', 'HUF', 'CZK', 'ILS', 'RUB', 'KRW', 'CNH', 'CNY',
  'INR', 'BRL', 'THB',
])

const METAL_PREFIXES = ['XAU', 'XAG', 'XPT', 'XPD']

const CRYPTO_TOKENS = new Set([
  'BTC', 'ETH', 'LTC', 'XRP', 'ADA', 'DOT', 'DOGE', 'SOL',
  'BNB', 'AVAX', 'MATIC', 'LINK', 'TRX', 'XLM', 'BCH', 'EOS',
  'ATOM', 'NEAR', 'FTM', 'ALGO', 'USDT', 'USDC',
])

const ENERGY_TOKENS = ['WTI', 'BRENT', 'XBR', 'XTI', 'NATGAS', 'NGAS', 'UKOIL', 'USOIL', 'OIL']

const INDEX_ROOTS = [
  'US30', 'US500', 'US100', 'USTEC', 'NAS', 'SPX', 'DJI', 'DJ30',
  'UK100', 'FTSE', 'GER40', 'DE40', 'DAX', 'EU50', 'STOXX', 'STX',
  'JPN225', 'JP225', 'NIKKEI', 'NIK', 'HK50', 'HSI', 'AUS200', 'AU200',
  'F40', 'FRA40', 'SPA35', 'IBEX', 'NETH25', 'SWI20', 'SMI',
  'CHINA50', 'CHN50', 'INDIA50',
]

function cleanSymbol(symbol: string): string {
  const upper = String(symbol || '').toUpperCase().trim()
  if (!upper) return ''
  const punctMatch = upper.match(/^([A-Z0-9]+)[.#_-]/)
  let core = punctMatch ? punctMatch[1] : upper
  while (core.length > 6 && /[A-Z]$/.test(core)) {
    const stripped = core.slice(0, -1)
    if (stripped.length < 6) break
    core = stripped
  }
  return core
}

export function classifySymbol(symbol: string): SymbolClass {
  const s = cleanSymbol(symbol)
  if (!s) return 'other'

  for (const p of METAL_PREFIXES) {
    if (s.startsWith(p)) return 'metal'
  }
  for (const tok of CRYPTO_TOKENS) {
    if (s.startsWith(tok) || s.endsWith(tok)) return 'crypto'
  }
  for (const tok of ENERGY_TOKENS) {
    if (s.includes(tok)) return 'energy'
  }
  for (const root of INDEX_ROOTS) {
    if (s.includes(root)) return 'index'
  }

  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) {
    const base = s.slice(0, 3)
    const quote = s.slice(3, 6)
    if (FX_CURRENCY_CODES.has(base) && FX_CURRENCY_CODES.has(quote)) {
      return base === 'JPY' || quote === 'JPY' ? 'fx_jpy' : 'fx_major'
    }
  }

  return 'other'
}

/**
 * @deprecated Use `pipCalculator(...)` from `./pipCalculator`. The new
 *   calculator returns the same pip price and additionally exposes the
 *   dollar pip value per std/mini/micro lot. Implementation here mirrors
 *   `pipCalculator(...).pipPrice` exactly; do not change one without the
 *   other.
 */
export function smartPipSize(symbol: string, point: number, digits: number): number {
  if (!Number.isFinite(point) || point <= 0) return 0.0001
  const d = Number.isFinite(digits) ? Math.max(0, Math.floor(digits)) : 5
  const klass = classifySymbol(symbol)
  if (klass === 'fx_major' || klass === 'fx_jpy') {
    return d === 3 || d === 5 ? point * 10 : point
  }
  if (klass === 'metal') {
    const cleaned = (symbol || '').toUpperCase()
    const floor = cleaned.includes('XAG') ? 0.01 : 0.10
    return Math.max(point * 10, floor)
  }
  if (klass === 'index') {
    return Math.max(point * 10, 1)
  }
  return point * 10
}
