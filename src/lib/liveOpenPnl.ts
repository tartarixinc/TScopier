import type { AccountSummary } from './fxsocketBroker'
import { parseFxsocketAccountStreamData, resolveFxsocketFloatingOpenPnl } from './fxsocketStreamParse'

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
