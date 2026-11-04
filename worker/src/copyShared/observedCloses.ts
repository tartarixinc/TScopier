/**
 * Positions a provider watched disappear from the exchange's own book.
 *
 * These venues (Binance, Bybit, KuCoin) have no per-position id: a history row
 * carries the id of the order that produced the fill, which is the ticket the
 * copier tracks only when the copier placed that close. A stop-loss, take-profit
 * or manual close therefore never matches the tracked ticket, and the mirror
 * engine — which refuses to close a copy without confirmation that the source
 * is gone — would leave that copy open forever. The provider records the leg as
 * it leaves the live book and re-emits it from `orderHistory` under the tracked
 * ticket instead.
 *
 * One implementation is shared by all three exchanges so the safety rules
 * (when to record, how much to keep) cannot drift between them.
 */
export type ObservedClose = {
  ticket: number
  symbol: string
  operation: string
  lots: number
  at: number
}

/** How many observed closes one account remembers, and for how long. */
export const OBSERVED_CLOSE_MEMORY = 500
export const OBSERVED_CLOSE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Append one observation, evicting by age first and then by count. The list is
 * always time-ordered (callers pass `now()`), so age eviction can work from the
 * front.
 */
export function noteObservedClose(closed: ObservedClose[], close: ObservedClose): void {
  while (closed.length && closed[0]!.at < close.at - OBSERVED_CLOSE_MAX_AGE_MS) closed.shift()
  closed.push(close)
  while (closed.length > OBSERVED_CLOSE_MEMORY) closed.shift()
}

/**
 * The observations inside [from, to] as closed-history rows.
 *
 * They deliberately carry no price and no profit: readers treat a row without
 * either value as "no fill to record", so these rows can only ever answer
 * "is this ticket closed" and can never write a wrong fill into a trade.
 */
export function observedCloseRows(
  closed: ObservedClose[],
  from: number,
  to: number,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const observed of closed) {
    if (observed.at < from || observed.at > to) continue
    rows.push({
      ticket: observed.ticket,
      positionTicket: observed.ticket,
      symbol: observed.symbol,
      operation: observed.operation,
      lots: observed.lots,
      closeTime: observed.at,
      comment: '',
      observed: 'position_gone',
    })
  }
  return rows
}
