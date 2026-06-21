/**
 * Close-worse-entries helpers.
 *
 * Auto (cweCloseMonitor): legacy rows tagged with cwe_close_price at entry.
 *
 * Telegram (`close_worse_entries` management): close all open immediate legs;
 * range layering legs (fired from range_pending_legs) stay open.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'

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
  signal_id?: string | null
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

/** @deprecated Legacy auto-CWE selection; instruction path uses selectImmediateLegsForCweInstruction. */
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

export async function loadFiredRangeLayeringTickets(
  supabase: SupabaseClient,
  args: { signalIds: string[]; brokerAccountId: string; symbol: string },
): Promise<Set<string>> {
  const signalIds = [...new Set(args.signalIds.map(id => id.trim()).filter(Boolean))]
  if (!signalIds.length) return new Set()

  const { data, error } = await supabase
    .from('range_pending_legs')
    .select('ticket, symbol')
    .in('signal_id', signalIds)
    .eq('broker_account_id', args.brokerAccountId)
    .eq('status', 'fired')

  if (error) {
    console.warn(
      `[closeWorseEntries] fired range pending lookup failed broker=${args.brokerAccountId} symbol=${args.symbol}: ${error.message}`,
    )
    return new Set()
  }

  const tickets = new Set<string>()
  for (const row of data ?? []) {
    const r = row as { ticket?: string | null; symbol?: string | null }
    const rowSymbol = String(r.symbol ?? '').trim()
    if (rowSymbol && !symbolsCompatibleForBasket(args.symbol, rowSymbol)) continue
    const ticket = String(r.ticket ?? '').trim()
    if (ticket) tickets.add(ticket)
  }
  return tickets
}

/** Instruction CWE: all open immediates; exclude range layering legs that fired. */
export function selectImmediateLegsForCweInstruction(
  trades: OpenTradeForCweClose[],
  layeringTickets: Set<string>,
): OpenTradeForCweClose[] {
  return trades.filter(t => {
    if (t.status !== 'open') return false
    const ticket = String(t.metaapi_order_id ?? '').trim()
    if (!ticket) return false
    return !layeringTickets.has(ticket)
  })
}

/**
 * Instruction CWE: immediate legs whose entry is within `pips` of the live quote
 * (worse/near-market fills). Range layering tickets stay open; better fills farther
 * from the quote are kept.
 */
export function selectWorseImmediateLegsForCweInstruction(args: {
  trades: OpenTradeForCweClose[]
  layeringTickets: Set<string>
  referencePrice: number
  pips: number
  pipSize: number
}): OpenTradeForCweClose[] {
  const immediates = selectImmediateLegsForCweInstruction(args.trades, args.layeringTickets)
  return filterTradesWithinPipsOfReference({
    trades: immediates,
    referencePrice: args.referencePrice,
    pips: args.pips,
    pipSize: args.pipSize,
  })
}
