/**
 * Max drawdown (%) of the realized-balance curve: the worst peak-to-trough decline, starting from the
 * performance baseline balance (deposits and withdrawals excluded). Same method as the account
 * analytics (`computeLinkedAccountPerformance`) and the public RPC `get_provider_public_performance`.
 * Null when there is no usable baseline.
 */
export function computeMaxDrawdownPct(
  baseline: number | null | undefined,
  trades: ReadonlyArray<{ closedAt: string | null; profit: number | null }>,
): number | null {
  if (baseline == null || !Number.isFinite(baseline) || baseline <= 0) return null
  const closed = trades
    .filter((trade): trade is { closedAt: string; profit: number } =>
      trade.closedAt != null && trade.profit != null && Number.isFinite(trade.profit) && Number.isFinite(Date.parse(trade.closedAt)))
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))
  let curve = baseline
  let peak = baseline
  let maxDd = 0
  for (const trade of closed) {
    curve += trade.profit
    if (curve > peak) peak = curve
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - curve) / peak) * 100)
  }
  return Math.round(maxDd * 100) / 100
}

/** ROI (%) of the realized P/L against the performance baseline balance. Null without a usable baseline or trades. */
export function computeReturnPct(
  baseline: number | null | undefined,
  trades: ReadonlyArray<{ profit: number | null }>,
): number | null {
  if (baseline == null || !Number.isFinite(baseline) || baseline <= 0) return null
  const profits = trades.map(trade => trade.profit).filter((p): p is number => p != null && Number.isFinite(p))
  if (profits.length === 0) return null
  return Math.round((profits.reduce((sum, p) => sum + p, 0) / baseline) * 10000) / 100
}
