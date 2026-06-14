import type { MtTrade } from './fxsocketBroker'
import { fxsocketBroker } from './fxsocketBroker'
import { getLocalCalendarDayBounds } from './dashboardTradeStats'
import { formatLocalMtApiDateTime, parseMtHistoryTimestamp } from './mtApiDateTime'
import { TRADES_PAGE_HISTORY_DAYS } from './tradesConstants'
import {
  flattenMtOrder,
  resolveMtCloseTimestamp,
  resolveMtOpenTimestamp,
  resolveMtTicket,
} from './mtTradeFieldsClient'

export type TicketTimeLookup = Map<number, { opened_at: string | null; closed_at: string | null }>

/** True when the Trades table would show "—" for TIME. */
export function mtTradeMissingDisplayTime(trade: MtTrade): boolean {
  return parseMtHistoryTimestamp(resolveTradeDisplayTimeRaw(trade)) == null
}

export function resolveTradeDisplayTimeRaw(trade: MtTrade): string | number | null | undefined {
  if (trade.status === 'closed') {
    return trade.closed_at ?? trade.opened_at
  }
  return trade.opened_at
}

/** Normalize broker timestamp fields (unix seconds, numeric strings, ISO). */
export function enrichMtTradeTimestamps(trade: MtTrade): MtTrade {
  const openedMs = parseMtHistoryTimestamp(trade.opened_at)
  const closedMs = parseMtHistoryTimestamp(trade.closed_at)
  return {
    ...trade,
    opened_at: openedMs != null ? new Date(openedMs).toISOString() : trade.opened_at,
    closed_at: closedMs != null ? new Date(closedMs).toISOString() : trade.closed_at,
  }
}

export function enrichMtTradesTimestamps(trades: MtTrade[]): MtTrade[] {
  return trades.map(enrichMtTradeTimestamps)
}

export function buildTicketTimeLookup(orders: unknown[]): TicketTimeLookup {
  const lookup: TicketTimeLookup = new Map()

  for (const order of orders) {
    if (!order || typeof order !== 'object') continue
    const row = flattenMtOrder(order)
    const ticket = resolveMtTicket(row)
    if (ticket <= 0) continue

    const opened = resolveMtOpenTimestamp(row)
    const closed = resolveMtCloseTimestamp(row)
    const prev = lookup.get(ticket)

    lookup.set(ticket, {
      opened_at: opened ?? prev?.opened_at ?? null,
      closed_at: closed ?? prev?.closed_at ?? null,
    })

    const positionTicket = Number(
      pickNestedTicket(row, 'positionId', 'PositionId', 'position', 'Position', 'order', 'Order'),
    )
    if (positionTicket > 0 && positionTicket !== ticket) {
      const posPrev = lookup.get(positionTicket)
      lookup.set(positionTicket, {
        opened_at: opened ?? posPrev?.opened_at ?? null,
        closed_at: closed ?? posPrev?.closed_at ?? null,
      })
    }
  }

  return lookup
}

function pickNestedTicket(row: RawMtOrder, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k]
    if (v == null) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

type RawMtOrder = Record<string, unknown>

export function hydrateMtTradesFromLookups(
  trades: MtTrade[],
  lookupsByBroker: Record<string, TicketTimeLookup>,
): MtTrade[] {
  return trades.map(trade => {
    if (!mtTradeMissingDisplayTime(trade)) return trade
    const lookup = lookupsByBroker[trade.broker_id]
    if (!lookup) return trade

    const byTicket = lookup.get(trade.ticket)
    const byPosition =
      trade.position_ticket != null && trade.position_ticket > 0
        ? lookup.get(trade.position_ticket)
        : undefined
    const hit = byTicket ?? byPosition
    if (!hit) return trade

    return enrichMtTradeTimestamps({
      ...trade,
      opened_at: trade.opened_at ?? hit.opened_at,
      closed_at: trade.closed_at ?? hit.closed_at,
    })
  })
}

/** Fill missing deal times from raw FxSocket OrderHistory (works even if edge normalizer is stale). */
export async function hydrateMtTradesTimesFromBrokers(trades: MtTrade[]): Promise<MtTrade[]> {
  if (trades.length === 0 || !trades.some(mtTradeMissingDisplayTime)) {
    return trades
  }

  const brokerIds = [...new Set(
    trades.filter(mtTradeMissingDisplayTime).map(t => t.broker_id).filter(Boolean),
  )]
  if (brokerIds.length === 0) return trades

  const { tomorrowStart: historyTo } = getLocalCalendarDayBounds()
  const historyFrom = new Date()
  historyFrom.setDate(historyFrom.getDate() - TRADES_PAGE_HISTORY_DAYS)
  const from = formatLocalMtApiDateTime(historyFrom)
  const to = formatLocalMtApiDateTime(historyTo)

  const lookupsByBroker: Record<string, TicketTimeLookup> = {}

  await Promise.all(
    brokerIds.map(async brokerId => {
      try {
        const orders = await fxsocketBroker.orderHistory({
          accountId: brokerId,
          from,
          to,
        })
        lookupsByBroker[brokerId] = buildTicketTimeLookup(orders)
      } catch {
        lookupsByBroker[brokerId] = new Map()
      }
    }),
  )

  return hydrateMtTradesFromLookups(trades, lookupsByBroker)
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
