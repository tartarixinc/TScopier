import type { MtTrade } from './metatraderapi'
import { directionDisplayLabel, resolveTradeDisplayDirection } from './tradeDirection'

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
  const timeIso = trade.status === 'closed' ? (trade.closed_at ?? trade.opened_at) : trade.opened_at
  const broker = trade.broker_name || trade.broker_label || '—'
  const directionLabel = directionDisplayLabel(displayDirection)
  const timeLabel = timeIso
    ? new Date(timeIso).toLocaleString([], {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

  return { isBuy, isSell, profit, status, broker, directionLabel, timeLabel, displayDirection }
}
