import type { AccountSummary, MtTrade } from './fxsocketBroker'
import {
  parseFxsocketAccountStreamData,
  parseFxsocketPositionsStreamData,
  resolveFxsocketFloatingOpenPnl,
} from './fxsocketStreamParse'

/**
 * Floating P/L of the open positions from a live broker account summary:
 * the broker's profit field when present, otherwise equity - balance. Null when unknown.
 */
export function liveOpenPnlFromSummary(summary: AccountSummary | null | undefined, openCount = 0): number | null {
  if (!summary) return null
  const snap = parseFxsocketAccountStreamData(summary as Record<string, unknown>)
  const pnl = resolveFxsocketFloatingOpenPnl(snap, openCount)
  return pnl == null || !Number.isFinite(pnl) ? null : Math.round(pnl * 100) / 100
}

/** Sum floating P/L from open MT trade rows (broker `trades` scope=open). */
export function liveOpenPnlFromMtTrades(trades: MtTrade[] | null | undefined): number | null {
  if (!trades) return null
  const open = trades.filter(trade => trade.status !== 'closed')
  if (open.length === 0) return 0
  let total = 0
  let priced = 0
  for (const trade of open) {
    const profit = Number(trade.profit)
    if (!Number.isFinite(profit)) continue
    total += profit
    priced += 1
  }
  return priced > 0 ? Math.round(total * 100) / 100 : null
}

/** Sum floating P/L from FxSocket/MTAPI opened-order / positions payloads. */
export function liveOpenPnlFromOpenedOrders(orders: unknown[] | null | undefined): number | null {
  if (!orders) return null
  const snap = parseFxsocketPositionsStreamData(orders)
  if (snap.openTrades <= 0) return 0
  return snap.openPnl == null || !Number.isFinite(snap.openPnl) ? null : snap.openPnl
}

/**
 * Prefer the account-level floating P/L (broker profit / equity−balance) — same source as
 * Linked Accounts. Position-leg sums can omit swap/commission or miss legs and disagree with
 * the terminal; only use them when the summary is missing or misleadingly flat with opens.
 */
export function preferLiveOpenPnl(input: {
  fromSummary: number | null
  fromPositions: number | null
  openCount: number
}): number | null {
  const { fromSummary, fromPositions, openCount } = input
  const summaryFlat = fromSummary == null || Math.abs(fromSummary) < 0.005
  if (!summaryFlat) return fromSummary
  if (fromPositions != null) return fromPositions
  if (openCount > 0) return null
  return fromSummary
}

/** Turns raw broker bridge errors into something actionable for the account owner. */
export function describeLiveFetchError(message: string | null | undefined): string {
  const text = String(message ?? '').trim()
  if (/client with id .* not found/i.test(text)) {
    return 'The MT5 session for this account has expired on the broker bridge. Reconnect the account in Trading accounts (your MT password is required) to resume live data.'
  }
  if (/too many requests|rate.?limit|throttl/i.test(text)) {
    return 'The broker is rate limiting requests. Live data will resume shortly.'
  }
  return text || 'The trading account did not return a live balance.'
}
