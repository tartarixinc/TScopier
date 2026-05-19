/**
 * Close-worse-entries helpers.
 *
 * Auto (cweCloseMonitor): when market reaches anchor ± X pips, tagged immediates
 * (+ optional shallow layers) are closed via a fixed threshold on each row.
 *
 * Telegram (`close_worse_entries` management): at instruction time, close every
 * open basket leg whose entry is within X pips of the live quote.
 */

export function isEntryWithinPipsOfReference(
  entryPrice: number,
  referencePrice: number,
  pips: number,
  pipSize: number,
): boolean {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return false
  if (!Number.isFinite(pips) || pips <= 0) return false
  if (!Number.isFinite(pipSize) || pipSize <= 0) return false
  const band = pips * pipSize
  return Math.abs(referencePrice - entryPrice) <= band + 1e-12
}

/** Quote side used to measure distance to entry (bid for longs, ask for shorts). */
export function referencePriceForDirection(
  direction: 'buy' | 'sell' | string,
  bid: number,
  ask: number,
): number {
  const isBuy = String(direction).toLowerCase() === 'buy'
  return isBuy ? bid : ask
}

export interface OpenTradeForCweClose {
  id: string
  broker_account_id: string
  metaapi_order_id: string | null
  symbol: string
  direction: string
  lot_size: number
  entry_price: number | null
  status: string
  cwe_close_price?: number | null
}

/** Stable group key for broker + symbol + direction (symbol may contain `|`). */
export function cweInstructionGroupKey(trade: Pick<OpenTradeForCweClose, 'broker_account_id' | 'symbol' | 'direction'>): string {
  return `${trade.broker_account_id}\x1f${trade.symbol}\x1f${String(trade.direction).toLowerCase()}`
}

export function parseCweInstructionGroupKey(key: string): {
  brokerId: string
  symbol: string
  direction: string
} | null {
  const parts = key.split('\x1f')
  if (parts.length !== 3) return null
  const [brokerId, symbol, direction] = parts
  if (!brokerId || !symbol || !direction) return null
  return { brokerId, symbol, direction }
}

export function filterTradesWithinPipsOfReference(args: {
  trades: OpenTradeForCweClose[]
  referencePrice: number
  pips: number
  pipSize: number
}): OpenTradeForCweClose[] {
  const { trades, referencePrice, pips, pipSize } = args
  return trades.filter(t => {
    if (t.status !== 'open') return false
    const entry = t.entry_price
    if (entry == null || !Number.isFinite(entry) || entry <= 0) return false
    return isEntryWithinPipsOfReference(entry, referencePrice, pips, pipSize)
  })
}

/**
 * Telegram close_worse_entries: shallow legs near the live quote, plus any
 * worker-tagged CWE basket leg (cwe_close_price), even when price has moved away.
 */
export function selectTradesForCweInstruction(args: {
  trades: OpenTradeForCweClose[]
  referencePrice: number
  pips: number
  pipSize: number
}): OpenTradeForCweClose[] {
  const { trades, referencePrice, pips, pipSize } = args
  const byId = new Map<string, OpenTradeForCweClose>()
  for (const t of filterTradesWithinPipsOfReference({ trades, referencePrice, pips, pipSize })) {
    byId.set(t.id, t)
  }
  for (const t of trades) {
    if (t.status !== 'open') continue
    const thr = t.cwe_close_price
    if (typeof thr === 'number' && Number.isFinite(thr) && thr > 0) {
      byId.set(t.id, t)
    }
  }
  return [...byId.values()]
}
