export type TradingPlatform = 'MT4' | 'MT5' | 'cTrader' | 'Binance' | 'Bybit' | 'KuCoin' | 'DXtrade' | 'TradeLocker' | 'MatchTrader'

export function normalizeTradingPlatform(value: string | undefined | null): TradingPlatform {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'mt4') return 'MT4'
  if (normalized === 'ctrader') return 'cTrader'
  if (normalized === 'binance') return 'Binance'
  if (normalized === 'bybit') return 'Bybit'
  if (normalized === 'kucoin') return 'KuCoin'
  if (normalized === 'dxtrade') return 'DXtrade'
  if (normalized === 'tradelocker') return 'TradeLocker'
  if (normalized === 'matchtrader' || normalized === 'match-trader') return 'MatchTrader'
  return 'MT5'
}

/** Best-effort hint from broker server name (may be wrong for ambiguous names). */
export function inferServerPlatform(server: string): TradingPlatform | null {
  const normalized = server.trim()
  if (!normalized) return null
  if (/\bmt4\b|[-_]mt4\b|\bmt4[-_]|mt4$/i.test(normalized)) return 'MT4'
  if (/\bmt5\b|[-_]mt5\b|\bmt5[-_]|mt5$/i.test(normalized)) return 'MT5'
  return null
}
