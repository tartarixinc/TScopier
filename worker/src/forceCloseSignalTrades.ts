/**
 * User-initiated force-close of signal-attributed open positions on a broker account.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { clearChannelActiveTradeParamsWhenFlat } from './channelActiveTradeParams'
import { normalizeSignalChannelIds } from './brokerChannelFilter'
import { getFxsocketClient, hasFxsocketConfigured } from './fxsocketClient'
import { closeWithVerification } from './managementClose'
import {
  cancelChannelBrokerPendingOrders,
  tryBrokerFallbackClose,
} from './managementBrokerClose'
import { loadOpenTradesForManagement, type MgmtTradeRow } from './managementScope'
import { deleteRangePendingLegsForBasket } from './rangePendingLegDelete'
import {
  resolveChannelLabelForComment,
  sanitizeChannelCommentSlug,
} from './tradeComment'
import { brokerHasLinkedSession, brokerSessionUuid } from './tradeExecutor/helpers'
import type { BrokerRow as ExecutorBrokerRow } from './tradeExecutor/types'

export type ForceCloseSignalTradesResult = {
  ok: boolean
  closed: number
  failed: number
  pending_cancelled: number
  virtual_legs_deleted: number
  channels_processed: number
  reason?: string
}

type BrokerRow = {
  id: string
  user_id: string
  platform?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  signal_channel_ids?: string[] | null
}

type ChannelCloseAccum = {
  closed: number
  failed: number
  pending_cancelled: number
  virtual_legs_deleted: number
}

function isBenignCloseError(message: string): boolean {
  return /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(message)
}

async function loadChannelCommentSlug(
  supabase: SupabaseClient,
  channelId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('telegram_channels')
    .select('display_name, channel_username')
    .eq('id', channelId)
    .maybeSingle()
  const row = data as {
    display_name?: string | null
    channel_username?: string | null
  } | null
  const label = resolveChannelLabelForComment(row?.display_name, row?.channel_username)
  return label ? sanitizeChannelCommentSlug(label) : null
}

async function resolveLogSignalId(
  supabase: SupabaseClient,
  userId: string,
  channelId: string,
  trades: MgmtTradeRow[],
): Promise<string | null> {
  const fromTrade = trades.find(t => t.signal_id)?.signal_id
  if (fromTrade) return fromTrade
  const { data } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id?: string } | null)?.id ?? null
}

async function discoverAttributedChannelIds(
  supabase: SupabaseClient,
  userId: string,
  brokerAccountId: string,
  linkedChannelIds: string[],
): Promise<string[]> {
  const linked = new Set(linkedChannelIds.map(id => id.trim().toLowerCase()).filter(Boolean))
  const found = new Set<string>()

  const { data: openTrades } = await supabase
    .from('trades')
    .select('telegram_channel_id, signal_id')
    .eq('user_id', userId)
    .eq('broker_account_id', brokerAccountId)
    .in('status', ['open', 'pending'])

  const signalIds = new Set<string>()
  for (const row of (openTrades ?? []) as Array<{ telegram_channel_id?: string | null; signal_id?: string | null }>) {
    const ch = String(row.telegram_channel_id ?? '').trim()
    if (ch && (linked.size === 0 || linked.has(ch.toLowerCase()))) found.add(ch)
    const sigId = String(row.signal_id ?? '').trim()
    if (sigId) signalIds.add(sigId)
  }

  if (signalIds.size > 0) {
    const { data: signalRows } = await supabase
      .from('signals')
      .select('id, channel_id')
      .eq('user_id', userId)
      .in('id', [...signalIds])
    for (const row of (signalRows ?? []) as Array<{ channel_id?: string | null }>) {
      const ch = String(row.channel_id ?? '').trim()
      if (ch && (linked.size === 0 || linked.has(ch.toLowerCase()))) found.add(ch)
    }
  }

  const { data: attribRows } = await supabase
    .from('trade_channel_attributions')
    .select('channel_id, trade_id')
    .eq('user_id', userId)
    .eq('broker_account_id', brokerAccountId)

  const attribTradeIds = (attribRows ?? []).map((r: { trade_id: string }) => r.trade_id).filter(Boolean)
  if (attribTradeIds.length > 0) {
    const { data: attribTrades } = await supabase
      .from('trades')
      .select('id')
      .eq('user_id', userId)
      .in('id', attribTradeIds)
      .in('status', ['open', 'pending'])
    const openAttribIds = new Set((attribTrades ?? []).map((r: { id: string }) => r.id))
    for (const row of (attribRows ?? []) as Array<{ channel_id?: string | null; trade_id?: string }>) {
      if (!row.trade_id || !openAttribIds.has(row.trade_id)) continue
      const ch = String(row.channel_id ?? '').trim()
      if (ch && (linked.size === 0 || linked.has(ch.toLowerCase()))) found.add(ch)
    }
  }

  return [...found]
}

async function insertForceCloseLog(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountId: string
    signalId: string | null
    scope: 'channel' | 'all'
    channelId: string
    closed: number
    failed: number
    pendingCancelled: number
    virtualLegsDeleted: number
  },
): Promise<void> {
  if (!args.signalId) return
  const status = args.failed > 0 && args.closed === 0 ? 'failed' : 'success'
  await supabase.from('trade_execution_logs').insert({
    user_id: args.userId,
    signal_id: args.signalId,
    broker_account_id: args.brokerAccountId,
    action: 'user_force_close',
    status,
    request_payload: {
      scope: args.scope,
      channel_id: args.channelId,
      closed: args.closed,
      failed: args.failed,
      pending_cancelled: args.pendingCancelled,
      virtual_legs_deleted: args.virtualLegsDeleted,
    },
    ...(status === 'failed' ? { error_message: 'force_close_failed' } : {}),
  })
}

async function forceCloseChannelOnBroker(
  supabase: SupabaseClient,
  args: {
    userId: string
    broker: BrokerRow
    channelId: string
    scope: 'channel' | 'all'
  },
): Promise<ChannelCloseAccum> {
  const { broker } = args
  const result: ChannelCloseAccum = {
    closed: 0,
    failed: 0,
    pending_cancelled: 0,
    virtual_legs_deleted: 0,
  }

  const api = getFxsocketClient()
  const uuid = brokerSessionUuid(broker)
  if (!api || !uuid || uuid.includes('|')) return result

  const trades = await loadOpenTradesForManagement(supabase, {
    userId: args.userId,
    channelId: args.channelId,
    brokerAccountIds: [broker.id],
  })

  const now = new Date().toISOString()
  const basketScopes = new Map<string, { signalId: string; brokerAccountId: string }>()

  for (const trade of trades) {
    if (trade.signal_id) {
      basketScopes.set(`${trade.signal_id}|${trade.broker_account_id}`, {
        signalId: trade.signal_id,
        brokerAccountId: trade.broker_account_id,
      })
    }

    const ticket = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue

    try {
      const closeResult = await closeWithVerification(api, uuid, ticket, { liveFast: true })
      if (!closeResult.confirmed) {
        result.failed += 1
        continue
      }
      result.closed += 1
      const terminalStatus = trade.status === 'pending' ? 'cancelled' : 'closed'
      await supabase
        .from('trades')
        .update({ status: terminalStatus, closed_at: now })
        .eq('id', trade.id)
        .in('status', ['open', 'pending'])
      await clearChannelActiveTradeParamsWhenFlat(supabase, {
        userId: args.userId,
        channelId: args.channelId,
        symbolHint: trade.symbol,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isBenignCloseError(msg)) {
        result.closed += 1
        const terminalStatus = trade.status === 'pending' ? 'cancelled' : 'closed'
        await supabase
          .from('trades')
          .update({ status: terminalStatus, closed_at: now })
          .eq('id', trade.id)
          .in('status', ['open', 'pending'])
        await clearChannelActiveTradeParamsWhenFlat(supabase, {
          userId: args.userId,
          channelId: args.channelId,
          symbolHint: trade.symbol,
        })
      } else {
        result.failed += 1
      }
    }
  }

  result.pending_cancelled = await cancelChannelBrokerPendingOrders({
    supabase,
    userId: args.userId,
    channelId: args.channelId,
    brokerAccountIds: [broker.id],
    apiFor: () => api,
    reason: 'user_force_close',
  })

  const { data: channelSignals } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
    .limit(5000)
  const signalIds = (channelSignals ?? []).map((r: { id: string }) => r.id)
  if (signalIds.length) {
    const { data: virtualLegs } = await supabase
      .from('range_pending_legs')
      .select('signal_id,broker_account_id')
      .in('signal_id', signalIds)
      .eq('broker_account_id', broker.id)
      .in('status', ['pending', 'claimed'])
    for (const leg of virtualLegs ?? []) {
      const signalId = String((leg as { signal_id: string }).signal_id)
      basketScopes.set(`${signalId}|${broker.id}`, {
        signalId,
        brokerAccountId: broker.id,
      })
    }
  }

  for (const scope of basketScopes.values()) {
    result.virtual_legs_deleted += await deleteRangePendingLegsForBasket(
      supabase,
      scope,
      'user_force_close',
    )
  }

  const logSignalId = await resolveLogSignalId(supabase, args.userId, args.channelId, trades)
  const commentSlug = await loadChannelCommentSlug(supabase, args.channelId)
  if (logSignalId) {
    const fallback = await tryBrokerFallbackClose({
      supabase,
      api,
      signal: {
        id: logSignalId,
        user_id: args.userId,
        channel_id: args.channelId,
      },
      parsed: { symbol: null },
      brokers: [broker as unknown as ExecutorBrokerRow],
      channelDisplayName: commentSlug,
      channelUsername: null,
      closeWithVerification: (a, u, ticket) => closeWithVerification(a, u, ticket, { liveFast: true }),
    })
    result.closed += fallback.closed
    result.failed += fallback.failed
  }

  await insertForceCloseLog(supabase, {
    userId: args.userId,
    brokerAccountId: broker.id,
    signalId: logSignalId,
    scope: args.scope,
    channelId: args.channelId,
    closed: result.closed,
    failed: result.failed,
    pendingCancelled: result.pending_cancelled,
    virtualLegsDeleted: result.virtual_legs_deleted,
  })

  console.log(
    `[forceCloseSignalTrades] broker=${broker.id} channel=${args.channelId}`
    + ` closed=${result.closed} failed=${result.failed}`
    + ` pending_cancelled=${result.pending_cancelled} virtual_deleted=${result.virtual_legs_deleted}`,
  )

  return result
}

export async function forceCloseSignalTrades(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountId: string
    channelId?: string | null
  },
): Promise<ForceCloseSignalTradesResult> {
  const empty: ForceCloseSignalTradesResult = {
    ok: false,
    closed: 0,
    failed: 0,
    pending_cancelled: 0,
    virtual_legs_deleted: 0,
    channels_processed: 0,
  }

  if (!hasFxsocketConfigured()) {
    return { ...empty, reason: 'broker_api_not_configured' }
  }

  const brokerAccountId = args.brokerAccountId.trim()
  const userId = args.userId.trim()
  if (!brokerAccountId || !userId) {
    return { ...empty, reason: 'missing_ids' }
  }

  const { data: broker, error: brokerErr } = await supabase
    .from('broker_accounts')
    .select('id,user_id,platform,fxsocket_account_id,metaapi_account_id,signal_channel_ids')
    .eq('id', brokerAccountId)
    .eq('user_id', userId)
    .maybeSingle()
  if (brokerErr || !broker) {
    return { ...empty, reason: 'broker_not_found' }
  }
  if (!brokerHasLinkedSession(broker as BrokerRow)) {
    return { ...empty, reason: 'broker_not_connected' }
  }

  const linkedChannelIds = normalizeSignalChannelIds(
    (broker as BrokerRow).signal_channel_ids,
  )
  const requestedChannelId = args.channelId?.trim() || null

  let channelIds: string[]
  if (requestedChannelId) {
    if (
      linkedChannelIds.length > 0
      && !linkedChannelIds.some(id => id.toLowerCase() === requestedChannelId.toLowerCase())
    ) {
      return { ...empty, reason: 'channel_not_linked' }
    }
    channelIds = [requestedChannelId]
  } else {
    channelIds = await discoverAttributedChannelIds(
      supabase,
      userId,
      brokerAccountId,
      linkedChannelIds,
    )
  }

  if (channelIds.length === 0) {
    return { ...empty, ok: true, reason: 'no_open_channels' }
  }

  let closed = 0
  let failed = 0
  let pending_cancelled = 0
  let virtual_legs_deleted = 0

  for (const channelId of channelIds) {
    const one = await forceCloseChannelOnBroker(supabase, {
      userId,
      broker: broker as BrokerRow,
      channelId,
      scope: requestedChannelId ? 'channel' : 'all',
    })
    closed += one.closed
    failed += one.failed
    pending_cancelled += one.pending_cancelled
    virtual_legs_deleted += one.virtual_legs_deleted
  }

  return {
    ok: failed === 0 || closed > 0,
    closed,
    failed,
    pending_cancelled,
    virtual_legs_deleted,
    channels_processed: channelIds.length,
    ...(failed > 0 && closed === 0 ? { reason: 'close_failed' } : {}),
  }
}
