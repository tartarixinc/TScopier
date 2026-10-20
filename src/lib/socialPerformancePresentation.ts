import type { SocialTradeHistoryItem } from './socialTradeHistory'

export type SocialPerformanceDay = {
  key: string
  profit: number
  tradeCount: number
}

export function summarizeSocialTradesByDay(trades: SocialTradeHistoryItem[]): SocialPerformanceDay[] {
  const days = new Map<string, SocialPerformanceDay>()
  for (const trade of trades) {
    if (trade.status !== 'closed' || !trade.closedAt || trade.realizedProfit == null) continue
    const date = new Date(trade.closedAt)
    if (!Number.isFinite(date.getTime())) continue
    const key = date.toISOString().slice(0, 10)
    const current = days.get(key) ?? { key, profit: 0, tradeCount: 0 }
    current.profit += trade.realizedProfit
    current.tradeCount += 1
    days.set(key, current)
  }
  return [...days.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export function performanceMetricsReconcile(
  trades: SocialTradeHistoryItem[],
): { closedTradeCount: number; realizedProfit: number; winRate: number | null; profitFactor: number | null } {
  const closed = trades.filter(trade => trade.status === 'closed' && trade.realizedProfit != null)
  const grossProfit = closed.reduce((sum, trade) => sum + Math.max(trade.realizedProfit ?? 0, 0), 0)
  const grossLoss = Math.abs(closed.reduce((sum, trade) => sum + Math.min(trade.realizedProfit ?? 0, 0), 0))
  const wins = closed.filter(trade => (trade.realizedProfit ?? 0) > 0).length
  return {
    closedTradeCount: closed.length,
    realizedProfit: grossProfit - grossLoss,
    winRate: closed.length === 0 ? null : (wins / closed.length) * 100,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
  }
}
