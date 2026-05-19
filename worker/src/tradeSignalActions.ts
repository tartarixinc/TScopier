/**
 * Parsed-signal action classification for trade routing, queues, and split workers.
 */

export type TradeExecutorMode = 'all' | 'entry' | 'mgmt'

export function parsedAction(parsed: { action?: string } | null | undefined): string {
  return String(parsed?.action ?? '').toLowerCase().trim()
}

export function isManagementAction(action: string): boolean {
  const a = action.toLowerCase()
  return a === 'close'
    || a === 'close_worse_entries'
    || a === 'breakeven'
    || a === 'partial_profit'
    || a === 'partial_breakeven'
    || a === 'modify'
}

export function isEntryAction(action: string): boolean {
  const a = action.toLowerCase()
  return a === 'buy' || a === 'sell'
}

export function tradeExecutorModeForRole(role: string): TradeExecutorMode {
  if (role === 'trade_entry') return 'entry'
  if (role === 'trade_mgmt') return 'mgmt'
  return 'all'
}

/** Whether this worker role should execute the parsed action. */
export function signalMatchesExecutorMode(
  parsed: { action?: string } | null | undefined,
  mode: TradeExecutorMode,
): boolean {
  if (mode === 'all') return true
  const action = parsedAction(parsed)
  if (!action || action === 'ignore') return false
  if (mode === 'entry') return isEntryAction(action)
  if (mode === 'mgmt') return isManagementAction(action)
  return true
}

export function dispatchPriorityForAction(action: string): 'high' | 'normal' {
  return isEntryAction(action) ? 'high' : 'normal'
}
