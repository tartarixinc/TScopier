import { MtOperation, OrderSendArgs } from '../fxsocketClient'
import { clampPendingExpiryHours } from '../manualPlanner'
import { autoManagementTradeSnapshot } from '../autoManagement'
import type { TradeExecutorContext } from './context'
import { clampOrderStops, roundLot } from './helpers'
import type { PreparedEntry } from './entryPrepare'

/**
 * Place a broker BuyLimit/SellLimit when strict signal entry defers immediates.
 * Multi/range uses aggregated volume and plan TP; single may override TP from parsed.
 */
export async function placeStrictSignalEntryPending(
  ctx: TradeExecutorContext,
  prep: PreparedEntry,
  singleTpOverride: boolean,
): Promise<boolean> {
  const {
    signal, parsed, broker, manual, api, uuid, symbol, params, plan, capped,
    strictDeferred, commentPrefix,
  } = prep
  if (!strictDeferred || !plan.strictEntry || capped.length === 0 || !api) return false

  const se = plan.strictEntry
  const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
  const entryPx = Number(se.entryPrice.toFixed(digits))
  const pendHours = clampPendingExpiryHours(manual.pending_expiry_hours)
  const nowMs = Date.now()
  const expiresAt = pendHours > 0
    ? new Date(nowMs + pendHours * 60 * 60 * 1000).toISOString()
    : null
  const pendingOp: MtOperation = se.isBuy ? 'BuyLimit' : 'SellLimit'
  const first = capped[0]!
  let aggVol = 0
  for (const o of capped) aggVol += Number(o.volume) || 0
  const vol = roundLot(capped.length === 1 ? Number(first.volume) || 0 : aggVol, params)
  const baseComment = first.comment ?? commentPrefix
  const comment = capped.length === 1 ? `${baseComment}:strictEntry` : `${baseComment}:strictEntryAgg`

  // planSingleManualOrders already sets broker TP to the last enabled bucket target.
  const takeprofitPx = first.takeprofit ?? 0
  const takeprofitRounded = Number.isFinite(takeprofitPx) && takeprofitPx > 0
    ? Number(takeprofitPx.toFixed(digits))
    : 0

  const sendArgs: OrderSendArgs = {
    symbol,
    operation: pendingOp,
    volume: vol,
    price: entryPx,
    stoploss: first.stoploss ?? 0,
    takeprofit: takeprofitRounded,
    slippage: first.slippage ?? 20,
    comment,
    expertID: first.expertID ?? 909090,
  }
  const clamped = clampOrderStops(sendArgs, params)
  if (clamped.adjustments.length > 0) {
    console.warn(
      `[tradeExecutor] strict entry pending stops clamped signal=${signal.id} broker=${broker.id}: ${clamped.adjustments.join(', ')}`,
    )
  }

    try {
      let result
      try {
        result = await api.orderSend(uuid, clamped.args)
      } catch (sendErr) {
        const msg = sendErr instanceof Error ? sendErr.message : String(sendErr)
        const isInvalidStops = /invalid\s+stops/i.test(msg)
        const hasStops = (Number(clamped.args.stoploss) || 0) > 0
          || (Number(clamped.args.takeprofit) || 0) > 0
        if (isInvalidStops && hasStops) {
          console.warn(
            `[tradeExecutor] strict entry retry without stops signal=${signal.id} broker=${broker.id}: ${msg}`,
          )
          result = await api.orderSend(uuid, { ...clamped.args, stoploss: 0, takeprofit: 0 })
        } else {
          throw sendErr
        }
      }
    const ticket = result.ticket
    const isBuyLeg = se.isBuy
    const pendingSl = clamped.args.stoploss && clamped.args.stoploss > 0 ? clamped.args.stoploss : null
    const autoBeCols = autoManagementTradeSnapshot(manual, entryPx, pendingSl)
    const tradeInsert = await ctx.supabase
      .from('trades')
      .insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        telegram_channel_id: signal.channel_id,
        broker_account_id: broker.id,
        metaapi_order_id: String(ticket),
        symbol,
        direction: isBuyLeg ? 'buy' : 'sell',
        entry_price: entryPx,
        sl: pendingSl,
        tp: clamped.args.takeprofit && clamped.args.takeprofit > 0 ? clamped.args.takeprofit : null,
        lot_size: result.lots ?? vol,
        status: 'pending',
        opened_at: new Date().toISOString(),
        cwe_close_price: null,
        ...autoBeCols,
      })
      .select('id')
      .maybeSingle()

    if (tradeInsert.error) {
      console.error(
        `[tradeExecutor] trades INSERT failed after strict pending OrderSend signal=${signal.id} broker=${broker.id} ticket=${ticket}: ${tradeInsert.error.message}`,
      )
      try {
        await api.orderClose(uuid, { ticket })
      } catch { /* best-effort rollback */ }
      return false
    }

    const tradeId = (tradeInsert.data as { id?: string } | null)?.id ?? null
    if (!tradeId) {
      console.error(
        `[tradeExecutor] trades INSERT returned no id after strict pending OrderSend signal=${signal.id} broker=${broker.id} ticket=${ticket}`,
      )
      try {
        await api.orderClose(uuid, { ticket })
      } catch { /* best-effort rollback */ }
      return false
    }

    const partialTpPlan =
      singleTpOverride && capped.length === 1 && plan.partialTps?.length ? plan.partialTps : null
    const { error: sepErr } = await ctx.supabase.from('signal_entry_pending_orders').insert({
      signal_id: signal.id,
      user_id: signal.user_id,
      broker_account_id: broker.id,
      metaapi_account_id: uuid,
      symbol,
      trade_id: tradeId,
      is_buy: se.isBuy,
      operation: pendingOp,
      entry_price: entryPx,
      volume: vol,
      stoploss: clamped.args.stoploss && clamped.args.stoploss > 0 ? clamped.args.stoploss : null,
      takeprofit: clamped.args.takeprofit && clamped.args.takeprofit > 0 ? clamped.args.takeprofit : null,
      slippage: clamped.args.slippage ?? 20,
      comment: clamped.args.comment ?? comment,
      expert_id: clamped.args.expertID ?? null,
      broker_ticket: String(ticket),
      status: 'broker_pending',
      expires_at: expiresAt,
      partial_tp_plan: partialTpPlan,
    })
    if (sepErr) {
      console.error(
        `[tradeExecutor] signal_entry_pending_orders INSERT failed signal=${signal.id} broker=${broker.id}: ${sepErr.message}`,
      )
      await ctx.supabase.from('trades').delete().eq('id', tradeId)
      try {
        await api.orderClose(uuid, { ticket })
      } catch { /* best-effort rollback */ }
      return false
    }

    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'signal_entry_pending_placed',
        status: 'success',
        request_payload: {
          ticket,
          operation: pendingOp,
          entry_price: entryPx,
          volume: vol,
          symbol,
        } as unknown as Record<string, unknown>,
        response_payload: { trade_id: tradeId } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(
      `[tradeExecutor] strict entry broker OrderSend failed signal=${signal.id} broker=${broker.id} op=${pendingOp} price=${entryPx}: ${msg}`,
    )
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'signal_entry_pending_failed',
        status: 'failed',
        request_payload: { operation: pendingOp, entry_price: entryPx, symbol } as unknown as Record<string, unknown>,
        error_message: msg,
      })
    } catch { /* best-effort */ }
    return false
  }
}
