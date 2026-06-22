/** Simulated broker / bridge types in the copier fleet. */
export type TradingPlatform = 'MT4' | 'MT5' | 'FXSOCKET'

export const TRADING_PLATFORMS: TradingPlatform[] = ['MT4', 'MT5', 'FXSOCKET']

export function platformForUserIndex(userIndex: number): TradingPlatform {
  return TRADING_PLATFORMS[userIndex % TRADING_PLATFORMS.length]!
}

export function platformLabel(p: TradingPlatform): string {
  switch (p) {
    case 'MT4':
      return 'MetaTrader 4'
    case 'MT5':
      return 'MetaTrader 5'
    case 'FXSOCKET':
      return 'FXSocket bridge'
    default:
      return p
  }
}
