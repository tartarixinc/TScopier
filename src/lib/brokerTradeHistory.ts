import {
  DASHBOARD_CHART_MT_HISTORY_DAYS,
  PERFORMANCE_MT_HISTORY_DAYS,
} from './dashboardCharts'
import { getLocalCalendarDayBounds } from './dashboardTradeStats'
import { fxsocketBroker, type MtTrade } from './fxsocketBroker'
import { formatLocalMtApiDateTime } from './mtApiDateTime'
import { resolveBrokerConnectMs, type BrokerConnectAnchor } from './tradesSinceConnect'

export type BrokerMtHistoryScope = 'dashboard' | 'performance'

const DEFAULT_HISTORY_DAYS: Record<BrokerMtHistoryScope, number> = {
  dashboard: DASHBOARD_CHART_MT_HISTORY_DAYS,
  performance: PERFORMANCE_MT_HISTORY_DAYS,
}

/** Narrow MT history window to chart range and broker connect dates. */
export function resolveDashboardMtHistoryFrom(
  accounts: readonly BrokerConnectAnchor[],
  historyDays: number = DASHBOARD_CHART_MT_HISTORY_DAYS,
): Date {
  const chartFrom = new Date()
  chartFrom.setDate(chartFrom.getDate() - historyDays)
  chartFrom.setHours(0, 0, 0, 0)

  let earliestConnectMs = Number.POSITIVE_INFINITY
  for (const account of accounts) {
    const connectMs = resolveBrokerConnectMs(account)
    if (connectMs != null) earliestConnectMs = Math.min(earliestConnectMs, connectMs)
  }

  if (Number.isFinite(earliestConnectMs)) {
    return new Date(Math.max(chartFrom.getTime(), earliestConnectMs))
  }
  return chartFrom
}

/** Pull open positions + closed deal history from linked FxSocket brokers (edge `trades` action). */
export async function fetchBrokerMtTrades(opts: {
  scope?: BrokerMtHistoryScope
  brokerId?: string
  historyProfile?: 'dashboard' | 'trades'
  historyDays?: number
  limit?: number
  /** When set (dashboard scope), history starts at max(chart window, broker connect). */
  accounts?: readonly BrokerConnectAnchor[]
  /** Skip OrderHistory balance rows — dashboard analytics only needs position deals. */
  includeBalanceCashflow?: boolean
} = {}): Promise<MtTrade[]> {
  const scope = opts.scope ?? 'dashboard'
  const historyDays = opts.historyDays ?? DEFAULT_HISTORY_DAYS[scope]
  const historyProfile = opts.historyProfile ?? (scope === 'dashboard' ? 'dashboard' : 'trades')
  const { tomorrowStart: historyTo } = getLocalCalendarDayBounds()
  const historyFrom = scope === 'dashboard' && opts.accounts?.length
    ? resolveDashboardMtHistoryFrom(opts.accounts, historyDays)
    : (() => {
        const from = new Date()
        from.setDate(from.getDate() - historyDays)
        return from
      })()

  const res = await fxsocketBroker.trades({
    brokerId: opts.brokerId,
    scope: 'all',
    historyProfile,
    historyFrom: formatLocalMtApiDateTime(historyFrom),
    historyTo: formatLocalMtApiDateTime(historyTo),
    ...(opts.limit != null && opts.limit > 0 ? { limit: opts.limit } : {}),
    ...(opts.includeBalanceCashflow === false ? { includeBalanceCashflow: false } : {}),
  })
  return res.trades ?? []
}
