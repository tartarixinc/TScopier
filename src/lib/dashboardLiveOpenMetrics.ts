/**
 * Live Open Trades / Open PnL rules for the dashboard headline.
 * Headline Open Trades = market positions only (paired with floating Open PnL).
 * Flat books must clear both counters; never invent a $0 mark while opens remain.
 */

export type LiveOpenMetrics = {
  openTrades: number
  /** null = PnL unknown — callers must not overwrite a prior mark with 0. */
  openPnl: number | null
}

export function normalizeLiveOpenMetrics(input: {
  openTrades: number | null | undefined
  openPnl: number | null | undefined
}): LiveOpenMetrics {
  const openTrades = typeof input.openTrades === 'number' && Number.isFinite(input.openTrades)
    ? Math.max(0, Math.floor(input.openTrades))
    : 0
  if (openTrades <= 0) return { openTrades: 0, openPnl: 0 }
  if (typeof input.openPnl === 'number' && Number.isFinite(input.openPnl)) {
    return { openTrades, openPnl: input.openPnl }
  }
  return { openTrades, openPnl: null }
}

/** True when AccountSummary floating P/L is effectively flat. */
export function isAccountSummaryFlat(
  balance: number | null | undefined,
  equity: number | null | undefined,
  epsilon = 0.01,
): boolean {
  if (balance == null || equity == null) return false
  if (!Number.isFinite(balance) || !Number.isFinite(equity)) return false
  return Math.abs(equity - balance) < epsilon
}

/**
 * When the MTAPI summary is flat and there are no market positions, clear both
 * counters so sticky pending/list counts cannot leave "104 Open / $0 PnL".
 */
export function resolveFlatBookOpenMetrics(input: {
  summaryFlat: boolean
  marketOpenCount: number
  openPnl: number | null | undefined
}): LiveOpenMetrics {
  const market = Number.isFinite(input.marketOpenCount)
    ? Math.max(0, Math.floor(input.marketOpenCount))
    : 0
  if (input.summaryFlat && market <= 0) {
    return { openTrades: 0, openPnl: 0 }
  }
  return normalizeLiveOpenMetrics({ openTrades: market, openPnl: input.openPnl })
}

/** Accept a fresh Open PnL including legitimate zero (unlike balance keep-nonzero). */
export function acceptFreshOpenPnl(prev: number, next: number): number {
  return Number.isFinite(next) ? next : prev
}
