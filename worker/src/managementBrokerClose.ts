/**
 * Broker-side fallback when DB has no open trades for a channel close instruction.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { clearChannelActiveTradeParamsWhenFlat } from './channelActiveTradeParams'
import { parseTscopierComment, tscopierCommentMatchesChannelSlug } from './tscopierComment'
import {
  cancelSignalEntryRowAtBroker,
  rawNumericOrderKind,
  rawOrderOperation,
  rawOrderTicket,
  type SignalEntryPendingRow,
} from './signalEntryPendingHelpers'
import { sanitizeChannelCommentSlug } from './tradeComment'
import type { BrokerRow } from './tradeExecutor/types'
import { brokerSessionUuid } from './tradeExecutor/helpers'

export type BrokerOpenOrderLike = {
  ticket: number
  symbol: string
  comment: string
  lots: number
  isBuy: boolean
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
  return { ticket, symbol, comment, lots: Number.isFinite(lots) ? lots : 0, isBuy }
}

export function filterTscopierOrdersForChannelClose(args: {
  orders: BrokerOpenOrderLike[]
  channelSlug: string | null
  symbolFilter: string | null
  channelSignalIdPrefixes?: Set<string>
}): BrokerOpenOrderLike[] {
  const { orders, channelSlug, symbolFilter, channelSignalIdPrefixes } = args
  return orders.filter(o => {
    if (!o.comment.startsWith('TSCopier:')) return false
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

export async function tryBrokerFallbackClose(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  signal: { id: string; user_id: string; channel_id: string | null }
  parsed: { symbol?: string | null }
  brokers: BrokerRow[]
  channelDisplayName?: string | null
  channelUsername?: string | null
  closeWithVerification: (
    api: FxsocketBrokerClient,
    uuid: string,
    ticket: number,
  ) => Promise<{ confirmed: boolean; reason?: string }>
}): Promise<{ closed: number; failed: number }> {
  const {
    supabase, api, signal, parsed, brokers, channelDisplayName, channelUsername, closeWithVerification,
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
    } catch {
      return
    }
    const parsedOrders = rawOrders
      .map(extractOpenOrderFromBrokerRaw)
      .filter((o): o is BrokerOpenOrderLike => o != null)
    const targets = filterTscopierOrdersForChannelClose({
      orders: parsedOrders,
      channelSlug,
      symbolFilter,
      channelSignalIdPrefixes,
    })
    for (const order of targets) {
      try {
        const result = await closeWithVerification(api, uuid, order.ticket)
        if (!result.confirmed) {
          failed += 1
          continue
        }
        closed += 1
        await supabase
          .from('trades')
          .update({ status: 'closed', closed_at: new Date().toISOString() })
          .eq('user_id', signal.user_id)
          .eq('broker_account_id', broker.id)
          .eq('metaapi_order_id', String(order.ticket))
          .in('status', ['open', 'pending'])
        if (signal.channel_id) {
          await clearChannelActiveTradeParamsWhenFlat(supabase, {
            userId: signal.user_id,
            channelId: signal.channel_id,
            symbolHint: order.symbol,
          })
        }
        await supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close',
          status: 'success',
          request_payload: {
            ticket: order.ticket,
            action: 'close',
            broker_fallback: true,
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
  reason: string
}): Promise<number> {
  const { supabase, userId, channelId, brokerAccountIds, apiFor, reason } = args
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
  return cancelled
}
