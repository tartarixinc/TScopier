/** Routes that need live MT health checks and silent reconnect sweeps. */
const LIVE_BROKER_CONNECTIVITY_PREFIXES = [
  '/dashboard',
  '/brokers',
  '/channels',
  '/activities',
  '/performance',
  '/portfolio',
  '/account-trades',
  '/backtest',
] as const

export function routeNeedsLiveBrokerConnectivity(pathname: string): boolean {
  return LIVE_BROKER_CONNECTIVITY_PREFIXES.some(
    prefix => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
