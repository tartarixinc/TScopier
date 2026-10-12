import { purgeRangePendingLegsForBaskets } from '../rangePendingLegDelete'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import { closeWithVerification } from '../managementClose'
import { resolveCurrentLivePosition } from '../livePositionIdentity'
import { brokerHasLinkedSession, brokerSessionUuid } from './helpers'
import type { TradeExecutorContext } from './context'
import type { BrokerRow, SignalRow } from './types'
import { TRADE_CLOSE_REASON } from '../tradeCloseReasons'
import { applyCloseUpdate } from '../tradeCloseUpdate'
import { writeExecutionLog } from '../observability/executionLog'
export async function closeBasketForRevisionDirectionFlip(
  ctx: TradeExecutorContext,
  row: SignalRow,
  brokers: BrokerRow[],
): Promise<{ closed: number; failed: number }> {
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
      .select('id,metaapi_order_id,broker_position_ticket,symbol,signal_id,direction,lot_size,entry_price')
      .eq('user_id', row.user_id)
      .eq('broker_account_id', broker.id)
      .eq('signal_id', row.id)
      .eq('status', 'open')
      .limit(500)
    if (error || !openTrades?.length) continue

    for (const trade of openTrades as Array<{
      id: string
      metaapi_order_id: string | null
      broker_position_ticket?: string | null
      symbol: string
      signal_id: string
      direction: string
      lot_size: number
      entry_price: number | null
    }>) {
      const ticket = Number(trade.broker_position_ticket ?? trade.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) {
        failed += 1
        continue
      }
      try {
        const resolution = await resolveCurrentLivePosition({
          supabase: ctx.supabase,
          api,
          sessionId: uuid,
          trade,
        })
        if (resolution.status !== 'resolved') throw new Error(`close reconciliation required: ${resolution.reason}`)
        const result = await closeWithVerification(api, uuid, resolution.ticket)
        if (!result.confirmed) {
          failed += 1
          await writeExecutionLog(ctx.supabase, {
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
        await applyCloseUpdate(
          {
            status: 'closed',
            closed_at: new Date().toISOString(),
            close_reason: TRADE_CLOSE_REASON.SIGNAL_REVISION,
          },
          patch => ctx.supabase.from('trades').update(patch).eq('id', trade.id),
        )
        closed += 1
        purgeScopes.push({ signalId: trade.signal_id, brokerAccountId: broker.id })
        await writeExecutionLog(ctx.supabase, {
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
        await writeExecutionLog(ctx.supabase, {
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
