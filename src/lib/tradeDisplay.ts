import type { MtTrade } from './fxsocketBroker'
import { directionDisplayLabel, resolveTradeDisplayDirection } from './tradeDirection'
import { formatTradeTimeLabel, resolveTradeDisplayTimeRaw } from './mtTradeTimestamps'

export function formatTradePrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (!Number.isFinite(value) || value === 0) return '—'
  return value.toFixed(5)
}

export function formatTradeLots(lotSize: number): string {
  if (!Number.isFinite(lotSize)) return '—'
  return lotSize.toFixed(2)
}

/** Prefer deal profit; if API returned 0 with swap/commission, show net realized P/L. */
export function displayTradeProfit(trade: MtTrade): number | null {
  const p = trade.profit
  if (p == null || !Number.isFinite(p)) return null
  if (p !== 0 || trade.status !== 'closed') return p
  const swap = typeof trade.swap === 'number' && Number.isFinite(trade.swap) ? trade.swap : 0
  const commission =
    typeof trade.commission === 'number' && Number.isFinite(trade.commission) ? trade.commission : 0
  const net = p + swap + commission
  return net !== 0 ? net : p
}

/** Floating P/L for open legs (profit + swap + commission); tolerates missing profit from REST. */
export function tradeOpenLegProfit(trade: MtTrade): number | null {
  if (trade.status !== 'open') return displayTradeProfit(trade)
  const profit = typeof trade.profit === 'number' && Number.isFinite(trade.profit) ? trade.profit : 0
  const swap = typeof trade.swap === 'number' && Number.isFinite(trade.swap) ? trade.swap : 0
  const commission =
    typeof trade.commission === 'number' && Number.isFinite(trade.commission) ? trade.commission : 0
  return Math.round((profit + swap + commission) * 100) / 100
}

export function getTradeDisplayMeta(trade: MtTrade) {
  const displayDirection = resolveTradeDisplayDirection(trade)
  const isBuy = displayDirection === 'buy'
  const isSell = displayDirection === 'sell'
  const profit = displayTradeProfit(trade)
  const statusConfig: Record<
    string,
    { variant: 'success' | 'warning' | 'error' | 'neutral' | 'primary'; label: string }
  > = {
    open: { variant: 'primary', label: 'Open' },
    closed: { variant: 'neutral', label: 'Closed' },
  }
  const status = statusConfig[trade.status] ?? { variant: 'neutral' as const, label: trade.status }
  const timeLabel = formatTradeTimeLabel(resolveTradeDisplayTimeRaw(trade))
  const broker = trade.broker_name || trade.broker_label || '—'
  const directionLabel = directionDisplayLabel(displayDirection)

  return { isBuy, isSell, profit, status, broker, directionLabel, timeLabel, displayDirection }
}
