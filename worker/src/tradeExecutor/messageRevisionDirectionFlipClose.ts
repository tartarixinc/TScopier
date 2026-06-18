import { purgeRangePendingLegsForBaskets } from '../rangePendingLegDelete'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import { hasFxsocketConfigured, type FxsocketBrokerClient } from '../fxsocketClient'
import { brokerHasLinkedSession, brokerSessionUuid } from './helpers'
import type { TradeExecutorContext } from './context'
import type { BrokerRow, SignalRow } from './types'

interface CloseVerificationResult {
  confirmed: boolean
  reason?: string
}

async function closeWithVerification(
  api: FxsocketBrokerClient,
  uuid: string,
  ticket: number,
): Promise<CloseVerificationResult> {
  const maxAttempts = 2
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const slippage = 20 + (attempt - 1) * 50
    const result = await api.orderClose(uuid, { ticket, slippage })
    if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) {
      if (attempt >= maxAttempts) {
        return { confirmed: false, reason: `orderClose state=${result.state}` }
      }
      await new Promise(r => setTimeout(r, 300))
      continue
    }
    await new Promise(r => setTimeout(r, 400))
    try {
      const openOrders = await api.openedOrders(uuid)
      for (const raw of openOrders ?? []) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        const t = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (t === ticket) return { confirmed: false, reason: 'ticket_still_open' }
      }
    } catch {
      return { confirmed: true }
    }
    return { confirmed: true }
  }
  return { confirmed: false, reason: 'max_attempts' }
}

export async function closeBasketForRevisionDirectionFlip(
  ctx: TradeExecutorContext,
  row: SignalRow,
  brokers: BrokerRow[],
): Promise<{ closed: number; failed: number }> {
  if (!hasFxsocketConfigured()) return { closed: 0, failed: 0 }

  let closed = 0
  let failed = 0
  const purgeScopes: Array<{ signalId: string; brokerAccountId: string }> = []

  for (const broker of brokers) {
    if (!broker.is_active || !brokerHasLinkedSession(broker)) continue
    if (!channelMatchesBrokerSignal(broker, row.channel_id)) continue
    const uuid = brokerSessionUuid(broker)!
    const api = ctx.apiFor(broker)
    if (!api) continue

    const { data: openTrades, error } = await ctx.supabase
      .from('trades')
      .select('id,metaapi_order_id,symbol,signal_id')
      .eq('user_id', row.user_id)
      .eq('broker_account_id', broker.id)
      .eq('signal_id', row.id)
      .eq('status', 'open')
      .limit(500)
    if (error || !openTrades?.length) continue

    for (const trade of openTrades as Array<{
      id: string
      metaapi_order_id: string | null
      symbol: string
      signal_id: string
    }>) {
      const ticket = Number(trade.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) {
        failed += 1
        continue
      }
      try {
        const result = await closeWithVerification(api, uuid, ticket)
        if (!result.confirmed) {
          failed += 1
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: row.user_id,
            signal_id: row.id,
            broker_account_id: broker.id,
            action: 'message_revision_direction_flip_close',
            status: 'failed',
            request_payload: {
              trade_id: trade.id,
              ticket,
              reason: result.reason ?? 'close_not_confirmed',
              symbol: trade.symbol,
            } as unknown as Record<string, unknown>,
          })
          continue
        }
        await ctx.supabase
          .from('trades')
          .update({ status: 'closed', closed_at: new Date().toISOString() })
          .eq('id', trade.id)
        closed += 1
        purgeScopes.push({ signalId: trade.signal_id, brokerAccountId: broker.id })
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: row.user_id,
          signal_id: row.id,
          broker_account_id: broker.id,
          action: 'message_revision_direction_flip_close',
          status: 'success',
          request_payload: {
            trade_id: trade.id,
            ticket,
            symbol: trade.symbol,
          } as unknown as Record<string, unknown>,
        })
      } catch (err) {
        failed += 1
        const msg = err instanceof Error ? err.message : String(err)
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: row.user_id,
          signal_id: row.id,
          broker_account_id: broker.id,
          action: 'message_revision_direction_flip_close',
          status: 'failed',
          request_payload: {
            trade_id: trade.id,
            ticket,
            error: msg.slice(0, 300),
            symbol: trade.symbol,
          } as unknown as Record<string, unknown>,
        })
      }
    }
  }

  if (purgeScopes.length) {
    const unique = new Map<string, { signalId: string; brokerAccountId: string }>()
    for (const scope of purgeScopes) {
      unique.set(`${scope.signalId}:${scope.brokerAccountId}`, scope)
    }
    await purgeRangePendingLegsForBaskets(
      ctx.supabase,
      [...unique.values()].map(s => ({
        signalId: s.signalId,
        brokerAccountId: s.brokerAccountId,
      })),
      'message_revision_direction_flip',
    )
  }

  return { closed, failed }
}

export async function waitForSignalBasketFlat(
  ctx: TradeExecutorContext,
  row: SignalRow,
  brokers: BrokerRow[],
  deadlineMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    let anyOpen = false
    for (const broker of brokers) {
      if (!channelMatchesBrokerSignal(broker, row.channel_id)) continue
      const { count } = await ctx.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', row.user_id)
        .eq('broker_account_id', broker.id)
        .eq('signal_id', row.id)
        .eq('status', 'open')
      if ((count ?? 0) > 0) {
        anyOpen = true
        break
      }
    }
    if (!anyOpen) return true
    await new Promise(r => setTimeout(r, 150))
  }
  return false
}
