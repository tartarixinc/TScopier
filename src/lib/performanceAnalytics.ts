import {
  buildTradeVolumeByDays,
  chartTradeDayKey,
  type DashboardChartTrade,
  type TradeVolumeDay,
} from './dashboardCharts'
import {
  CLOSED_TRADE_OUTCOME_EPSILON,
  countClosedTradeOutcomesInRange,
  getLocalCalendarDayBounds,
  isTradeableClosedRow,
  netClosedLegProfit,
  sumTradeableClosedProfitInRange,
  type LinkedAccountPerformance,
  type TradeStatsRow,
} from './dashboardTradeStats'
import { isMtTimestampInRange } from './mtApiDateTime'

export type PerformancePeriod = '7d' | '30d' | '90d' | 'all'

export function periodToDays(period: PerformancePeriod): number {
  if (period === '7d') return 7
  if (period === '30d') return 30
  if (period === '90d') return 90
  return 365
}

export function periodRange(
  period: PerformancePeriod,
  now = new Date(),
): { start: Date | null; end: Date; inRange: (closedAt: string | null) => boolean } {
  const end = new Date(now)
  if (period === 'all') {
    return {
      start: null,
      end,
      inRange: () => true,
    }
  }
  const days = periodToDays(period)
  const { todayStart, tomorrowStart } = getLocalCalendarDayBounds(now)
  const start = new Date(todayStart)
  start.setDate(start.getDate() - (days - 1))
  return {
    start,
    end,
    inRange: (closedAt: string | null) => isMtTimestampInRange(closedAt, start, tomorrowStart),
  }
}

export interface PeriodTradeStats {
  realizedPnl: number
  tradesTaken: number
  tradesWon: number
  tradesLost: number
  winRate: number | null
  profitFactor: number | null
}

/** Headline stats for a Trade Outcome bucket set (must match chart data). */
export function computePeriodStatsFromVolumeBuckets(
  trades: DashboardChartTrade[],
  buckets: TradeVolumeDay[],
): PeriodTradeStats {
  const bucketKeys = new Set(buckets.map(b => b.key))

  let grossProfit = 0
  let grossLoss = 0
  for (const b of buckets) {
    grossProfit += b.profit
    grossLoss += b.loss
  }
  const realizedPnl = grossProfit - grossLoss

  let taken = 0
  let won = 0
  let lost = 0
  for (const t of trades) {
    if (t.status !== 'closed') continue
    const key = chartTradeDayKey(t)
    if (!key || !bucketKeys.has(key)) continue
    const p = t.profit
    if (p == null || !Number.isFinite(p)) continue
    taken++
    if (p > CLOSED_TRADE_OUTCOME_EPSILON) won++
    else if (p < -CLOSED_TRADE_OUTCOME_EPSILON) lost++
  }

  const winRate = taken > 0 ? (won / taken) * 100 : null
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null

  return {
    realizedPnl,
    tradesTaken: taken,
    tradesWon: won,
    tradesLost: lost,
    winRate,
    profitFactor: profitFactor != null && Number.isFinite(profitFactor) ? profitFactor : null,
  }
}

/**
 * Period headline stats aligned with the Trade Outcome chart: same calendar-day
 * buckets and deal `profit` (profit bar − loss bar per day).
 */
export function computePeriodStatsFromChartTrades(
  trades: DashboardChartTrade[],
  period: PerformancePeriod,
  now = new Date(),
): PeriodTradeStats {
  const buckets = buildTradeVolumeByDays(trades, periodToDays(period), now)
  return computePeriodStatsFromVolumeBuckets(trades, buckets)
}

export function computePeriodTradeStats(
  rows: TradeStatsRow[],
  period: PerformancePeriod,
  now = new Date(),
): PeriodTradeStats {
  const { inRange } = periodRange(period, now)
  const realizedPnl = sumTradeableClosedProfitInRange(rows, inRange)
  const { taken, won, lost } = countClosedTradeOutcomesInRange(rows, inRange)
  const winRate = taken > 0 ? (won / taken) * 100 : null

  const grossProfit = rows
    .filter(t => isTradeableClosedRow(t) && inRange(t.closed_at))
    .filter(t => netClosedLegProfit(t) > 0)
    .reduce((s, t) => s + netClosedLegProfit(t), 0)
  const grossLoss = rows
    .filter(t => isTradeableClosedRow(t) && inRange(t.closed_at))
    .filter(t => netClosedLegProfit(t) < 0)
    .reduce((s, t) => s + Math.abs(netClosedLegProfit(t)), 0)
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : null

  return {
    realizedPnl,
    tradesTaken: taken,
    tradesWon: won,
    tradesLost: lost,
    winRate,
    profitFactor: profitFactor != null && Number.isFinite(profitFactor) ? profitFactor : null,
  }
}

export interface AggregatePerformanceSummary {
  avgRoi: number | null
  maxDrawdownPct: number | null
  accountsWithBaseline: number
}

export function aggregateAccountPerformance(
  perAccount: Record<string, LinkedAccountPerformance>,
): AggregatePerformanceSummary {
  const rois: number[] = []
  const dds: number[] = []
  let accountsWithBaseline = 0
  for (const p of Object.values(perAccount)) {
    if (p.roi != null) {
      accountsWithBaseline += 1
      rois.push(p.roi)
    }
    if (p.maxDrawdownPct != null) dds.push(p.maxDrawdownPct)
  }
  const avgRoi = rois.length ? rois.reduce((a, b) => a + b, 0) / rois.length : null
  const maxDrawdownPct = dds.length ? Math.max(...dds) : null
  return { avgRoi, maxDrawdownPct, accountsWithBaseline }
}

export function mtTradesToStatsRows(
  trades: Array<{
    status: string
    profit: number | null
    closed_at: string | null
    opened_at?: string | null
    symbol: string
    lot_size: number
    direction?: string
    type?: string
    swap?: number | null
    commission?: number | null
    broker_id: string
  }>,
): TradeStatsRow[] {
  return trades.map(t => ({
    status: t.status,
    profit: t.profit,
    closed_at: t.closed_at,
    opened_at: t.opened_at ?? null,
    symbol: t.symbol,
    lot_size: t.lot_size,
    direction: t.direction,
    type: t.type,
    swap: t.swap,
    commission: t.commission,
  }))
}

export function chartTradesToStatsRows(trades: DashboardChartTrade[]): TradeStatsRow[] {
  return trades
    .filter(t => t.status === 'closed' && t.closedAt)
    .map(t => ({
      status: 'closed',
      profit: t.profit,
      closed_at: t.closedAt,
      symbol: t.lotSize > 0 ? 'trade' : '',
      lot_size: t.lotSize,
      direction: 'buy',
    }))
}
