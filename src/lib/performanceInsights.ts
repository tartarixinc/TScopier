import type { AccountGrowthSeries } from './dashboardCharts'
import {
  buildTradeVolumeByDays,
  netPnlFromTradeOutcomeDay,
  type DashboardChartTrade,
  type TradeVolumeDay,
} from './dashboardCharts'
import { displayTradeProfit } from './tradeDisplay'
import { parseTscopierComment } from './tradeSignalLink'
import type { MtTrade } from './metatraderapi'
import { periodRange, periodToDays, type PerformancePeriod } from './performanceAnalytics'

export const UNLINKED_CHANNEL_KEY = '__unlinked__'

export interface PerformanceChannelLinkMaps {
  ticketToChannelId: Record<string, string>
  signalPrefixToChannelId: Record<string, string>
  channelNames: Record<string, string>
}

export interface TradeChannelAttributionRow {
  broker_account_id: string | null
  metaapi_order_id: string | null
  signal_id: string | null
  channel_id: string | null
  channel_label?: string | null
}

export interface PerformanceDayHighlight {
  label: string
  pnl: number
}

export interface PerformanceTradeHighlight {
  symbol: string
  pnl: number
  broker: string
  timeLabel: string
}

export interface PerformanceEquityHighlight {
  value: number
  dateLabel: string
  accountName: string
}

export interface PerformanceDistributionRow {
  key: string
  label: string
  count: number
  pnl: number
}

export interface PerformanceInsights {
  bestDay: PerformanceDayHighlight | null
  worstDay: PerformanceDayHighlight | null
  bestTrade: PerformanceTradeHighlight | null
  worstTrade: PerformanceTradeHighlight | null
  highestEquity: PerformanceEquityHighlight | null
  lowestEquity: PerformanceEquityHighlight | null
  symbolDistribution: PerformanceDistributionRow[]
  profitByChannel: PerformanceDistributionRow[]
}

function closedMtTradesInPeriod(trades: MtTrade[], period: PerformancePeriod, now = new Date()): MtTrade[] {
  const { inRange } = periodRange(period, now)
  return trades.filter(t => {
    if (t.status !== 'closed') return false
    const closeIso = t.closed_at ?? t.opened_at
    return closeIso != null && inRange(closeIso)
  })
}

function formatTradeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function computeBestWorstDays(
  buckets: TradeVolumeDay[],
): { bestDay: PerformanceDayHighlight | null; worstDay: PerformanceDayHighlight | null } {
  let bestDay: PerformanceDayHighlight | null = null
  let worstDay: PerformanceDayHighlight | null = null

  for (const bucket of buckets) {
    const pnl = netPnlFromTradeOutcomeDay(bucket)
    if (pnl === 0 && bucket.profit === 0 && bucket.loss === 0) continue
    if (!bestDay || pnl > bestDay.pnl) {
      bestDay = { label: bucket.label, pnl }
    }
    if (!worstDay || pnl < worstDay.pnl) {
      worstDay = { label: bucket.label, pnl }
    }
  }

  return { bestDay, worstDay }
}

export function computeBestWorstTrades(
  trades: MtTrade[],
  period: PerformancePeriod,
  unlinkedLabel: string,
  now = new Date(),
): { bestTrade: PerformanceTradeHighlight | null; worstTrade: PerformanceTradeHighlight | null } {
  const closed = closedMtTradesInPeriod(trades, period, now)
  let bestTrade: PerformanceTradeHighlight | null = null
  let worstTrade: PerformanceTradeHighlight | null = null

  for (const trade of closed) {
    const pnl = displayTradeProfit(trade)
    if (pnl == null || !Number.isFinite(pnl)) continue
    const row: PerformanceTradeHighlight = {
      symbol: trade.symbol?.trim() || '—',
      pnl,
      broker: trade.broker_name || trade.broker_label || unlinkedLabel,
      timeLabel: formatTradeTime(trade.closed_at ?? trade.opened_at),
    }
    if (!bestTrade || pnl > bestTrade.pnl) bestTrade = row
    if (!worstTrade || pnl < worstTrade.pnl) worstTrade = row
  }

  return { bestTrade, worstTrade }
}

export function computeEquityExtremes(
  data: Array<Record<string, string | number>>,
  series: AccountGrowthSeries[],
): { highestEquity: PerformanceEquityHighlight | null; lowestEquity: PerformanceEquityHighlight | null } {
  if (data.length === 0 || series.length === 0) {
    return { highestEquity: null, lowestEquity: null }
  }

  let highestEquity: PerformanceEquityHighlight | null = null
  let lowestEquity: PerformanceEquityHighlight | null = null

  for (const row of data) {
    const dateLabel = String(row.label ?? '')
    for (const s of series) {
      const dataKey = `acc_${s.id.replace(/-/g, '')}`
      const raw = row[dataKey]
      const value = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(value)) continue
      const point = { value, dateLabel, accountName: s.name }
      if (!highestEquity || value > highestEquity.value) highestEquity = point
      if (!lowestEquity || value < lowestEquity.value) lowestEquity = point
    }
  }

  return { highestEquity, lowestEquity }
}

export function computeSymbolDistribution(
  trades: MtTrade[],
  period: PerformancePeriod,
  topN = 8,
  now = new Date(),
): PerformanceDistributionRow[] {
  const closed = closedMtTradesInPeriod(trades, period, now)
  const bySymbol = new Map<string, { count: number; pnl: number }>()

  for (const trade of closed) {
    const symbol = trade.symbol?.trim() || '—'
    const pnl = displayTradeProfit(trade) ?? 0
    const prev = bySymbol.get(symbol) ?? { count: 0, pnl: 0 }
    bySymbol.set(symbol, { count: prev.count + 1, pnl: prev.pnl + pnl })
  }

  const sorted = [...bySymbol.entries()]
    .map(([symbol, stats]) => ({
      key: symbol,
      label: symbol,
      count: stats.count,
      pnl: stats.pnl,
    }))
    .sort((a, b) => b.count - a.count)

  if (sorted.length <= topN) return sorted

  const head = sorted.slice(0, topN)
  const tail = sorted.slice(topN)
  const other = tail.reduce(
    (acc, row) => ({
      count: acc.count + row.count,
      pnl: acc.pnl + row.pnl,
    }),
    { count: 0, pnl: 0 },
  )
  return [
    ...head,
    { key: '__other__', label: 'Other', count: other.count, pnl: other.pnl },
  ]
}

function resolveChannelIdForTrade(
  trade: MtTrade,
  maps: PerformanceChannelLinkMaps,
): string {
  const ticketKey = `${trade.broker_id}:${trade.ticket}`
  const fromTicket = maps.ticketToChannelId[ticketKey]
  if (fromTicket) return fromTicket

  const parsed = parseTscopierComment(trade.comment)
  if (parsed?.signalIdPrefix) {
    const fromPrefix = maps.signalPrefixToChannelId[parsed.signalIdPrefix.toLowerCase()]
    if (fromPrefix) return fromPrefix
  }

  if (parsed?.channelSlug) {
    const slug = parsed.channelSlug.toLowerCase()
    for (const [channelId, name] of Object.entries(maps.channelNames)) {
      if (name.toLowerCase().includes(slug) || channelId === slug) return channelId
    }
  }

  return UNLINKED_CHANNEL_KEY
}

export function computeProfitByChannel(
  trades: MtTrade[],
  period: PerformancePeriod,
  maps: PerformanceChannelLinkMaps,
  unlinkedLabel: string,
  now = new Date(),
): PerformanceDistributionRow[] {
  const closed = closedMtTradesInPeriod(trades, period, now)
  const byChannel = new Map<string, { count: number; pnl: number }>()

  for (const trade of closed) {
    const channelId = resolveChannelIdForTrade(trade, maps)
    const pnl = displayTradeProfit(trade) ?? 0
    const prev = byChannel.get(channelId) ?? { count: 0, pnl: 0 }
    byChannel.set(channelId, { count: prev.count + 1, pnl: prev.pnl + pnl })
  }

  return [...byChannel.entries()]
    .map(([channelId, stats]) => ({
      key: channelId,
      label:
        channelId === UNLINKED_CHANNEL_KEY
          ? unlinkedLabel
          : maps.channelNames[channelId] ?? unlinkedLabel,
      count: stats.count,
      pnl: stats.pnl,
    }))
    .sort((a, b) => b.pnl - a.pnl)
}

export function buildPerformanceChannelLinkMaps(
  channels: Array<{ id: string; display_name: string; channel_username?: string | null }>,
  dbTrades: Array<{
    broker_account_id: string | null
    metaapi_order_id: string | null
    signal_id: string | null
  }>,
  signals: Array<{ id: string; channel_id: string | null }>,
  attributions: TradeChannelAttributionRow[] = [],
): PerformanceChannelLinkMaps {
  const channelNames: Record<string, string> = {}
  for (const ch of channels) {
    channelNames[ch.id] = ch.display_name?.trim() || ch.channel_username?.trim() || 'Channel'
  }

  const signalToChannel: Record<string, string> = {}
  for (const s of signals) {
    if (s.channel_id) signalToChannel[s.id] = s.channel_id
  }

  const signalPrefixToChannelId: Record<string, string> = {}
  for (const s of signals) {
    if (!s.channel_id) continue
    const prefix = s.id.slice(0, 8).toLowerCase()
    if (!signalPrefixToChannelId[prefix]) {
      signalPrefixToChannelId[prefix] = s.channel_id
    }
  }

  for (const a of attributions) {
    if (a.channel_id && a.channel_label?.trim() && !channelNames[a.channel_id]) {
      channelNames[a.channel_id] = a.channel_label.trim()
    }
    if (a.signal_id && a.channel_id && !signalToChannel[a.signal_id]) {
      signalToChannel[a.signal_id] = a.channel_id
    }
  }

  const ticketToChannelId: Record<string, string> = {}
  for (const a of attributions) {
    if (!a.broker_account_id || !a.metaapi_order_id || !a.channel_id) continue
    ticketToChannelId[`${a.broker_account_id}:${a.metaapi_order_id}`] = a.channel_id
  }
  for (const t of dbTrades) {
    if (!t.broker_account_id || !t.metaapi_order_id || !t.signal_id) continue
    const key = `${t.broker_account_id}:${t.metaapi_order_id}`
    if (ticketToChannelId[key]) continue
    const channelId = signalToChannel[t.signal_id]
    if (!channelId) continue
    ticketToChannelId[key] = channelId
  }

  return { ticketToChannelId, signalPrefixToChannelId, channelNames }
}

export function computePerformanceInsights(opts: {
  mtTrades: MtTrade[]
  chartTrades: DashboardChartTrade[]
  period: PerformancePeriod
  channelMaps: PerformanceChannelLinkMaps
  accountGrowthData: Array<Record<string, string | number>>
  accountGrowthSeries: AccountGrowthSeries[]
  unlinkedChannelLabel: string
  otherSymbolsLabel: string
  now?: Date
}): PerformanceInsights {
  const now = opts.now ?? new Date()
  const buckets = buildTradeVolumeByDays(
    opts.chartTrades,
    periodToDays(opts.period),
    now,
  )
  const { bestDay, worstDay } = computeBestWorstDays(buckets)
  const { bestTrade, worstTrade } = computeBestWorstTrades(
    opts.mtTrades,
    opts.period,
    opts.unlinkedChannelLabel,
    now,
  )
  const { highestEquity, lowestEquity } = computeEquityExtremes(
    opts.accountGrowthData,
    opts.accountGrowthSeries,
  )
  const symbolRows = computeSymbolDistribution(opts.mtTrades, opts.period, 8, now).map(row =>
    row.key === '__other__' ? { ...row, label: opts.otherSymbolsLabel } : row,
  )
  const profitByChannel = computeProfitByChannel(
    opts.mtTrades,
    opts.period,
    opts.channelMaps,
    opts.unlinkedChannelLabel,
    now,
  )

  return {
    bestDay,
    worstDay,
    bestTrade,
    worstTrade,
    highestEquity,
    lowestEquity,
    symbolDistribution: symbolRows,
    profitByChannel,
  }
}
