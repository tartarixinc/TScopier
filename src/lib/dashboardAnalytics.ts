import type { MtTrade } from './fxsocketBroker'
import {
  buildTradeVolume7Day,
  resolveDashboardChartTrades,
  summarizeTodayFromChartTrades,
  summarizeTodayFromMtTrades,
  summarizeYesterdayFromChartTrades,
  summarizeYesterdayFromMtTrades,
  type DashboardChartTrade,
  type TradeVolumeDay,
} from './dashboardCharts'
import {
  computeProfitByChannel,
  resolveChannelIdForTrade,
  UNLINKED_CHANNEL_KEY,
  type PerformanceChannelLinkMaps,
  type PerformanceDistributionRow,
  type ResolveChannelIdOpts,
} from './performanceInsights'
import {
  filterMtTradesSinceConnect,
  type BrokerConnectAnchor,
} from './tradesSinceConnect'
import { normalizeSignalChannelIds } from './brokerChannelLink'

export type DashboardConnectAccount = BrokerConnectAnchor & {
  signal_channel_ids?: string[] | null
}

/** Closed MT legs attributed to a TSCopier signal channel (excludes manual/unlinked broker trades). */
export function filterCopierAttributedMtTrades(
  trades: MtTrade[],
  maps: PerformanceChannelLinkMaps,
  opts?: ResolveChannelIdOpts,
): MtTrade[] {
  return trades.filter(
    t => resolveChannelIdForTrade(t, maps, opts) !== UNLINKED_CHANNEL_KEY,
  )
}

/** MT history scoped to after broker connect and copier-attributed legs only. */
export function scopeDashboardCopierMtTrades(
  mtTrades: MtTrade[],
  maps: PerformanceChannelLinkMaps,
  accounts?: readonly DashboardConnectAccount[],
  opts?: ResolveChannelIdOpts,
): MtTrade[] {
  const sinceConnect = accounts?.length
    ? filterMtTradesSinceConnect(mtTrades, accounts)
    : mtTrades

  const connectedByBroker = new Map<string, string[]>()
  for (const account of accounts ?? []) {
    if (!account.id) continue
    connectedByBroker.set(account.id, normalizeSignalChannelIds(account.signal_channel_ids))
  }

  return sinceConnect.filter(trade => {
    const resolveOpts: ResolveChannelIdOpts = {
      connectedChannelIds:
        connectedByBroker.get(trade.broker_id)
        ?? opts?.connectedChannelIds
        ?? null,
    }
    return resolveChannelIdForTrade(trade, maps, resolveOpts) !== UNLINKED_CHANNEL_KEY
  })
}

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
    if (nextScore === 0) return prev.length === 0 && next.length > 0 ? next : prev
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
  const mtChart = resolveDashboardChartTrades(mtTrades, [])
  if (mtChart.length > 0) return mtChart
  if (hasMtBroker) return resolveDashboardChartTrades(null, dbTrades)
  return resolveDashboardChartTrades(mtTrades, dbTrades)
}

export type DashboardAnalytics = {
  todayProfit: number
  yesterdayProfit: number
  tradeVolume7Day: TradeVolumeDay[]
  channelProfit7d: PerformanceDistributionRow[]
  tradesTaken: number
  tradesTakenYesterday: number
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
  /** When set, exclude trades before each broker's first TSCopier connect. */
  accounts?: readonly DashboardConnectAccount[]
  now?: Date
}): DashboardAnalytics {
  const now = args.now ?? new Date()
  const hasMtSource = args.mtTrades.length > 0
  const scopedMt = hasMtSource
    ? scopeDashboardCopierMtTrades(args.mtTrades, args.channelLinkMaps, args.accounts)
    : []
  const useMt = scopedMt.length > 0
  const todaySummary = useMt
    ? summarizeTodayFromMtTrades(scopedMt, now)
    : summarizeTodayFromChartTrades(args.chartTrades, now)
  const yesterdaySummary = useMt
    ? summarizeYesterdayFromMtTrades(scopedMt, now)
    : summarizeYesterdayFromChartTrades(args.chartTrades, now)
  const chartForVolume = useMt
    ? resolveDashboardChartTrades(scopedMt, [])
    : args.chartTrades

  return {
    todayProfit: todaySummary.netPnl,
    yesterdayProfit: yesterdaySummary.netPnl,
    tradeVolume7Day: buildTradeVolume7Day(chartForVolume, now),
    channelProfit7d: computeProfitByChannel(
      scopedMt,
      '7d',
      args.channelLinkMaps,
      args.unlinkedLabel,
      now,
    ),
    tradesTaken: todaySummary.taken,
    tradesTakenYesterday: yesterdaySummary.taken,
    tradesWon: todaySummary.won,
    tradesLost: todaySummary.lost,
    tradesBreakeven: todaySummary.breakeven,
  }
}
