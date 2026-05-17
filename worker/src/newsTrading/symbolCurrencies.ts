const METAL_PREFIXES = new Set(['XAU', 'XAG', 'XPT', 'XPD'])

/** Extract quote currencies from a broker symbol (e.g. EURUSD → EUR, USD). */
export function currenciesForSymbol(symbol: string): string[] {
  const s = String(symbol ?? '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
  if (s.length < 3) return []
  if (s.length === 3) return [s]
  if (s.length >= 6) {
    const base = s.slice(0, 3)
    const quote = s.slice(3, 6)
    const out = new Set<string>([base, quote])
    if (METAL_PREFIXES.has(base)) out.add(base)
    return [...out]
  }
  return [s.slice(0, 3)]
}

export function eventMatchesSymbol(event: { currency: string; country: string }, symbol: string): boolean {
  const currencies = currenciesForSymbol(symbol)
  if (!currencies.length) return true
  const ec = String(event.currency ?? '').trim().toUpperCase()
  const country = String(event.country ?? '').trim().toUpperCase()
  return currencies.some(c => c === ec || c === country)
}
