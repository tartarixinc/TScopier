import { isOppositeSignalCloseBlocked, isPendingCancelBlocked, normalizeChannelMessageFiltersMap } from '../../channelMessageFilters'
import { type ManualSettings } from '../../manualPlanner'
import { hasFxsocketConfigured } from '../../fxsocketClient'
import { type TradeExecutorContext } from '../context'
import {
  type BrokerRow,
  type ParsedSignal,
  type RangePendingCancelScope,
  type SignalRow
} from '../types'
import { brokerSessionUuid } from '../helpers'
import { cancelRangePendingLegsForScopes } from './pendingCancel'

export async function closeOppositeDirectionTrades(ctx: TradeExecutorContext, 
    signal: SignalRow,
    parsed: ParsedSignal,
    broker: BrokerRow,
    symbol: string,
  ): Promise<void> {
    if (!hasFxsocketConfigured()) return
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
      .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size')
      .eq('broker_account_id', broker.id)
      .eq('symbol', symbol)
      .eq('status', 'open')
      .eq('direction', oppDir)
    const rows = opposites ?? []
    if (!rows.length) return

    const scopes: RangePendingCancelScope[] = []
    for (const t of rows) {
      const ticket = Number(t.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) continue
      try {
        await api.orderClose(uuid, { ticket })
        await ctx.supabase
          .from('trades')
          .update({ status: 'closed', closed_at: new Date().toISOString() })
          .eq('id', t.id)
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
