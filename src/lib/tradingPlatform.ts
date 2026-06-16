export type TradingPlatform = 'MT4' | 'MT5'

export function normalizeTradingPlatform(value: string | undefined | null): TradingPlatform {
  return String(value ?? '').trim().toUpperCase() === 'MT4' ? 'MT4' : 'MT5'
}

/** Best-effort hint from broker server name (may be wrong for ambiguous names). */
export function inferServerPlatform(server: string): TradingPlatform | null {
  const normalized = server.trim()
  if (!normalized) return null
  if (/\bmt4\b|[-_]mt4\b|\bmt4[-_]|mt4$/i.test(normalized)) return 'MT4'
  if (/\bmt5\b|[-_]mt5\b|\bmt5[-_]|mt5$/i.test(normalized)) return 'MT5'
  return null
}
