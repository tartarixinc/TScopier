import { isMtTimestampInRange } from './mtApiDateTime'

/** Shared filters for dashboard closed-trade P/L and win/loss counts. */

export type TradeStatsRow = {
  status?: string
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
  status?: string
  symbol: string
  lot_size: number
  direction?: string
  type?: string
}): boolean {
  if ((row.status ?? 'closed') !== 'closed') return false
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
  if ((row.lot_size ?? 0) <= 0) return false
  return dir === 'buy' || dir === 'sell'
}

/** Minimum |deal profit| to classify a close as won or lost (not breakeven). */
export const CLOSED_TRADE_OUTCOME_EPSILON = 0.01

/** Deal profit column from MT closed history (not swap/commission). */
export function closedDealProfit(row: TradeStatsRow): number | null {
  const p = row.profit
  if (typeof p !== 'number' || !Number.isFinite(p)) return null
  return p
}

/**
 * MT closed deal eligible for today's win/loss count (matches terminal deal profit column).
 */
export function isMtClosedDealForOutcome(row: TradeStatsRow & { status?: string }): boolean {
  if ((row.status ?? 'closed') !== 'closed') return false
  if (!isTradeableClosedRow(row)) return false
  return closedDealProfit(row) != null
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

/**
 * Sum profit+swap+commission for closed winning legs only (losses excluded).
 * Matches broker terminals that show "profit today" separate from losses.
 */
export function sumClosedWinningProfitInRange(
  rows: TradeStatsRow[],
  closedBetween: (closedAt: string | null) => boolean,
): number {
  return rows
    .filter(t => isTradeableClosedRow(t) && closedBetween(t.closed_at))
    .reduce((sum, t) => {
      const net = netClosedLegProfit(t)
      return net > 0 ? sum + net : sum
    }, 0)
}

/** Local calendar midnight → next midnight (browser timezone). */
/** Count chart/MT rows whose open time falls in [start, end). */
export function countChartTradesOpenedInRange(
  trades: Array<{ openedAt: string | null; closedAt?: string | null }>,
  start: Date,
  end: Date,
): number {
  return trades.filter(t => isMtTimestampInRange(t.openedAt ?? t.closedAt ?? null, start, end)).length
}

export function getLocalCalendarDayBounds(ref = new Date()): {
  todayStart: Date
  tomorrowStart: Date
  yesterdayStart: Date
} {
  const todayStart = new Date(ref)
  todayStart.setHours(0, 0, 0, 0)
  const tomorrowStart = new Date(todayStart)
  tomorrowStart.setDate(tomorrowStart.getDate() + 1)
  const yesterdayStart = new Date(todayStart)
  yesterdayStart.setDate(yesterdayStart.getDate() - 1)
  return { todayStart, tomorrowStart, yesterdayStart }
}

export function isTimestampInRange(
  iso: string | null | undefined,
  start: Date,
  end: Date,
): boolean {
  if (!iso) return false
  const ts = new Date(iso).getTime()
  return Number.isFinite(ts) && ts >= start.getTime() && ts < end.getTime()
}

/**
 * Count closed MT deals in the window by deal `profit` (same column as the terminal).
 * Swap/commission are not used for win/loss — they were turning wins into false losses.
 */
export function countClosedTradeOutcomesInRange(
  rows: TradeStatsRow[],
  closedBetween: (closedAt: string | null) => boolean,
): { taken: number; won: number; lost: number; breakeven: number } {
  const closed = rows.filter(
    t => isMtClosedDealForOutcome(t) && closedBetween(t.closed_at),
  )
  let won = 0
  let lost = 0
  let breakeven = 0
  for (const t of closed) {
    const p = closedDealProfit(t)!
    if (p > CLOSED_TRADE_OUTCOME_EPSILON) won++
    else if (p < -CLOSED_TRADE_OUTCOME_EPSILON) lost++
    else breakeven++
  }
  return { taken: closed.length, won, lost, breakeven }
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

/** Per-account ROI, win rate, and max drawdown from closed trade history (deposits excluded). */
export function computeLinkedAccountPerformance(
  account: {
    performance_baseline_balance?: number | null
    last_balance?: number | null
  },
  trades: TradeStatsRow[],
  _liveEquity?: number | null,
): LinkedAccountPerformance {
  const baseline = Number(account.performance_baseline_balance ?? account.last_balance)
  const closed = trades.filter(isMtClosedDealForOutcome)

  let roi: number | null = null
  if (Number.isFinite(baseline) && baseline > 0 && closed.length > 0) {
    const realizedPnl = closed.reduce((sum, t) => sum + (closedDealProfit(t) ?? 0), 0)
    roi = (realizedPnl / baseline) * 100
  }

  let winRate: number | null = null
  if (closed.length > 0) {
    const wins = closed.filter(t => (closedDealProfit(t) ?? 0) > CLOSED_TRADE_OUTCOME_EPSILON).length
    winRate = (wins / closed.length) * 100
  }

  let maxDrawdownPct: number | null = null
  if (Number.isFinite(baseline) && baseline > 0) {
    const sorted = closed.slice().sort((a, b) => parseCloseMs(a.closed_at) - parseCloseMs(b.closed_at))
    let peak = baseline
    let curve = baseline
    let maxDd = 0
    for (const t of sorted) {
      curve += closedDealProfit(t) ?? 0
      if (curve > peak) peak = curve
      if (peak > 0) {
        const dd = ((peak - curve) / peak) * 100
        if (dd > maxDd) maxDd = dd
      }
    }
    maxDrawdownPct = maxDd
  }

  return { roi, winRate, maxDrawdownPct }
}

export function sumRealizedClosedDealProfit(rows: TradeStatsRow[]): number {
  return rows
    .filter(isMtClosedDealForOutcome)
    .reduce((sum, t) => sum + (closedDealProfit(t) ?? 0), 0)
}

export function aggregateRealizedProfitFromTrades(
  accounts: Array<{ id: string }>,
  tradesByAccountId: Record<string, TradeStatsRow[]>,
): number | null {
  let sum = 0
  let hasAny = false
  for (const account of accounts) {
    const pnl = sumRealizedClosedDealProfit(tradesByAccountId[account.id] ?? [])
    if ((tradesByAccountId[account.id] ?? []).some(isMtClosedDealForOutcome)) {
      sum += pnl
      hasAny = true
    }
  }
  return hasAny ? sum : null
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
