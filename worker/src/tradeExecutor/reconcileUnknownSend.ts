/**
 * Resolve an order send whose HTTP response was lost (client timeout) by asking
 * the broker what actually exists, instead of guessing.
 *
 *   adopted     — the order is live at the broker; the caller adopts it
 *   absent      — a market order is provably not live; safe to resend
 *   inconclusive— cannot prove either way; caller must not resend
 *
 * Deliberately conservative: a pending order (BuyStop/BuyLimit/...) that is not
 * visible in OpenedOrders is NOT treated as absent, because pending orders may
 * not appear in that snapshot — resending could duplicate. Only a market order
 * whose symbol+direction (and comment signal prefix) is genuinely missing is
 * "absent".
 */
import type { FxsocketBrokerClient } from '../fxsocketClient'
import { parseTscopierComment } from '../tscopierComment'

export type UnknownSendIntent = {
  symbol: string
  operation: string
  volume?: number
  comment?: string | null
}

export type UnknownSendResolution =
  | {
      status: 'adopted'
      ticket: number
      openPrice: number | null
      stopLoss: number | null
      takeProfit: number | null
      lots: number | null
    }
  | { status: 'absent' }
  | { status: 'inconclusive'; reason: string }

const TICKET_KEYS = [
  'ticket', 'Ticket', 'positionTicket', 'PositionTicket', 'positionId', 'PositionId',
  'orderTicket', 'OrderTicket', 'order', 'Order',
] as const

function normSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function ticketOf(row: Record<string, unknown>): number | null {
  for (const key of TICKET_KEYS) {
    const n = Number(row[key])
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function directionOf(row: Record<string, unknown>): 'buy' | 'sell' | null {
  const op = String(row.operation ?? row.Operation ?? row.orderType ?? row.OrderType
    ?? row.dealType ?? row.DealType ?? row.type ?? row.Type ?? '').toLowerCase()
  if (op.includes('buy')) return 'buy'
  if (op.includes('sell')) return 'sell'
  const kind = Number(row.type ?? row.Type)
  if (kind === 0) return 'buy'
  if (kind === 1) return 'sell'
  return null
}

function isPendingOperation(operation: string): boolean {
  return /limit|stop/i.test(operation)
}

export function resolveUnknownSendFromOrders(
  openedOrders: unknown[],
  intent: UnknownSendIntent,
): UnknownSendResolution {
  if (!Array.isArray(openedOrders)) {
    return { status: 'inconclusive', reason: 'OpenedOrders response is not a complete list' }
  }
  const symbol = normSymbol(intent.symbol)
  const op = intent.operation.toLowerCase()
  const wantDir: 'buy' | 'sell' | null = op.includes('buy') ? 'buy' : op.includes('sell') ? 'sell' : null
  const parsed = parseTscopierComment(intent.comment)
  const id8 = parsed?.signalIdPrefix ?? null

  const candidates = openedOrders
    .map(raw => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : null))
    .filter((row): row is Record<string, unknown> => row != null)
    .filter(row => normSymbol(row.symbol ?? row.Symbol) === symbol)
    .filter(row => (wantDir == null ? true : directionOf(row) === wantDir))
    .filter(row => {
      if (!id8) return true
      const comment = String(row.comment ?? row.Comment ?? '').toLowerCase()
      return comment.includes(id8)
    })

  const distinct = new Map<number, Record<string, unknown>>()
  for (const row of candidates) {
    const ticket = ticketOf(row)
    if (ticket != null) distinct.set(ticket, row)
  }

  if (distinct.size === 1) {
    const [ticket, row] = [...distinct.entries()][0]!
    return {
      status: 'adopted',
      ticket,
      openPrice: numberOrNull(row.openPrice ?? row.OpenPrice ?? row.price ?? row.Price),
      stopLoss: numberOrNull(row.stopLoss ?? row.StopLoss ?? row.sl ?? row.SL),
      takeProfit: numberOrNull(row.takeProfit ?? row.TakeProfit ?? row.tp ?? row.TP),
      lots: numberOrNull(row.lots ?? row.Lots ?? row.volume ?? row.Volume),
    }
  }
  if (distinct.size > 1) {
    return { status: 'inconclusive', reason: 'multiple live orders match the send' }
  }
  if (isPendingOperation(intent.operation)) {
    return { status: 'inconclusive', reason: 'pending order not visible in OpenedOrders' }
  }
  return { status: 'absent' }
}

export async function reconcileUnknownSend(
  api: FxsocketBrokerClient,
  sessionId: string,
  intent: UnknownSendIntent,
): Promise<UnknownSendResolution> {
  let openedOrders: unknown[]
  try {
    openedOrders = (await api.openedOrders(sessionId)) ?? []
  } catch (err) {
    return {
      status: 'inconclusive',
      reason: `OpenedOrders read failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return resolveUnknownSendFromOrders(openedOrders, intent)
}
