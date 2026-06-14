import type { DashboardChartTrade } from './dashboardCharts'
import { summarizeTodayFromChartTrades } from './dashboardCharts'
import {
  getLocalCalendarDayBounds,
  isTradeableClosedRow,
  isTradeableOpenRow,
  sumBalanceCashFlow,
  sumRealizedClosedDealProfit,
  type TradeStatsRow,
} from './dashboardTradeStats'
import { displayTradeProfit, tradeOpenLegProfit } from './tradeDisplay'
import type { MtTrade } from './fxsocketBroker'
import { normalizeSignalChannelIds } from './brokerChannelLink'
import {
  canonicalChannelId,
  computeProfitByChannel,
  resolveChannelIdForTrade,
  UNLINKED_CHANNEL_KEY,
  type PerformanceChannelLinkMaps,
  type PerformanceDistributionRow,
  type ResolveChannelIdOpts,
} from './performanceInsights'
import { isMtTimestampInRange } from './mtApiDateTime'

export type BrokerLastSignalTrade = {
  channelId: string
  channelLabel: string
  symbol: string
  pnl: number
  closedAt: string
  ticket: number
}

export type BrokerActiveSignalTrade = {
  channelId: string
  channelLabel: string
  totalLots: number
  pnl: number
  positionCount: number
}

export type BrokerStatsSnapshot = {
  initialBalance: number | null
  currentBalance: number | null
  currentEquity: number | null
  totalProfit: number
  todayProfit: number
  closedDealCount: number
  connectedChannelCount: number
  profitByChannel: PerformanceDistributionRow[]
  activeSignalTrades: BrokerActiveSignalTrade[]
  lastSignalTrade: BrokerLastSignalTrade | null
}

function mtTradesForBroker(trades: MtTrade[], brokerId: string): MtTrade[] {
  return trades.filter(t => t.broker_id === brokerId)
}

function chartTradesForBroker(trades: DashboardChartTrade[], brokerId: string): DashboardChartTrade[] {
  return trades.filter(t => t.brokerAccountId === brokerId)
}

function statsRowsForBroker(trades: MtTrade[]): TradeStatsRow[] {
  return trades.map(t => ({
    status: t.status,
    profit: t.profit,
    closed_at: t.closed_at,
    symbol: t.symbol,
    lot_size: t.lot_size,
    direction: t.direction,
    type: t.type,
    swap: t.swap,
    commission: t.commission,
  }))
}

export function computeBrokerTodayProfit(
  brokerId: string,
  mtTrades: MtTrade[],
  chartTrades: DashboardChartTrade[],
  now = new Date(),
): number {
  const brokerChart = chartTradesForBroker(chartTrades, brokerId)
  if (brokerChart.length > 0) {
    return summarizeTodayFromChartTrades(brokerChart, now).netPnl
  }
  const { todayStart, tomorrowStart } = getLocalCalendarDayBounds(now)
  let net = 0
  for (const t of mtTradesForBroker(mtTrades, brokerId)) {
    if (t.status !== 'closed') continue
    if (
      !isTradeableClosedRow({
        status: t.status,
        symbol: t.symbol,
        lot_size: t.lot_size,
        direction: t.direction,
        type: t.type,
      })
    ) {
      continue
    }
    const closeIso = t.closed_at ?? t.opened_at
    if (!closeIso || !isMtTimestampInRange(closeIso, todayStart, tomorrowStart)) continue
    const p = displayTradeProfit(t)
    if (p == null || !Number.isFinite(p)) continue
    net += p
  }
  return net
}

/**
 * Total P/L from balance change since link, minus deposit/withdrawal cash flows
 * detected in MT history (so a 10K deposit does not inflate trading P/L).
 *
 * Requires full broker order history (see PERFORMANCE_MT_HISTORY_DAYS) so cash-flow
 * rows are not missed — partial history produces a misleading interim figure.
 */
export function computeBrokerBalanceProfit(
  initialBalance: number | null | undefined,
  currentBalance: number | null | undefined,
  mtTrades: MtTrade[] = [],
  brokerId?: string,
): number | null {
  const initial =
    initialBalance != null && Number.isFinite(Number(initialBalance))
      ? Number(initialBalance)
      : null
  const balance =
    currentBalance != null && Number.isFinite(Number(currentBalance))
      ? Number(currentBalance)
      : null
  if (initial == null || balance == null) return null
  const rawDelta = balance - initial
  if (!brokerId || !mtTrades.length) return rawDelta
  const cashFlow = sumBalanceCashFlow(statsRowsForBroker(mtTradesForBroker(mtTrades, brokerId)))
  return rawDelta - cashFlow
}

export function computeBrokerTotalProfit(
  brokerId: string,
  mtTrades: MtTrade[],
  chartTrades: DashboardChartTrade[],
): number {
  const brokerChart = chartTradesForBroker(chartTrades, brokerId)
  if (brokerChart.length > 0) {
    return brokerChart
      .filter(t => t.status === 'closed')
      .reduce((sum, t) => {
        const p = t.profit
        return p != null && Number.isFinite(p) ? sum + p : sum
      }, 0)
  }
  return sumRealizedClosedDealProfit(statsRowsForBroker(mtTradesForBroker(mtTrades, brokerId)))
}

export function findLastAttributedSignalTrade(
  brokerId: string,
  mtTrades: MtTrade[],
  maps: PerformanceChannelLinkMaps,
  connectedChannelIds?: string[] | null,
): BrokerLastSignalTrade | null {
  const brokerTrades = mtTradesForBroker(mtTrades, brokerId)
  const resolveOpts: ResolveChannelIdOpts = { connectedChannelIds }
  let best: BrokerLastSignalTrade | null = null
  let bestMs = 0

  for (const trade of brokerTrades) {
    if (trade.status !== 'closed') continue
    if (
      !isTradeableClosedRow({
        status: trade.status,
        symbol: trade.symbol,
        lot_size: trade.lot_size,
        direction: trade.direction,
        type: trade.type,
      })
    ) {
      continue
    }
    const channelId = resolveChannelIdForTrade(trade, maps, resolveOpts)
    if (channelId === UNLINKED_CHANNEL_KEY) continue
    const pnl = displayTradeProfit(trade)
    if (pnl == null || !Number.isFinite(pnl)) continue
    const closeIso = trade.closed_at ?? trade.opened_at
    if (!closeIso) continue
    const ms = new Date(closeIso).getTime()
    if (!Number.isFinite(ms) || ms < bestMs) continue
    bestMs = ms
    best = {
      channelId,
      channelLabel: maps.channelNames[channelId] ?? '—',
      symbol: trade.symbol?.trim() || '—',
      pnl,
      closedAt: closeIso,
      ticket: trade.ticket,
    }
  }

  return best
}

function parseOpenMs(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/** Lifetime P/L per connected signal channel (realized closed + open unrealized). */
export function computeBrokerProfitByChannel(opts: {
  brokerId: string
  connectedChannelIds?: string[] | null
  mtTrades: MtTrade[]
  channelLinkMaps: PerformanceChannelLinkMaps
  unlinkedChannelLabel: string
  now?: Date
}): PerformanceDistributionRow[] {
  const brokerMt = mtTradesForBroker(opts.mtTrades, opts.brokerId)
  const closedRows = computeProfitByChannel(
    brokerMt,
    'all',
    opts.channelLinkMaps,
    opts.unlinkedChannelLabel,
    opts.now,
    opts.connectedChannelIds,
  )
  const openRows = findActiveAttributedSignalTrades(
    opts.brokerId,
    opts.mtTrades,
    opts.channelLinkMaps,
    opts.connectedChannelIds,
  )

  const merged = new Map<string, PerformanceDistributionRow>()
  for (const row of closedRows) {
    merged.set(row.key, { ...row })
  }
  for (const row of openRows) {
    const key = row.channelId
    const existing = merged.get(key)
    if (existing) {
      existing.pnl = Math.round((existing.pnl + row.pnl) * 100) / 100
      continue
    }
    merged.set(key, {
      key,
      label: row.channelLabel,
      count: 0,
      pnl: row.pnl,
    })
  }

  for (const rawId of normalizeSignalChannelIds(opts.connectedChannelIds)) {
    const channelId = canonicalChannelId(rawId, opts.channelLinkMaps)
    if (merged.has(channelId)) continue
    merged.set(channelId, {
      key: channelId,
      label: opts.channelLinkMaps.channelNames[channelId] ?? opts.unlinkedChannelLabel,
      count: 0,
      pnl: 0,
    })
  }

  return [...merged.values()].sort((a, b) => b.pnl - a.pnl || a.label.localeCompare(b.label))
}

export function findActiveAttributedSignalTrades(
  brokerId: string,
  mtTrades: MtTrade[],
  maps: PerformanceChannelLinkMaps,
  connectedChannelIds?: string[] | null,
): BrokerActiveSignalTrade[] {
  const resolveOpts: ResolveChannelIdOpts = { connectedChannelIds }
  const byChannel = new Map<
    string,
    BrokerActiveSignalTrade & { latestOpenMs: number }
  >()

  for (const trade of mtTradesForBroker(mtTrades, brokerId)) {
    if (trade.status !== 'open') continue
    if (
      !isTradeableOpenRow({
        status: trade.status,
        symbol: trade.symbol,
        lot_size: trade.lot_size,
        direction: trade.direction,
        type: trade.type,
      })
    ) {
      continue
    }
    const channelId = resolveChannelIdForTrade(trade, maps, resolveOpts)
    if (channelId === UNLINKED_CHANNEL_KEY) continue
    const pnl = tradeOpenLegProfit(trade)
    if (pnl == null || !Number.isFinite(pnl)) continue

    const openedAt = trade.opened_at ?? trade.closed_at
    const openMs = parseOpenMs(openedAt)
    const lots = Number.isFinite(trade.lot_size) ? trade.lot_size : 0
    const existing = byChannel.get(channelId)
    if (existing) {
      existing.totalLots += lots
      existing.pnl += pnl
      existing.positionCount += 1
      if (openMs > existing.latestOpenMs) existing.latestOpenMs = openMs
      continue
    }
    byChannel.set(channelId, {
      channelId,
      channelLabel: maps.channelNames[channelId] ?? '—',
      totalLots: lots,
      pnl,
      positionCount: 1,
      latestOpenMs: openMs,
    })
  }

  return [...byChannel.values()]
    .sort((a, b) => b.latestOpenMs - a.latestOpenMs || b.pnl - a.pnl)
    .map(({ latestOpenMs: _drop, ...row }) => ({
      ...row,
      totalLots: Math.round(row.totalLots * 100) / 100,
      pnl: Math.round(row.pnl * 100) / 100,
    }))
}

export function computeBrokerStatsSnapshot(opts: {
  brokerId: string
  /** Balance captured when this broker was first connected (`performance_baseline_balance`). */
  initialBalance: number | null | undefined
  currentBalance: number | null | undefined
  currentEquity: number | null | undefined
  mtTrades: MtTrade[]
  chartTrades: DashboardChartTrade[]
  channelLinkMaps: PerformanceChannelLinkMaps
  connectedChannelIds?: string[] | null
  unlinkedChannelLabel: string
  now?: Date
}): BrokerStatsSnapshot {
  const brokerMt = mtTradesForBroker(opts.mtTrades, opts.brokerId)
  const profitByChannel = computeBrokerProfitByChannel({
    brokerId: opts.brokerId,
    connectedChannelIds: opts.connectedChannelIds,
    mtTrades: opts.mtTrades,
    channelLinkMaps: opts.channelLinkMaps,
    unlinkedChannelLabel: opts.unlinkedChannelLabel,
    now: opts.now,
  })
  const closedDealCount = brokerMt.filter(
    t =>
      t.status === 'closed' &&
      isTradeableClosedRow({
        status: t.status,
        symbol: t.symbol,
        lot_size: t.lot_size,
        direction: t.direction,
        type: t.type,
      }) &&
      displayTradeProfit(t) != null,
  ).length

  const initialBalance =
    opts.initialBalance != null && Number.isFinite(Number(opts.initialBalance)) && Number(opts.initialBalance) > 0
      ? Number(opts.initialBalance)
      : null
  const balance =
    opts.currentBalance != null && Number.isFinite(Number(opts.currentBalance))
      ? Number(opts.currentBalance)
      : null
  const equity =
    opts.currentEquity != null && Number.isFinite(Number(opts.currentEquity))
      ? Number(opts.currentEquity)
      : null

  const balanceProfit = computeBrokerBalanceProfit(initialBalance, balance, opts.mtTrades, opts.brokerId)
  const dealProfit = computeBrokerTotalProfit(opts.brokerId, opts.mtTrades, opts.chartTrades)

  return {
    initialBalance,
    currentBalance: balance,
    currentEquity: equity,
    totalProfit: balanceProfit ?? dealProfit,
    todayProfit: computeBrokerTodayProfit(opts.brokerId, opts.mtTrades, opts.chartTrades, opts.now),
    closedDealCount,
    connectedChannelCount: profitByChannel.length,
    profitByChannel,
    activeSignalTrades: findActiveAttributedSignalTrades(
      opts.brokerId,
      opts.mtTrades,
      opts.channelLinkMaps,
      opts.connectedChannelIds,
    ),
    lastSignalTrade: enrichLastSignalTradeWithChannelTotal(
      findLastAttributedSignalTrade(
        opts.brokerId,
        opts.mtTrades,
        opts.channelLinkMaps,
        opts.connectedChannelIds,
      ),
      profitByChannel,
    ),
  }
}

function enrichLastSignalTradeWithChannelTotal(
  lastTrade: BrokerLastSignalTrade | null,
  profitByChannel: PerformanceDistributionRow[],
): BrokerLastSignalTrade | null {
  if (!lastTrade) return null
  const channelRow = profitByChannel.find(row => row.key === lastTrade.channelId)
  if (channelRow == null) return lastTrade
  return { ...lastTrade, pnl: channelRow.pnl }
}
