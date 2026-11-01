import type { ProviderPublicTrade } from './providerPublicProfile'

export type SymbolBreakdown = { symbol: string; trades: number; wins: number; winRate: number; profit: number }

export type PublicTradeStats = {
  closedTrades: number
  wins: number
  losses: number
  longTrades: number
  shortTrades: number
  longWinRate: number | null
  shortWinRate: number | null
  avgProfit: number | null
  avgWin: number | null
  avgLoss: number | null
  avgHoldingHours: number | null
  bestStreak: number
  worstStreak: number
  symbols: SymbolBreakdown[]
  /** Cumulative realized P/L in closing order. */
  curve: { at: string; label: string; cumulative: number }[]
}

const round2 = (value: number) => Math.round(value * 100) / 100

/** Detail statistics computed from the closed trades the public page already has. */
export function computePublicTradeStats(trades: ProviderPublicTrade[]): PublicTradeStats {
  const closed = trades
    .filter(trade => trade.status === 'closed' && trade.realizedProfit != null && trade.closedAt != null)
    .sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!))

  const profits = closed.map(trade => trade.realizedProfit as number)
  const winners = profits.filter(value => value > 0)
  const losers = profits.filter(value => value < 0)
  const side = (direction: 'buy' | 'sell') => closed.filter(trade => trade.direction === direction)
  const winRate = (list: ProviderPublicTrade[]) =>
    list.length ? round2((list.filter(trade => (trade.realizedProfit as number) > 0).length / list.length) * 100) : null
  const mean = (values: number[]) => values.length ? round2(values.reduce((sum, value) => sum + value, 0) / values.length) : null

  const holding = closed
    .map(trade => (Date.parse(trade.closedAt!) - Date.parse(trade.openedAt)) / 3_600_000)
    .filter(hours => Number.isFinite(hours) && hours >= 0)

  let bestStreak = 0
  let worstStreak = 0
  let winRun = 0
  let lossRun = 0
  for (const value of profits) {
    winRun = value > 0 ? winRun + 1 : 0
    lossRun = value < 0 ? lossRun + 1 : 0
    bestStreak = Math.max(bestStreak, winRun)
    worstStreak = Math.max(worstStreak, lossRun)
  }

  const bySymbol = new Map<string, { trades: number; wins: number; profit: number }>()
  for (const trade of closed) {
    const row = bySymbol.get(trade.symbol) ?? { trades: 0, wins: 0, profit: 0 }
    row.trades += 1
    row.wins += (trade.realizedProfit as number) > 0 ? 1 : 0
    row.profit += trade.realizedProfit as number
    bySymbol.set(trade.symbol, row)
  }
  const symbols = [...bySymbol.entries()]
    .map(([symbol, row]) => ({
      symbol,
      trades: row.trades,
      wins: row.wins,
      winRate: round2((row.wins / row.trades) * 100),
      profit: round2(row.profit),
    }))
    .sort((a, b) => b.trades - a.trades || b.profit - a.profit)

  let running = 0
  const curve = closed.map(trade => {
    running += trade.realizedProfit as number
    return {
      at: trade.closedAt as string,
      label: new Date(trade.closedAt as string).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      cumulative: round2(running),
    }
  })

  return {
    closedTrades: closed.length,
    wins: winners.length,
    losses: losers.length,
    longTrades: side('buy').length,
    shortTrades: side('sell').length,
    longWinRate: winRate(side('buy')),
    shortWinRate: winRate(side('sell')),
    avgProfit: mean(profits),
    avgWin: mean(winners),
    avgLoss: mean(losers),
    avgHoldingHours: mean(holding),
    bestStreak,
    worstStreak,
    symbols,
    curve,
  }
}

export function formatHolding(hours: number | null): string {
  if (hours == null) return '\u2014'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} days`
}
