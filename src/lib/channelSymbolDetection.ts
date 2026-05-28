export type ChannelSignalRow = {
  raw_message?: string | null
  parsed_data?: unknown
}

export type DetectedChannelSymbol = {
  symbol: string
  count: number
}

const FX_QUOTES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD'])

const KNOWN_SYMBOL_ALIASES: Record<string, string> = {
  GOLD: 'XAUUSD',
  XAU: 'XAUUSD',
  SILVER: 'XAGUSD',
  XAG: 'XAGUSD',
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
}

const SYMBOL_TOKEN_RE =
  /\b(XAUUSD|XAGUSD|US30|NAS100|SPX500|GER40|UK100|BTCUSDT|ETHUSDT|[A-Z]{6}|GOLD|SILVER|XAU|XAG|BTC|ETH)\b/i

/** Normalize a raw token to a broker-safe symbol code (mirrors analyze-channel-profile). */
export function normalizeAssetSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null
  const token = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!token) return null

  if (KNOWN_SYMBOL_ALIASES[token]) return KNOWN_SYMBOL_ALIASES[token]

  if (/^(XAUUSD|XAGUSD|US30|NAS100|SPX500|GER40|UK100|BTCUSDT|ETHUSDT)$/.test(token)) {
    return token
  }

  if (/^[A-Z]{6}$/.test(token)) {
    const base = token.slice(0, 3)
    const quote = token.slice(3, 6)
    if (FX_QUOTES.has(base) && FX_QUOTES.has(quote) && base !== quote) {
      return token
    }
  }

  return null
}

function symbolFromParsed(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null
  const sym = (parsed as Record<string, unknown>).symbol
  if (typeof sym !== 'string') return null
  return normalizeAssetSymbol(sym)
}

function symbolFromRawMessage(message: string): string | null {
  const text = (message ?? '').trim()
  if (!text) return null
  const match = text.match(SYMBOL_TOKEN_RE)
  return normalizeAssetSymbol(match ? match[1] : null)
}

/** Aggregate unique symbols from recent channel signals, sorted by frequency. */
export function detectChannelSymbols(rows: ChannelSignalRow[]): DetectedChannelSymbol[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const fromParsed = symbolFromParsed(row.parsed_data)
    const sym = fromParsed ?? symbolFromRawMessage(String(row.raw_message ?? ''))
    if (!sym) continue
    counts.set(sym, (counts.get(sym) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
}

export function parseSymbolToTradeList(value: string | null | undefined): string[] {
  if (!value || !value.trim()) return []
  return value
    .split(/[,;\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0)
}

/** Merge profile meta.symbol_counts keys into detected list (union, preserve counts). */
export function mergeSymbolCountsFromProfile(
  detected: DetectedChannelSymbol[],
  symbolCounts: Record<string, number> | null | undefined,
): DetectedChannelSymbol[] {
  if (!symbolCounts || typeof symbolCounts !== 'object') return detected
  const map = new Map(detected.map(d => [d.symbol, d.count]))
  for (const [raw, count] of Object.entries(symbolCounts)) {
    const sym = normalizeAssetSymbol(raw) ?? raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!sym) continue
    const n = Number(count)
    map.set(sym, (map.get(sym) ?? 0) + (Number.isFinite(n) && n > 0 ? n : 1))
  }
  return [...map.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol))
}

/** Whitelist symbols saved in manual_settings but not seen in recent signals. */
export function staleWhitelistSymbols(
  whitelist: string[],
  detected: DetectedChannelSymbol[],
): string[] {
  const detectedSet = new Set(detected.map(d => d.symbol))
  return whitelist.filter(s => !detectedSet.has(s))
}

/** Selected symbols → symbol_to_trade storage (null = trade all detected / no filter). */
export function symbolToTradeFromSelection(
  selected: Set<string>,
  detected: DetectedChannelSymbol[],
): string | null {
  const detectedSyms = detected.map(d => d.symbol)
  if (detectedSyms.length === 0) {
    if (selected.size === 0) return null
    return [...selected].sort().join(',')
  }
  const allSelected = detectedSyms.every(s => selected.has(s))
  if (allSelected || selected.size === 0) return null
  return [...selected].sort().join(',')
}

/** Derive checkbox selection from saved symbol_to_trade and detected list. */
export function selectedSymbolsFromWhitelist(
  symbolToTrade: string | null | undefined,
  detected: DetectedChannelSymbol[],
): Set<string> {
  const whitelist = parseSymbolToTradeList(symbolToTrade)
  const detectedSyms = detected.map(d => d.symbol)
  if (whitelist.length === 0) {
    return new Set(detectedSyms)
  }
  const selected = new Set(whitelist.filter(s => detectedSyms.includes(s)))
  for (const s of whitelist) {
    if (!detectedSyms.includes(s)) selected.add(s)
  }
  return selected
}
