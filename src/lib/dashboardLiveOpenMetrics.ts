/**
 * Live Open Trades / Open PnL rules for the dashboard headline.
 * Flat books must clear both counters; never keep a stale floating P/L.
 */

export function normalizeLiveOpenMetrics(input: {
  openTrades: number | null | undefined
  openPnl: number | null | undefined
}): { openTrades: number; openPnl: number } {
  const openTrades = typeof input.openTrades === 'number' && Number.isFinite(input.openTrades)
    ? Math.max(0, Math.floor(input.openTrades))
    : 0
  if (openTrades <= 0) return { openTrades: 0, openPnl: 0 }
  const openPnl = typeof input.openPnl === 'number' && Number.isFinite(input.openPnl)
    ? input.openPnl
    : 0
  return { openTrades, openPnl }
}

/** Accept a fresh Open PnL including legitimate zero (unlike balance keep-nonzero). */
export function acceptFreshOpenPnl(prev: number, next: number): number {
  return Number.isFinite(next) ? next : prev
}
