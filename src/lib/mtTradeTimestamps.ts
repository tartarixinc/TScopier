import type { MtTrade } from './fxsocketBroker'
import { fxsocketBroker } from './fxsocketBroker'
import { getLocalCalendarDayBounds } from './dashboardTradeStats'
import { formatBrokerHistoryDate, parseMtHistoryTimestamp } from './mtApiDateTime'
import { BROKER_FULL_HISTORY_FROM } from './tradesConstants'
import {
  flattenMtOrder,
  pickMtField,
  resolveMtCloseTimestamp,
  resolveMtLiveOpenTimestamp,
  resolveMtOpenTimestamp,
  resolveMtPositionTicket,
  resolveMtTicket,
} from './mtTradeFieldsClient'

export type TicketTimeLookup = Map<number, { opened_at: string | null; closed_at: string | null }>

export type MtTradeTimeHydrationStats = {
  closedCount: number
  openCount: number
  missingBefore: number
  missingAfter: number
  historyOrders: number
  historyPositions: number
  openedOrders: number
  historyErrors: string[]
}

function mergeLookupEntry(
  lookup: TicketTimeLookup,
  ticket: number,
  opened: string | null,
  closed: string | null,
): void {
  if (ticket <= 0) return
  const prev = lookup.get(ticket)
  lookup.set(ticket, {
    opened_at: opened ?? prev?.opened_at ?? null,
    closed_at: closed ?? prev?.closed_at ?? null,
  })
}

function registerHistoryRow(lookup: TicketTimeLookup, order: unknown): void {
  if (!order || typeof order !== 'object') return
  const row = flattenMtOrder(order)
  const ticket = resolveMtTicket(row)
  const positionTicket = resolveMtPositionTicket(row)
  const orderId = Number(pickMtField(row, 'order', 'Order') ?? 0)
  const opened = resolveMtOpenTimestamp(row)
  const closed = resolveMtCloseTimestamp(row)

  mergeLookupEntry(lookup, ticket, opened, closed)
  if (positionTicket != null && positionTicket > 0) {
    mergeLookupEntry(lookup, positionTicket, opened, closed)
  }
  if (Number.isFinite(orderId) && orderId > 0 && orderId !== ticket) {
    mergeLookupEntry(lookup, orderId, opened, closed)
  }
}

function registerOpenedOrderRow(lookup: TicketTimeLookup, order: unknown): void {
  if (!order || typeof order !== 'object') return
  const row = flattenMtOrder(order)
  const ticket = resolveMtTicket(row)
  const positionTicket = resolveMtPositionTicket(row)
  const opened = resolveMtLiveOpenTimestamp(row)
  mergeLookupEntry(lookup, ticket, opened, null)
  if (positionTicket != null && positionTicket > 0) {
    mergeLookupEntry(lookup, positionTicket, opened, null)
  }
}

/** True when the Trades table would show "—" for TIME. */
export function mtTradeMissingDisplayTime(trade: MtTrade): boolean {
  return parseMtHistoryTimestamp(resolveTradeDisplayTimeRaw(trade)) == null
}

/** Close time for closed legs; open time for open legs. Only returns parseable values. */
export function resolveTradeDisplayTimeRaw(trade: MtTrade): string | number | null | undefined {
  if (trade.status === 'closed') {
    if (parseMtHistoryTimestamp(trade.closed_at) != null) return trade.closed_at
    if (parseMtHistoryTimestamp(trade.opened_at) != null) return trade.opened_at
    return null
  }
  if (parseMtHistoryTimestamp(trade.opened_at) != null) return trade.opened_at
  return null
}

function coerceValidIso(value: string | number | null | undefined): string | null {
  const ms = parseMtHistoryTimestamp(value)
  return ms != null ? new Date(ms).toISOString() : null
}

/** Normalize broker timestamp fields (unix seconds, numeric strings, ISO). */
export function enrichMtTradeTimestamps(trade: MtTrade): MtTrade {
  return {
    ...trade,
    opened_at: coerceValidIso(trade.opened_at),
    closed_at: coerceValidIso(trade.closed_at),
  }
}

export function enrichMtTradesTimestamps(trades: MtTrade[]): MtTrade[] {
  return trades.map(enrichMtTradeTimestamps)
}

export function buildTicketTimeLookup(orders: unknown[]): TicketTimeLookup {
  const lookup: TicketTimeLookup = new Map()
  for (const order of orders) registerHistoryRow(lookup, order)
  return lookup
}

export function buildOpenedOrderTimeLookup(orders: unknown[]): TicketTimeLookup {
  const lookup: TicketTimeLookup = new Map()
  for (const order of orders) registerOpenedOrderRow(lookup, order)
  return lookup
}

function mergeTicketTimeLookups(...maps: TicketTimeLookup[]): TicketTimeLookup {
  const out: TicketTimeLookup = new Map()
  for (const map of maps) {
    for (const [ticket, times] of map) {
      mergeLookupEntry(out, ticket, times.opened_at, times.closed_at)
    }
  }
  return out
}

function lookupCloseTime(lookup: TicketTimeLookup | undefined, trade: MtTrade): string | null {
  if (!lookup) return null
  const byTicket = lookup.get(trade.ticket)
  const byPosition =
    trade.position_ticket != null && trade.position_ticket > 0
      ? lookup.get(trade.position_ticket)
      : undefined
  return byTicket?.closed_at ?? byPosition?.closed_at ?? null
}

function lookupOpenTime(lookup: TicketTimeLookup | undefined, trade: MtTrade): string | null {
  if (!lookup) return null
  const byTicket = lookup.get(trade.ticket)
  const byPosition =
    trade.position_ticket != null && trade.position_ticket > 0
      ? lookup.get(trade.position_ticket)
      : undefined
  return byTicket?.opened_at ?? byPosition?.opened_at ?? null
}

function registerPositionHistoryRow(lookup: TicketTimeLookup, row: unknown): void {
  if (!row || typeof row !== 'object') return
  const positionId = Number(
    pickMtField(row as Record<string, unknown>, 'positionId', 'PositionId', 'ticket', 'Ticket') ?? 0,
  )
  if (!Number.isFinite(positionId) || positionId <= 0) return
  const opened = resolveMtOpenTimestamp(row as Record<string, unknown>)
  const closed = resolveMtCloseTimestamp(row as Record<string, unknown>)
  mergeLookupEntry(lookup, positionId, opened, closed)
}

/** FxSocket PositionHistory rows include explicit closeTime per round-trip. */
export function buildPositionTimeLookup(positions: unknown[]): TicketTimeLookup {
  const lookup: TicketTimeLookup = new Map()
  for (const row of positions) registerPositionHistoryRow(lookup, row)
  return lookup
}

/** Apply broker timestamps to trade rows (close time for closed, open time for open). */
export function applyTimesToTrades(
  trades: MtTrade[],
  lookupsByBroker: Record<string, TicketTimeLookup>,
): MtTrade[] {
  return trades.map(trade => {
    const lookup = lookupsByBroker[trade.broker_id]
    if (trade.status === 'closed') {
      const closedFromLookup = lookupCloseTime(lookup, trade)
      const openedFromLookup = lookupOpenTime(lookup, trade)
      return enrichMtTradeTimestamps({
        ...trade,
        closed_at: closedFromLookup ?? trade.closed_at,
        opened_at: openedFromLookup ?? trade.opened_at,
      })
    }
    if (trade.status === 'open') {
      const openedFromLookup = lookupOpenTime(lookup, trade)
      return enrichMtTradeTimestamps({
        ...trade,
        opened_at: openedFromLookup ?? trade.opened_at,
      })
    }
    return enrichMtTradeTimestamps(trade)
  })
}

/** @deprecated Use applyTimesToTrades */
export function applyCloseTimesToTrades(
  trades: MtTrade[],
  lookupsByBroker: Record<string, TicketTimeLookup>,
): MtTrade[] {
  return applyTimesToTrades(trades, lookupsByBroker)
}

function tradesHistoryRange(): { from: string; to: string } {
  const { tomorrowStart: historyTo } = getLocalCalendarDayBounds()
  return {
    from: BROKER_FULL_HISTORY_FROM,
    to: formatBrokerHistoryDate(historyTo),
  }
}

/** Fill trade times from FxSocket OpenedOrders + OrderHistory + PositionHistory. */
export async function hydrateMtTradesTimesFromBrokers(
  trades: MtTrade[],
): Promise<{ trades: MtTrade[]; stats: MtTradeTimeHydrationStats }> {
  const closed = trades.filter(t => t.status === 'closed')
  const open = trades.filter(t => t.status === 'open')
  const stats: MtTradeTimeHydrationStats = {
    closedCount: closed.length,
    openCount: open.length,
    missingBefore: trades.filter(mtTradeMissingDisplayTime).length,
    missingAfter: 0,
    historyOrders: 0,
    historyPositions: 0,
    openedOrders: 0,
    historyErrors: [],
  }

  if (trades.length === 0) {
    return { trades, stats }
  }

  const brokerIds = [...new Set(trades.map(t => t.broker_id).filter(Boolean))]
  if (brokerIds.length === 0) {
    stats.missingAfter = stats.missingBefore
    return { trades, stats }
  }

  const { from, to } = tradesHistoryRange()
  const lookupsByBroker: Record<string, TicketTimeLookup> = {}

  await Promise.all(
    brokerIds.map(async brokerId => {
      const needsHistory = closed.some(t => t.broker_id === brokerId)
      const needsOpened = open.some(t => t.broker_id === brokerId)

      const [ordersRes, positionsRes, openedRes] = await Promise.allSettled([
        needsHistory ? fxsocketBroker.orderHistory({ accountId: brokerId, from, to }) : Promise.resolve([]),
        needsHistory ? fxsocketBroker.positionHistory({ accountId: brokerId, from, to }) : Promise.resolve([]),
        needsOpened ? fxsocketBroker.openedOrders(brokerId) : Promise.resolve([]),
      ])

      if (ordersRes.status === 'fulfilled') {
        stats.historyOrders += ordersRes.value.length
        lookupsByBroker[brokerId] = mergeTicketTimeLookups(
          lookupsByBroker[brokerId] ?? new Map(),
          buildTicketTimeLookup(ordersRes.value),
        )
      } else if (needsHistory) {
        const msg = ordersRes.reason instanceof Error ? ordersRes.reason.message : 'OrderHistory failed'
        stats.historyErrors.push(msg)
      }

      if (positionsRes.status === 'fulfilled') {
        stats.historyPositions += positionsRes.value.length
        lookupsByBroker[brokerId] = mergeTicketTimeLookups(
          lookupsByBroker[brokerId] ?? new Map(),
          buildPositionTimeLookup(positionsRes.value),
        )
      } else if (needsHistory) {
        const msg =
          positionsRes.reason instanceof Error ? positionsRes.reason.message : 'PositionHistory failed'
        stats.historyErrors.push(msg)
      }

      if (openedRes.status === 'fulfilled') {
        stats.openedOrders += openedRes.value.length
        lookupsByBroker[brokerId] = mergeTicketTimeLookups(
          lookupsByBroker[brokerId] ?? new Map(),
          buildOpenedOrderTimeLookup(openedRes.value),
        )
      } else if (needsOpened) {
        const msg = openedRes.reason instanceof Error ? openedRes.reason.message : 'OpenedOrders failed'
        stats.historyErrors.push(msg)
      }
    }),
  )

  const hydrated = applyTimesToTrades(trades, lookupsByBroker)
  stats.missingAfter = hydrated.filter(mtTradeMissingDisplayTime).length
  return { trades: hydrated, stats }
}

export function formatTradeTimeLabel(iso: string | number | null | undefined): string {
  const ms = parseMtHistoryTimestamp(iso)
  if (ms == null) return '—'
  return new Date(ms).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Trades table TIME column: close time for closed legs, open time for open legs. */
export function formatTradeCloseTimeLabel(trade: MtTrade): string {
  const raw =
    trade.status === 'closed'
      ? (trade.closed_at ?? trade.opened_at)
      : trade.opened_at
  return formatTradeTimeLabel(raw)
}
