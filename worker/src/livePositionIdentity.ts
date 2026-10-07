import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { isLikelyMarketPositionRow, rawNumericOrderKind, rawOrderOperation } from './signalEntryPendingHelpers'

export type LiveTradeIdentity = {
  id: string
  metaapi_order_id: string | null
  /**
   * Broker position identity captured from a read taken right after the fill
   * (see `captureBrokerPositionIdentity`). Preferred over `metaapi_order_id`
   * when present, because on MT5 the order ticket and the position ticket are
   * different numbers.
   */
  broker_position_ticket?: string | null
  symbol?: string | null
  direction?: string | null
  lot_size?: number | null
  entry_price?: number | null
}

export type CanonicalPositionResolution =
  | {
      status: 'resolved'
      ticket: number
      storedTicket: number
      replacement: boolean
      matchedBy: 'canonical_ticket' | 'explicit_relationship' | 'attributes'
      row: Record<string, unknown>
    }
  | { status: 'missing' | 'ambiguous'; storedTicket: number; reason: string }

type ParsedLivePosition = {
  row: Record<string, unknown>
  canonicalTicket: number
  identities: Set<number>
  symbol: string
  isBuy: boolean | null
  lots: number | null
  entryPrice: number | null
}

function positiveNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}


/**
 * Broker-reported current position volume from an OpenedOrders row.
 *
 * The repository's bridge contracts do not establish a safe precedence when
 * multiple aliases coexist. Accept one positive value (or agreeing aliases)
 * and fail closed when positive aliases conflict.
 */
export function livePositionVolume(row: Record<string, unknown>): number | null {
  const values = [
    row.lots,
    row.Lots,
    row.volume,
    row.Volume,
    row.lotSize,
    row.LotSize,
    row.volumeCurrent,
    row.VolumeCurrent,
  ].map(positiveNumber).filter((value): value is number => value != null)
  if (!values.length) return null

  const first = values[0]!
  const conflict = values.some(value =>
    Math.abs(value - first) > Math.max(1e-9, Math.abs(first) * 1e-9),
  )
  return conflict ? null : first
}
function nestedTicket(value: unknown): number | null {
  if (value == null) return null
  const direct = positiveNumber(value)
  if (direct != null) return direct
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  return positiveNumber(
    row.positionTicket ?? row.PositionTicket ?? row.positionId ?? row.PositionId
    ?? row.ticket ?? row.Ticket ?? row.orderTicket ?? row.OrderTicket
    ?? row.orderId ?? row.OrderId ?? row.order ?? row.Order,
  )
}

function firstTicket(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const ticket = nestedTicket(row[key])
    if (ticket != null) return ticket
  }
  return null
}

function directionOf(row: Record<string, unknown>): boolean | null {
  const operation = rawOrderOperation(row).replace(/\s+/g, '')
  if (operation.includes('buy')) return true
  if (operation.includes('sell')) return false
  const kind = rawNumericOrderKind(row)
  if (kind === 0) return true
  if (kind === 1) return false
  // MTAPI bridge rows spell the side as a word, so attribute matching can
  // still confirm direction when the stored ticket did not line up.
  const side = `${String(row.orderType ?? '')} ${String(row.dealType ?? '')} ${String(row.type ?? '')}`
    .toLowerCase()
  if (side.includes('buy')) return true
  if (side.includes('sell')) return false
  return null
}

function parseLivePosition(raw: unknown): ParsedLivePosition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (!isLikelyMarketPositionRow(row)) return null

  const legacyTicket = firstTicket(row, ['ticket', 'Ticket'])
  const orderTicket = firstTicket(row, [
    'orderTicket', 'OrderTicket', 'order_id', 'orderId', 'OrderId', 'OrderID', 'order', 'Order',
  ])
  const dealTicket = firstTicket(row, [
    'dealTicket', 'DealTicket', 'deal_id', 'dealId', 'DealId', 'DealID', 'deal', 'Deal',
    'dealInternalIn', 'DealInternalIn', 'dealInternalOut', 'DealInternalOut',
  ])
  const positionTicket = firstTicket(row, [
    'positionTicket', 'PositionTicket', 'position_ticket', 'positionId', 'PositionId', 'PositionID',
    'position', 'Position', 'dealInternalIn', 'DealInternalIn',
  ])
  const canonicalTicket = positionTicket ?? legacyTicket ?? orderTicket
  if (canonicalTicket == null) return null

  const identities = new Set<number>([canonicalTicket])
  for (const ticket of [legacyTicket, orderTicket, dealTicket, positionTicket]) {
    if (ticket != null) identities.add(ticket)
  }

  const lots = livePositionVolume(row)
  const entryPrice = positiveNumber(
    row.openPrice ?? row.OpenPrice ?? row.priceOpen ?? row.PriceOpen ?? row.price ?? row.Price,
  )
  return {
    row,
    canonicalTicket,
    identities,
    symbol: String(row.symbol ?? row.Symbol ?? '').trim(),
    isBuy: directionOf(row),
    lots,
    entryPrice,
  }
}

function closeEnough(left: number, right: number, floor: number, ratio: number): boolean {
  return Math.abs(left - right) <= Math.max(floor, Math.abs(right) * ratio)
}

export function resolveCanonicalOpenPosition(args: {
  trade: LiveTradeIdentity
  openedOrders: unknown[]
  excludeTickets?: ReadonlySet<number>
}): CanonicalPositionResolution {
  const capturedRaw = typeof args.trade.broker_position_ticket === 'string'
    ? args.trade.broker_position_ticket.trim()
    : ''
  const capturedTicket = Number(capturedRaw)
  const storedTicket = Number.isFinite(capturedTicket) && capturedTicket > 0
    ? capturedTicket
    : Number(args.trade.metaapi_order_id)
  if (!Number.isFinite(storedTicket) || storedTicket <= 0) {
    return { status: 'missing', storedTicket, reason: 'stored ticket is invalid' }
  }

  const positions = args.openedOrders
    .map(parseLivePosition)
    .filter((position): position is ParsedLivePosition => position != null)
    .filter(position => !args.excludeTickets?.has(position.canonicalTicket))

  const identityMatches = positions.filter(position => position.identities.has(storedTicket))
  const distinctIdentityTickets = new Set(identityMatches.map(position => position.canonicalTicket))
  if (distinctIdentityTickets.size === 1) {
    const match = identityMatches[0]!
    return {
      status: 'resolved',
      ticket: match.canonicalTicket,
      storedTicket,
      replacement: match.canonicalTicket !== storedTicket,
      matchedBy: match.canonicalTicket === storedTicket ? 'canonical_ticket' : 'explicit_relationship',
      row: match.row,
    }
  }
  if (distinctIdentityTickets.size > 1) {
    return { status: 'ambiguous', storedTicket, reason: 'stored ticket maps to multiple live positions' }
  }

  const expectedSymbol = String(args.trade.symbol ?? '').trim()
  const direction = String(args.trade.direction ?? '').trim().toLowerCase()
  const expectedIsBuy = direction === 'buy' ? true : direction === 'sell' ? false : null
  const expectedLots = positiveNumber(args.trade.lot_size)
  const expectedEntry = positiveNumber(args.trade.entry_price)
  if (!expectedSymbol || expectedIsBuy == null || (expectedLots == null && expectedEntry == null)) {
    return { status: 'missing', storedTicket, reason: 'no explicit relationship and insufficient attributes' }
  }

  const attributeMatches = positions.filter(position => {
    if (!position.symbol || !symbolsCompatibleForBasket(expectedSymbol, position.symbol)) return false
    if (position.isBuy !== expectedIsBuy) return false
    if (expectedLots != null && (position.lots == null || !closeEnough(position.lots, expectedLots, 0.001, 0.05))) {
      return false
    }
    if (
      expectedEntry != null
      && (position.entryPrice == null || !closeEnough(position.entryPrice, expectedEntry, expectedEntry * 0.00001, 0.002))
    ) return false
    return true
  })

  const distinctAttributeTickets = new Set(attributeMatches.map(position => position.canonicalTicket))
  if (distinctAttributeTickets.size !== 1) {
    return {
      status: distinctAttributeTickets.size > 1 ? 'ambiguous' : 'missing',
      storedTicket,
      reason: distinctAttributeTickets.size > 1
        ? 'attributes match multiple live positions'
        : 'stored ticket has no live position match',
    }
  }
  const match = attributeMatches[0]!
  return {
    status: 'resolved',
    ticket: match.canonicalTicket,
    storedTicket,
    replacement: match.canonicalTicket !== storedTicket,
    matchedBy: 'attributes',
    row: match.row,
  }
}

export async function persistCanonicalPositionTicket(
  supabase: SupabaseClient,
  trade: LiveTradeIdentity,
  resolution: CanonicalPositionResolution,
): Promise<boolean> {
  if (resolution.status !== 'resolved') return false
  // Never persist a guess: only a ticket-based match (canonical ticket or an
  // explicit order→position relationship) may be frozen into the row. An
  // attribute-only match stays transient and is not written anywhere.
  if (resolution.matchedBy === 'attributes') return false
  if (!resolution.replacement) return true

  const stored = String(resolution.storedTicket)
  const capturedRaw = typeof trade.broker_position_ticket === 'string'
    ? trade.broker_position_ticket.trim()
    : ''
  const sourceColumn = Number(capturedRaw) === resolution.storedTicket && capturedRaw !== ''
    ? 'broker_position_ticket'
    : 'metaapi_order_id'

  const apply = async (patch: Record<string, unknown>, column: string) => {
    const { data, error } = await supabase
      .from('trades')
      .update(patch)
      .eq('id', trade.id)
      .eq('status', 'open')
      .eq(column, stored)
      .select('id')
      .maybeSingle()
    return { persisted: !error && data?.id === trade.id, error }
  }

  // A certain replacement is recorded in the position column and leaves the
  // order ticket untouched (Option A).
  const first = await apply({ broker_position_ticket: String(resolution.ticket) }, sourceColumn)
  if (first.persisted) return true

  // Before the column exists the update is rejected; keep the legacy behaviour
  // so reconciliation is not wedged while the migration is pending.
  const columnMissing = !!first.error
    && (first.error.code === 'PGRST204' || /broker_position_ticket/.test(first.error.message ?? ''))
  if (!columnMissing) return false
  console.warn(
    '[livePositionIdentity] broker_position_ticket column missing — falling back to metaapi_order_id'
    + ' (apply supabase/migrations/20261006140000_trades_broker_position_ticket.sql)',
  )
  const legacy = await apply({ metaapi_order_id: String(resolution.ticket) }, 'metaapi_order_id')
  return legacy.persisted
}

export async function resolveCurrentLivePosition(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  sessionId: string
  trade: LiveTradeIdentity
  openedOrders?: unknown[]
  excludeTickets?: ReadonlySet<number>
}): Promise<CanonicalPositionResolution> {
  const openedOrders = args.openedOrders ?? await args.api.openedOrders(args.sessionId)
  if (!Array.isArray(openedOrders)) {
    const incompleteCaptured = Number(
      typeof args.trade.broker_position_ticket === 'string' ? args.trade.broker_position_ticket.trim() : '',
    )
    const incompleteStored = Number.isFinite(incompleteCaptured) && incompleteCaptured > 0
      ? incompleteCaptured
      : Number(args.trade.metaapi_order_id)
    return {
      status: 'ambiguous',
      storedTicket: incompleteStored,
      reason: 'OpenedOrders response is not a complete list',
    }
  }
  const resolution = resolveCanonicalOpenPosition({
    trade: args.trade,
    openedOrders,
    excludeTickets: args.excludeTickets,
  })
  if (resolution.status === 'resolved' && resolution.replacement) {
    if (resolution.matchedBy === 'attributes') {
      // Fail closed: an attribute-only match is not certain enough to act on or
      // to freeze into the row, so every caller (including the close paths)
      // keeps refusing until the position identity is captured at fill time.
      return {
        status: 'ambiguous',
        storedTicket: resolution.storedTicket,
        reason: 'identity match is by attributes only; not persisted',
      }
    }
    const persisted = await persistCanonicalPositionTicket(args.supabase, args.trade, resolution)
    if (!persisted) {
      return {
        status: 'ambiguous',
        storedTicket: resolution.storedTicket,
        reason: 'canonical replacement lost persistence authority',
      }
    }
  }
  return resolution
}
