/**
 * Broker-side fallback when DB has no open trades for a channel close instruction.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { clearChannelActiveTradeParamsWhenFlat } from './channelActiveTradeParams'
import { parseTscopierComment, tscopierCommentMatchesChannelSlug, isTscopierComment } from './tscopierComment'
import {
  cancelSignalEntryRowAtBroker,
  rawNumericOrderKind,
  rawOrderOperation,
  rawOrderTicket,
  type SignalEntryPendingRow,
} from './signalEntryPendingHelpers'
import { type PendingCancelApi } from './pendingOrderCancel'
import { cancelTradesPendingOrders } from './tradesPendingCancel'
import { sanitizeChannelCommentSlug } from './tradeComment'
import type { BrokerRow } from './tradeExecutor/types'
import { brokerSessionUuid } from './tradeExecutor/helpers'
import { TRADE_CLOSE_REASON } from './tradeCloseReasons'
import { applyCloseUpdate } from './tradeCloseUpdate'
import { writeExecutionLog } from './observability/executionLog'
export type BrokerOpenOrderLike = {
  ticket: number
  symbol: string
  comment: string
  lots: number
  isBuy: boolean
  stopLoss: number
  takeProfit: number
}

function readOptionalStop(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function extractOpenOrderFromBrokerRaw(raw: unknown): BrokerOpenOrderLike | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const ticket = rawOrderTicket(o)
  if (!ticket) return null
  const symbol = String(o.symbol ?? o.Symbol ?? '').trim()
  if (!symbol) return null
  const comment = String(o.comment ?? o.Comment ?? '').trim()
  const lots = Number(o.lots ?? o.Lots ?? o.volume ?? o.Volume ?? 0)
  const op = rawOrderOperation(o)
  const numericKind = rawNumericOrderKind(o)
  let isBuy = false
  if (op.includes('buy')) {
    isBuy = true
  } else if (op.includes('sell')) {
    isBuy = false
  } else if (numericKind === 0 || op === '0') {
    isBuy = true
  } else if (numericKind === 1 || op === '1') {
    isBuy = false
  } else if (numericKind != null && numericKind >= 2 && numericKind <= 5) {
    isBuy = numericKind === 2 || numericKind === 4
  }
  return {
    ticket,
    symbol,
    comment,
    lots: Number.isFinite(lots) ? lots : 0,
    isBuy,
    stopLoss: readOptionalStop(o.stopLoss ?? o.StopLoss ?? o.sl ?? o.SL),
    takeProfit: readOptionalStop(o.takeProfit ?? o.TakeProfit ?? o.tp ?? o.TP),
  }
}

export function filterTscopierOrdersForChannelClose(args: {
  orders: BrokerOpenOrderLike[]
  channelSlug: string | null
  symbolFilter: string | null
  channelSignalIdPrefixes?: Set<string>
}): BrokerOpenOrderLike[] {
  const { orders, channelSlug, symbolFilter, channelSignalIdPrefixes } = args
  return orders.filter(o => {
    if (!isTscopierComment(o.comment)) return false
    const parsed = parseTscopierComment(o.comment)
    if (!parsed) return false
    if (!tscopierCommentMatchesChannelSlug(o.comment, channelSlug)) return false
    if (channelSignalIdPrefixes?.size) {
      const prefix = parsed.signalIdPrefix.toLowerCase()
      if (!channelSignalIdPrefixes.has(prefix)) return false
    }
    if (symbolFilter?.trim()) {
      if (!symbolsCompatibleForBasket(symbolFilter, o.symbol)) return false
    }
    return true
  })
}

/**
 * Close-all safety net: tickets that were already open when the close started,
 * still open after DB-attributed closes, matching the close symbol, and either
 * carrying our comment OR sitting naked (no SL/TP). Comment-less protected
 * manual trades with stops are left alone.
 */
export function filterSnapshotStragglerOrdersForClose(args: {
  orders: BrokerOpenOrderLike[]
  preCloseTickets: Set<number>
  symbolFilter: string | null
  alreadyTargetedTickets?: Set<number>
}): BrokerOpenOrderLike[] {
  const { orders, preCloseTickets, symbolFilter, alreadyTargetedTickets } = args
  if (!preCloseTickets.size) return []
  return orders.filter(o => {
    if (!preCloseTickets.has(o.ticket)) return false
    if (alreadyTargetedTickets?.has(o.ticket)) return false
    if (symbolFilter?.trim() && !symbolsCompatibleForBasket(symbolFilter, o.symbol)) return false
    if (isTscopierComment(o.comment)) return true
    return o.stopLoss <= 0 && o.takeProfit <= 0
  })
}

function mergeOrderTargets(
  primary: BrokerOpenOrderLike[],
  extra: BrokerOpenOrderLike[],
): BrokerOpenOrderLike[] {
  const byTicket = new Map<number, BrokerOpenOrderLike>()
  for (const order of primary) byTicket.set(order.ticket, order)
  for (const order of extra) {
    if (!byTicket.has(order.ticket)) byTicket.set(order.ticket, order)
  }
  return [...byTicket.values()]
}

export async function tryBrokerFallbackClose(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  signal: { id: string; user_id: string; channel_id: string | null }
  parsed: { symbol?: string | null }
  brokers: BrokerRow[]
  channelDisplayName?: string | null
  channelUsername?: string | null
  /** Tickets observed open before DB-attributed closes began (per session uuid). */
  preCloseTicketsBySession?: Map<string, Set<number>>
  closeWithVerification: (
    api: FxsocketBrokerClient,
    uuid: string,
    ticket: number,
  ) => Promise<{ confirmed: boolean; reason?: string }>
}): Promise<{ closed: number; failed: number }> {
  const {
    supabase, api, signal, parsed, brokers, channelDisplayName, channelUsername,
    preCloseTicketsBySession, closeWithVerification,
  } = args
  const symbolFilter = parsed.symbol != null && String(parsed.symbol).trim()
    ? String(parsed.symbol).trim()
    : null
  const channelSlug = sanitizeChannelCommentSlug(
    channelDisplayName?.trim() || channelUsername?.trim().replace(/^@/, '') || '',
  ) || null

  let channelSignalIdPrefixes: Set<string> | undefined
  if (signal.channel_id) {
    const { data: sigRows } = await supabase
      .from('signals')
      .select('id')
      .eq('user_id', signal.user_id)
      .eq('channel_id', signal.channel_id)
      .order('created_at', { ascending: false })
      .limit(500)
    if (sigRows?.length) {
      channelSignalIdPrefixes = new Set(
        sigRows.map((r: { id: string }) => String(r.id).slice(0, 8).toLowerCase()),
      )
    }
  }

  let closed = 0
  let failed = 0

  await Promise.allSettled(brokers.map(async broker => {
    const uuid = brokerSessionUuid(broker)
    if (!uuid) return
    let rawOrders: unknown[] = []
    try {
      rawOrders = await api.openedOrders(uuid) ?? []
    } catch (err) {
      console.warn(
        `[mgmtBrokerClose] OpenedOrders failed during fallback sweep broker=${broker.id}:`,
        err instanceof Error ? err.message : err,
      )
      return
    }
    const parsedOrders = rawOrders
      .map(extractOpenOrderFromBrokerRaw)
      .filter((o): o is BrokerOpenOrderLike => o != null)
    const commentTargets = filterTscopierOrdersForChannelClose({
      orders: parsedOrders,
      channelSlug,
      symbolFilter,
      channelSignalIdPrefixes,
    })
    const snapshotTargets = filterSnapshotStragglerOrdersForClose({
      orders: parsedOrders,
      preCloseTickets: preCloseTicketsBySession?.get(uuid) ?? new Set(),
      symbolFilter,
      alreadyTargetedTickets: new Set(commentTargets.map(o => o.ticket)),
    })
    const targets = mergeOrderTargets(commentTargets, snapshotTargets)
    for (const order of targets) {
      try {
        const result = await closeWithVerification(api, uuid, order.ticket)
        if (!result.confirmed) {
          failed += 1
          continue
        }
        closed += 1
        await applyCloseUpdate(
          {
            status: 'closed',
            closed_at: new Date().toISOString(),
            close_reason: TRADE_CLOSE_REASON.SIGNAL_CLOSE,
          },
          patch => supabase
            .from('trades')
            .update(patch)
            .eq('user_id', signal.user_id)
            .eq('broker_account_id', broker.id)
            // The broker reports the position ticket; the row may hold the send
            // ticket. Match either so a confirmed close is never left open.
            .or(`metaapi_order_id.eq.${Number(order.ticket)},broker_position_ticket.eq.${Number(order.ticket)}`)
            .in('status', ['open', 'pending']),
        )
        if (signal.channel_id) {
          await clearChannelActiveTradeParamsWhenFlat(supabase, {
            userId: signal.user_id,
            channelId: signal.channel_id,
            symbolHint: order.symbol,
          })
        }
        await writeExecutionLog(supabase, {
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close',
          status: 'success',
          request_payload: {
            ticket: order.ticket,
            action: 'close',
            broker_fallback: true,
            snapshot_straggler: !commentTargets.some(t => t.ticket === order.ticket),
            symbol: order.symbol,
          },
        })
      } catch {
        failed += 1
      }
    }
  }))

  return { closed, failed }
}

/** Cancel all broker strict-entry pendings for a channel (mirrors copyLimitFlatten). */
export async function cancelChannelBrokerPendingOrders(args: {
  supabase: SupabaseClient
  userId: string
  channelId: string
  brokerAccountIds: string[]
  apiFor: (metaapiAccountId: string) => FxsocketBrokerClient | null
  /**
   * Broker access keyed by `trades.broker_account_id`. Required so the sweep
   * can also cancel resting `trades`-pending orders (explicit LIMIT/STOP
   * entries), which have no `signal_entry_pending_orders` row.
   */
  resolve: (brokerAccountId: string) => { api: PendingCancelApi; sessionId: string } | null
  reason: string
}): Promise<number> {
  const { supabase, userId, channelId, brokerAccountIds, apiFor, resolve, reason } = args
  if (!channelId || !brokerAccountIds.length) return 0

  const { data: channelSignals } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .limit(5000)
  const signalIds = (channelSignals ?? []).map((r: { id: string }) => r.id)
  if (!signalIds.length) return 0

  let cancelled = 0
  for (const brokerAccountId of brokerAccountIds) {
    const { data: seRows } = await supabase
      .from('signal_entry_pending_orders')
      .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy')
      .in('signal_id', signalIds)
      .eq('broker_account_id', brokerAccountId)
      .eq('status', 'broker_pending')
    for (const row of (seRows ?? []) as SignalEntryPendingRow[]) {
      const api = apiFor(row.metaapi_account_id)
      if (!api) continue
      const result = await cancelSignalEntryRowAtBroker(supabase, api, row, reason)
      if (result.ok) cancelled += 1
    }
  }
  // Resting explicit LIMIT/STOP entries live only in `trades` (status pending).
  const trades = await cancelTradesPendingOrders({ supabase, signalIds, brokerAccountIds, resolve })
  cancelled += trades.cancelled
  return cancelled
}
