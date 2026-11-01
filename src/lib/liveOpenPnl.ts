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
