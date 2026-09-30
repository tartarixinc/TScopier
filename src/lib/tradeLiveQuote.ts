import type { MtTrade } from './fxsocketBroker'

export interface NormalizedTradeQuote {
  bid: number | null
  ask: number | null
  symbol?: string
  time?: string
}

export type LiveQuoteTrade = Pick<MtTrade, 'id' | 'status' | 'symbol' | 'broker_id' | 'direction'>

function toPositiveNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/** Accept FXSocket / MTAPI quote records; null when neither side has a usable price. */
export function normalizeTradeQuote(raw: unknown): NormalizedTradeQuote | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const bid = toPositiveNumber(row.bid)
  const ask = toPositiveNumber(row.ask)
  if (bid == null && ask == null) return null
  const symbol = typeof row.symbol === 'string' && row.symbol.trim() ? row.symbol.trim() : undefined
  const time =
    typeof row.time === 'string' && row.time.trim() ? row.time.trim()
      : typeof row.time === 'number' && Number.isFinite(row.time) ? String(row.time)
        : undefined
  return { bid, ask, symbol, time }
}

/** Poll only while the modal is useful: open trade with broker + symbol. */
export function shouldPollTradeQuote(trade: LiveQuoteTrade | null | undefined): boolean {
  if (!trade) return false
  if (trade.status !== 'open') return false
  if (!trade.broker_id || !trade.symbol?.trim()) return false
  return true
}

/**
 * Price that would flatten this side right now:
 * buy exits on bid, sell exits on ask; fall back to the other side if one is missing.
 */
export function liveExitPrice(
  direction: string,
  quote: NormalizedTradeQuote | null | undefined,
): number | null {
  if (!quote) return null
  const dir = direction.trim().toLowerCase()
  if (dir === 'buy') return quote.bid ?? quote.ask
  if (dir === 'sell') return quote.ask ?? quote.bid
  return quote.bid ?? quote.ask ?? null
}

/** "1.09123 / 1.09125" style line; null when the quote has no prices. */
export function formatBidAskLine(quote: NormalizedTradeQuote | null | undefined): string | null {
  if (!quote) return null
  const { bid, ask } = quote
  if (bid == null && ask == null) return null
  const fmt = (n: number) => n.toFixed(5)
  if (bid != null && ask != null) return `${fmt(bid)} / ${fmt(ask)}`
  return fmt(bid ?? ask!)
}
