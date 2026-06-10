import type { MtTrade } from './metatraderapi'
import {
  buildTradeVolume7Day,
  findTodayTradeOutcomeDay,
  findYesterdayTradeOutcomeDay,
  netPnlFromTradeOutcomeDay,
  resolveDashboardChartTrades,
  summarizeTodayFromChartTrades,
  summarizeTodayFromMtTrades,
  type DashboardChartTrade,
  type TradeVolumeDay,
} from './dashboardCharts'
import {
  computeProfitByChannel,
  type PerformanceChannelLinkMaps,
  type PerformanceDistributionRow,
} from './performanceInsights'

/** Closed chart rows with usable deal profit — proxy for MT-quality P/L data. */
export function chartTradesQualityScore(rows: DashboardChartTrade[]): number {
  return rows.filter(
    t => t.status === 'closed' && t.profit != null && Number.isFinite(t.profit),
  ).length
}

/**
 * Prefer the snapshot with richer closed-deal P/L. When MT brokers are linked,
 * reject DB rows that have tickets but null profit (common after manual closes).
 */
export function preferAuthoritativeChartTrades(
  prev: DashboardChartTrade[],
  next: DashboardChartTrade[],
  opts: { hasMtBroker: boolean },
): DashboardChartTrade[] {
  if (next.length === 0) return prev

  const prevScore = chartTradesQualityScore(prev)
  const nextScore = chartTradesQualityScore(next)

  if (opts.hasMtBroker) {
    if (nextScore === 0) return prev
    if (prevScore > nextScore) return prev
  } else if (prevScore > nextScore) {
    return prev
  }

  if (nextScore > prevScore) return next
  return next.length >= prev.length ? next : prev
}

export function resolveAnalyticsChartTrades(
  mtTrades: MtTrade[] | null | undefined,
  dbTrades: Parameters<typeof resolveDashboardChartTrades>[1],
  hasMtBroker: boolean,
): DashboardChartTrade[] {
  if (hasMtBroker) {
    return resolveDashboardChartTrades(mtTrades, [])
  }
  return resolveDashboardChartTrades(mtTrades, dbTrades)
}

export type DashboardAnalytics = {
  todayProfit: number
  yesterdayProfit: number
  tradeVolume7Day: TradeVolumeDay[]
  channelProfit7d: PerformanceDistributionRow[]
  tradesTaken: number
  tradesWon: number
  tradesLost: number
  tradesBreakeven: number
}

/** Single derived snapshot for Today's Profit, Trade Outcome 7d, and channel P/L 7d. */
export function deriveDashboardAnalytics(args: {
  chartTrades: DashboardChartTrade[]
  mtTrades: MtTrade[]
  channelLinkMaps: PerformanceChannelLinkMaps
  unlinkedLabel: string
  now?: Date
}): DashboardAnalytics {
  const now = args.now ?? new Date()
  const todaySummary =
    args.mtTrades.length > 0
      ? summarizeTodayFromMtTrades(args.mtTrades, now)
      : summarizeTodayFromChartTrades(args.chartTrades, now)
  const todayBucket = findTodayTradeOutcomeDay(args.chartTrades, now)

  return {
    todayProfit: netPnlFromTradeOutcomeDay(todayBucket),
    yesterdayProfit: netPnlFromTradeOutcomeDay(findYesterdayTradeOutcomeDay(args.chartTrades, now)),
    tradeVolume7Day: buildTradeVolume7Day(args.chartTrades, now),
    channelProfit7d: computeProfitByChannel(
      args.mtTrades,
      '7d',
      args.channelLinkMaps,
      args.unlinkedLabel,
      now,
    ),
    tradesTaken: todaySummary.taken,
    tradesWon: todaySummary.won,
    tradesLost: todaySummary.lost,
    tradesBreakeven: todaySummary.breakeven,
  }
}
