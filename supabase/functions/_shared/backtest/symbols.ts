/** Normalize user symbol filter (empty = all symbols). */
export function normalizeSymbolFilter(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) return []
  const out = new Set<string>()
  for (const s of symbols) {
    const v = String(s).trim().toUpperCase()
    if (v) out.add(v)
  }
  return [...out].sort()
}

export function matchesSymbolFilter(symbol: string, filter: string[]): boolean {
  if (filter.length === 0) return true
  return filter.includes(String(symbol).trim().toUpperCase())
}
