/** Shared filters for dashboard closed-trade P/L and win/loss counts. */

export type TradeStatsRow = {
  status: string
  profit: number | null
  closed_at: string | null
  symbol: string
  lot_size: number
  direction?: string
  type?: string
  swap?: number | null
  commission?: number | null
}

export function isTradeableClosedRow(row: {
  status: string
  symbol: string
  lot_size: number
  direction?: string
  type?: string
}): boolean {
  if (row.status !== 'closed') return false
  if (!(row.symbol ?? '').trim()) return false
  const type = (row.type ?? '').toLowerCase()
  if (
    type.includes('balance') ||
    type.includes('credit') ||
    type.includes('deposit') ||
    type.includes('withdraw') ||
    type.includes('correction') ||
    type.includes('transfer')
  ) {
    return false
  }
  const dir = (row.direction ?? '').toLowerCase()
  if (dir === 'buy' || dir === 'sell') return true
  return (row.lot_size ?? 0) > 0
}

export function netClosedLegProfit(row: {
  profit: number | null
  swap?: number | null
  commission?: number | null
}): number {
  const p = typeof row.profit === 'number' && Number.isFinite(row.profit) ? row.profit : 0
  const s = typeof row.swap === 'number' && Number.isFinite(row.swap) ? row.swap : 0
  const c = typeof row.commission === 'number' && Number.isFinite(row.commission) ? row.commission : 0
  return p + s + c
}

/** Sum realized P/L for closed buy/sell legs that finished in the given window. */
export function sumTradeableClosedProfitInRange(
  rows: TradeStatsRow[],
  closedBetween: (closedAt: string | null) => boolean,
): number {
  return rows
    .filter(t => isTradeableClosedRow(t) && closedBetween(t.closed_at))
    .reduce((sum, t) => sum + netClosedLegProfit(t), 0)
}

/** Closed buy/sell positions that finished in the window (by `closed_at`). */
export function countClosedTradeOutcomesInRange(
  rows: TradeStatsRow[],
  closedBetween: (closedAt: string | null) => boolean,
): { taken: number; won: number; lost: number } {
  const closed = rows.filter(t => isTradeableClosedRow(t) && closedBetween(t.closed_at))
  return {
    taken: closed.length,
    won: closed.filter(t => netClosedLegProfit(t) > 0).length,
    lost: closed.filter(t => netClosedLegProfit(t) < 0).length,
  }
}

export type LinkedAccountPerformance = {
  /** Return on investment vs performance baseline (%). */
  roi: number | null
  /** Share of closed tradeable legs with net profit > 0 (%). */
  winRate: number | null
  /** Peak-to-trough equity decline from baseline through history (%). */
  maxDrawdownPct: number | null
}

function parseCloseMs(iso: string | null): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

/** Per-account ROI, win rate, and max drawdown from closed trade history + live equity. */
export function computeLinkedAccountPerformance(
  account: {
    performance_baseline_balance?: number | null
    last_balance?: number | null
  },
  trades: TradeStatsRow[],
  liveEquity?: number | null,
): LinkedAccountPerformance {
  const baseline = Number(account.performance_baseline_balance ?? account.last_balance)
  const equity =
    liveEquity != null && Number.isFinite(liveEquity)
      ? liveEquity
      : null

  let roi: number | null = null
  if (Number.isFinite(baseline) && baseline > 0 && equity != null) {
    roi = ((equity - baseline) / baseline) * 100
  }

  const closed = trades.filter(isTradeableClosedRow)
  let winRate: number | null = null
  if (closed.length > 0) {
    const wins = closed.filter(t => netClosedLegProfit(t) > 0).length
    winRate = (wins / closed.length) * 100
  }

  let maxDrawdownPct: number | null = null
  if (Number.isFinite(baseline) && baseline > 0) {
    const sorted = closed.slice().sort((a, b) => parseCloseMs(a.closed_at) - parseCloseMs(b.closed_at))
    let peak = baseline
    let curve = baseline
    let maxDd = 0
    for (const t of sorted) {
      curve += netClosedLegProfit(t)
      if (curve > peak) peak = curve
      if (peak > 0) {
        const dd = ((peak - curve) / peak) * 100
        if (dd > maxDd) maxDd = dd
      }
    }
    if (equity != null) {
      if (equity > peak) peak = equity
      if (peak > 0) {
        const dd = ((peak - equity) / peak) * 100
        if (dd > maxDd) maxDd = dd
      }
    }
    maxDrawdownPct = maxDd
  }

  return { roi, winRate, maxDrawdownPct }
}

export function computeLinkedAccountPerformanceMap(
  accounts: Array<{
    id: string
    performance_baseline_balance?: number | null
    last_balance?: number | null
  }>,
  tradesByAccountId: Record<string, TradeStatsRow[]>,
  equityByAccountId: Record<string, number | undefined>,
): Record<string, LinkedAccountPerformance> {
  const out: Record<string, LinkedAccountPerformance> = {}
  for (const account of accounts) {
    out[account.id] = computeLinkedAccountPerformance(
      account,
      tradesByAccountId[account.id] ?? [],
      equityByAccountId[account.id],
    )
  }
  return out
}
