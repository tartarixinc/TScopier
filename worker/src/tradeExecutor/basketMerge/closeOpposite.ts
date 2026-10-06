import { isOppositeSignalCloseBlocked, isPendingCancelBlocked, normalizeChannelMessageFiltersMap } from '../../channelMessageFilters'
import { type ManualSettings } from '../../manualPlanner'
import { type TradeExecutorContext } from '../context'
import {
  type BrokerRow,
  type ParsedSignal,
  type RangePendingCancelScope,
  type SignalRow
} from '../types'
import { brokerSessionUuid } from '../helpers'
import { closeWithVerification } from '../../managementClose'
import { resolveCurrentLivePosition } from '../../livePositionIdentity'
import { cancelRangePendingLegsForScopes } from './pendingCancel'
import { TRADE_CLOSE_REASON } from '../../tradeCloseReasons'
import { applyCloseUpdate } from '../../tradeCloseUpdate'

export async function closeOppositeDirectionTrades(ctx: TradeExecutorContext, 
    signal: SignalRow,
    parsed: ParsedSignal,
    broker: BrokerRow,
    symbol: string,
  ): Promise<void> {
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    if (manual.close_on_opposite_signal !== true) return
    if (isOppositeSignalCloseBlocked(
      normalizeChannelMessageFiltersMap(broker.channel_message_filters),
      signal.channel_id,
    )) return
    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return
    const channelBuy = a === 'buy'
    const oppDir = channelBuy ? 'sell' : 'buy'
    const uuid = brokerSessionUuid(broker)!
    const api = ctx.apiFor(broker)
    if (!api) return
    const { data: opposites } = await ctx.supabase
      .from('trades')
      .select('id,signal_id,broker_account_id,metaapi_order_id,broker_position_ticket,symbol,direction,lot_size,entry_price')
      .eq('broker_account_id', broker.id)
      .eq('symbol', symbol)
      .eq('status', 'open')
      .eq('direction', oppDir)
    const rows = opposites ?? []
    if (!rows.length) return

    const scopes: RangePendingCancelScope[] = []
    for (const t of rows) {
      const ticket = Number(t.broker_position_ticket ?? t.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) continue
      try {
        const resolution = await resolveCurrentLivePosition({
          supabase: ctx.supabase,
          api,
          sessionId: uuid,
          trade: t,
        })
        if (resolution.status !== 'resolved') throw new Error(`close reconciliation required: ${resolution.reason}`)
        const close = await closeWithVerification(api, uuid, resolution.ticket, { liveFast: true })
        if (!close.confirmed) throw new Error(close.reason ?? 'close reconciliation required')
        await applyCloseUpdate(
          {
            status: 'closed',
            closed_at: new Date().toISOString(),
            close_reason: TRADE_CLOSE_REASON.OPPOSITE_SIGNAL,
          },
          patch => ctx.supabase.from('trades').update(patch).eq('id', t.id),
        )
        scopes.push({ signalId: t.signal_id, brokerAccountId: broker.id, symbol })
        try {
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'opposite_signal_close',
            status: 'success',
            request_payload: {
              closed_trade_id: t.id,
              ticket,
              direction: t.direction,
              channel_action: a,
              symbol,
            } as unknown as Record<string, unknown>,
          })
        } catch {
          // logging best-effort
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradeExecutor] opposite_signal_close failed trade=${t.id} ticket=${ticket} broker=${broker.id}: ${msg}`,
        )
        try {
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'opposite_signal_close',
            status: 'failed',
            request_payload: { closed_trade_id: t.id, ticket, symbol } as unknown as Record<string, unknown>,
            error_message: msg,
          })
        } catch {
          // best-effort
        }
      }
    }
    if (scopes.length && !isPendingCancelBlocked(
      normalizeChannelMessageFiltersMap(broker.channel_message_filters),
      signal.channel_id,
    )) {
      await cancelRangePendingLegsForScopes(ctx, signal.user_id, signal.id, scopes, 'opposite_signal_close')
    }
  }
