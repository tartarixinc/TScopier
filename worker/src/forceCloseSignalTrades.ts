/**
 * User-initiated force-close of signal-attributed open positions on a broker account.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { clearChannelActiveTradeParamsWhenFlat } from './channelActiveTradeParams'
import { normalizeSignalChannelIds } from './brokerChannelFilter'
import { hasFxsocketConfigured } from './fxsocketClient'
import { apiForBrokerAccount } from './providerResolver'
import { closeWithVerification } from './managementClose'
import {
  cancelChannelBrokerPendingOrders,
  tryBrokerFallbackClose,
} from './managementBrokerClose'
import { loadOpenTradesForManagement, loadTradesForBasketAnchorChecked, type MgmtTradeRow } from './managementScope'
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
  error?: string
}

type BrokerRow = {
  id: string
  user_id: string
  provider?: string | null
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
  return /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order|unknown\s+ticket/i.test(message)
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
    scope: 'channel' | 'all' | 'signal'
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

  const uuid = brokerSessionUuid(broker)
  const api = apiForBrokerAccount(broker.provider, uuid)
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
    .select('id,user_id,platform,provider,mtapi_session_id,fxsocket_account_id,metaapi_account_id,signal_channel_ids')
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

/**
 * User-initiated force-close of ONE signal's open positions across every
 * broker account that holds them (the "Close this trade" action in the
 * Edit SL/TP modal). Unlike the channel/broker scope above, this never
 * touches other signals' trades or the channel's other pending orders.
 */
export async function forceCloseSignalById(
  supabase: SupabaseClient,
  args: { userId: string; signalId: string },
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

  const userId = args.userId.trim()
  const signalId = args.signalId.trim()
  if (!userId || !signalId) {
    return { ...empty, reason: 'missing_ids' }
  }

  const { data: signal, error: sigErr } = await supabase
    .from('signals')
    .select('id,user_id,channel_id')
    .eq('id', signalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (sigErr) {
    // Transient DB failure — never report it as "signal gone".
    return { ...empty, ok: false, reason: 'close_failed', error: sigErr.message }
  }
  if (!signal) {
    return { ...empty, reason: 'signal_not_found' }
  }
  const channelId = (signal as { channel_id?: string | null }).channel_id ?? null

  const { data: brokerCells, error: cellsErr } = await supabase
    .from('trades')
    .select('broker_account_id')
    .eq('user_id', userId)
    .eq('signal_id', signalId)
    .in('status', ['open', 'pending'])
  if (cellsErr) {
    return { ...empty, ok: false, reason: 'close_failed', error: cellsErr.message }
  }
  const brokerIdSet = new Set<string>()
  let orphanLegs = 0
  for (const r of (brokerCells ?? [])) {
    const id = String((r as { broker_account_id?: string | null }).broker_account_id ?? '').trim()
    if (id) brokerIdSet.add(id)
    else orphanLegs += 1 // broker deleted (SET NULL) — cannot close, but must not vanish from the count
  }
  // Queued layering legs may exist on brokers that hold no materialized trade
  // yet — those brokers must be swept too, or the plan re-opens a position
  // right after the close.
  const { data: pendingLegCells, error: pendingLegsErr } = await supabase
    .from('range_pending_legs')
    .select('broker_account_id')
    .eq('user_id', userId)
    .eq('signal_id', signalId)
    .in('status', ['pending', 'claimed', 'broker_pending'])
  if (pendingLegsErr) {
    return { ...empty, ok: false, reason: 'close_failed', error: pendingLegsErr.message }
  }
  for (const r of (pendingLegCells ?? [])) {
    const id = String((r as { broker_account_id?: string | null }).broker_account_id ?? '').trim()
    if (id) brokerIdSet.add(id)
  }
  const brokerIds = [...brokerIdSet]
  if (brokerIds.length === 0) {
    if (orphanLegs > 0) {
      return { ...empty, ok: false, failed: orphanLegs, reason: 'close_failed' }
    }
    return { ...empty, ok: true, reason: 'no_open_trades' }
  }

  const { rows, error: legLoadErr } = await loadTradesForBasketAnchorChecked(supabase, {
    userId,
    brokerAccountIds: brokerIds,
    anchorSignalId: signalId,
  })
  if (legLoadErr) {
    // A failed leg load must never be reported as "no open positions".
    return { ...empty, ok: false, reason: 'close_failed', error: legLoadErr }
  }

  const { data: brokerRows, error: brokerRowsErr } = await supabase
    .from('broker_accounts')
    .select('id,user_id,provider,platform,mtapi_session_id,fxsocket_account_id,metaapi_account_id')
    .eq('user_id', userId)
    .in('id', brokerIds)
  if (brokerRowsErr) {
    return { ...empty, ok: false, reason: 'close_failed', error: brokerRowsErr.message }
  }

  let closed = 0
  let failed = orphanLegs
  let virtualLegsDeleted = 0
  let brokersProcessed = 0

  for (const broker of (brokerRows ?? [])) {
    const brokerId = (broker as { id: string }).id
    const legs = rows.filter(r => r.broker_account_id === brokerId)
    const uuid = brokerSessionUuid(broker)
    const api = apiForBrokerAccount((broker as BrokerRow).provider, uuid)
    if (!api || !uuid || uuid.includes('|') || !brokerHasLinkedSession(broker as BrokerRow)) {
      // Broker holds this signal's legs but cannot be reached — count them so
      // a mixed run reports partial failure instead of silent success, and
      // still sweep queued legs (DB-level; broker-side cancel is best-effort).
      if (legs.length) failed += legs.length
      const skippedVirtualDeleted = await deleteRangePendingLegsForBasket(
        supabase,
        { signalId, brokerAccountId: brokerId },
        'user_force_close',
      )
      virtualLegsDeleted += skippedVirtualDeleted
      if (legs.length > 0 || skippedVirtualDeleted > 0) {
        await insertForceCloseLog(supabase, {
          userId,
          brokerAccountId: brokerId,
          signalId,
          scope: 'signal',
          channelId: channelId ?? '',
          closed: 0,
          failed: legs.length,
          pendingCancelled: 0,
          virtualLegsDeleted: skippedVirtualDeleted,
        })
      }
      continue
    }
    brokersProcessed += 1

    let brokerClosed = 0
    let brokerFailed = 0
    const now = new Date().toISOString()

    for (const trade of legs) {
      const ticket = Number(trade.metaapi_order_id)
      const markDone = async () => {
        const terminalStatus = trade.status === 'pending' ? 'cancelled' : 'closed'
        await supabase
          .from('trades')
          .update({ status: terminalStatus, closed_at: now })
          .eq('id', trade.id)
          .in('status', ['open', 'pending'])
        if (channelId) {
          await clearChannelActiveTradeParamsWhenFlat(supabase, {
            userId,
            channelId,
            symbolHint: trade.symbol,
          })
        }
      }
      if (!Number.isFinite(ticket) || ticket <= 0) {
        brokerFailed += 1
        continue
      }
      try {
        const closeResult = await closeWithVerification(api, uuid, ticket, { liveFast: true })
        if (!closeResult.confirmed) {
          brokerFailed += 1
          continue
        }
        brokerClosed += 1
        await markDone()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (isBenignCloseError(msg)) {
          brokerClosed += 1
          await markDone()
        } else {
          brokerFailed += 1
        }
      }
    }

    const brokerVirtualDeleted = await deleteRangePendingLegsForBasket(
      supabase,
      { signalId, brokerAccountId: brokerId },
      'user_force_close',
    )
    virtualLegsDeleted += brokerVirtualDeleted

    if (brokerClosed > 0 || brokerFailed > 0 || brokerVirtualDeleted > 0) {
      await insertForceCloseLog(supabase, {
        userId,
        brokerAccountId: brokerId,
        signalId,
        scope: 'signal',
        channelId: channelId ?? '',
        closed: brokerClosed,
        failed: brokerFailed,
        pendingCancelled: 0,
        virtualLegsDeleted: brokerVirtualDeleted,
      })
    }

    closed += brokerClosed
    failed += brokerFailed
  }

  if (brokersProcessed === 0) {
    return { ...empty, ok: false, failed, virtual_legs_deleted: virtualLegsDeleted, reason: 'broker_not_connected' }
  }
  if (closed === 0 && failed === 0 && virtualLegsDeleted === 0) {
    return { ...empty, ok: true, reason: 'no_open_trades' }
  }

  console.log(
    `[forceCloseSignalById] signal=${signalId} closed=${closed} failed=${failed}`
    + ` virtual_deleted=${virtualLegsDeleted} brokers=${brokersProcessed}`,
  )

  return {
    ok: failed === 0 || closed > 0,
    closed,
    failed,
    pending_cancelled: 0,
    virtual_legs_deleted: virtualLegsDeleted,
    channels_processed: brokersProcessed,
    ...(failed > 0 && closed === 0 ? { reason: 'close_failed' } : {}),
  }
}
