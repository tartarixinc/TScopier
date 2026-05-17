/** FMP forex news uses concatenated pair symbols, e.g. EURUSD. */
export const FOREX_NEWS_SYMBOL_OPTIONS = [
  { value: '' },
  { value: 'EURUSD' },
  { value: 'GBPUSD' },
  { value: 'USDJPY' },
  { value: 'USDCHF' },
  { value: 'AUDUSD' },
  { value: 'USDCAD' },
  { value: 'NZDUSD' },
  { value: 'EURGBP' },
  { value: 'EURJPY' },
  { value: 'GBPJPY' },
  { value: 'XAUUSD' },
] as const

/** Display EURUSD as EUR/USD when possible. */
export function formatForexPairLabel(symbol: string): string {
  const s = symbol.replace(/[^A-Za-z]/g, '').toUpperCase()
  if (s.length === 6) return `${s.slice(0, 3)}/${s.slice(3)}`
  if (s === 'XAUUSD') return 'XAU/USD'
  return s || symbol
}
