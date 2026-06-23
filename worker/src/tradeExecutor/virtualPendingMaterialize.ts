import type { TradeExecutorContext } from './context'
import { roundLot, triggerPriceFor, virtualPendingTriggerAllowed } from './helpers'
import type { PreparedEntry } from './entryPrepare'

/**
 * Persist virtual pending ladder rows to `range_pending_legs` for the worker monitor.
 */
export async function materializeVirtualPendingLegs(
  ctx: TradeExecutorContext,
  prep: PreparedEntry,
  strictBrokerPlaced: boolean,
): Promise<boolean> {
  const {
    signal, broker, uuid, symbol, virtualPendings, deferVirtualAnchor, anchor, anchorSource,
    params, plan, liveEntryFast, strictDeferred,
  } = prep

  const insertRows: Record<string, unknown>[] = []
  if (virtualPendings.length > 0 && !deferVirtualAnchor) {
    if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) {
      console.warn(
        `[tradeExecutor] dropping ${virtualPendings.length} virtual pendings: no anchor available for signal=${signal.id} broker=${broker.id} symbol=${symbol}`,
      )
    } else {
      const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
      const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0)
      const zoneHi = safe > 0 ? anchor + (safe + 2) * (params?.point ?? 0) : null
      const zoneLo = safe > 0 ? anchor - (safe + 2) * (params?.point ?? 0) : null
      const signalRangeBoundary = plan.rangeLayering?.signalRangeBoundary ?? null
      const signalZoneLo = plan.rangeLayering?.signalZoneLo ?? null
      const signalZoneHi = plan.rangeLayering?.signalZoneHi ?? null
      const useSignalEntryRange = plan.rangeLayering?.useSignalEntryRange === true
      const nowMs = Date.now()
      for (const v of virtualPendings) {
        const triggerPrice = triggerPriceFor(v, anchor, digits)
        if (!virtualPendingTriggerAllowed({
          triggerPrice,
          signalRangeBoundary,
          isBuy: v.isBuy,
          stopsZoneLo: zoneLo,
          stopsZoneHi: zoneHi,
          signalZoneLo,
          signalZoneHi,
          useSignalEntryRange,
        })) {
          if (signalRangeBoundary != null && triggerPrice !== anchor) {
            console.warn(
              `[tradeExecutor] dropped virtual pending stepIdx=${v.stepIdx} signal=${signal.id}`
              + ` trigger=${triggerPrice} past signal_range_boundary=${signalRangeBoundary}`,
            )
          } else if (zoneHi != null && zoneLo != null) {
            console.warn(
              `[tradeExecutor] dropped virtual pending stepIdx=${v.stepIdx} signal=${signal.id}`
              + ` trigger=${triggerPrice} inside stops_zone=[${zoneLo}, ${zoneHi}]`,
            )
          }
          continue
        }
        const expiresAt = v.expiryHours && v.expiryHours > 0
          ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
          : null
        insertRows.push({
          signal_id: signal.id,
          user_id: signal.user_id,
          broker_account_id: broker.id,
          metaapi_account_id: uuid,
          symbol,
          step_idx: v.stepIdx,
          is_buy: v.isBuy,
          volume: roundLot(v.volume, params),
          anchor_price: anchor,
          trigger_price: triggerPrice,
          stoploss: v.stoploss,
          takeprofit: v.takeprofit,
          slippage: v.slippage,
          comment: v.comment,
          expert_id: v.expertID ?? null,
          expires_at: expiresAt,
          status: 'pending',
          cwe_close_price: v.cweClosePrice ?? null,
        })
      }
    }
  }

  if (insertRows.length === 0) return false

  const persistLabel = `standard signal=${signal.id} broker=${broker.id}`
  if (liveEntryFast) {
    void ctx.persistRangePendingLegRows(insertRows, persistLabel).then(persist => {
      if (!persist.ok) {
        console.error(
          `[tradeExecutor] range_pending_legs persist failed signal=${signal.id} broker=${broker.id}: ${persist.lastError ?? 'unknown'}`,
        )
      }
    })
    return true
  }

  const persist = await ctx.persistRangePendingLegRows(insertRows, persistLabel)
  if (!persist.ok) {
    console.error(
      `[tradeExecutor] range_pending_legs persist failed signal=${signal.id} broker=${broker.id}: ${persist.lastError ?? 'unknown'}`,
    )
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'virtual_pending_failed',
        status: 'failed',
        request_payload: { rows: insertRows.length, anchor, anchorSource } as unknown as Record<string, unknown>,
        error_message: persist.lastError ?? 'unknown',
      })
    } catch { /* logging is best-effort */ }
    return false
  }

  console.log(
    `[tradeExecutor] virtual pendings inserted=${insertRows.length} signal=${signal.id} broker=${broker.id} symbol=${symbol} anchor=${anchor ?? 'n/a'} (${anchorSource})`,
  )
  try {
    await ctx.supabase.from('trade_execution_logs').insert({
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: broker.id,
      action: 'virtual_pending_inserted',
      status: 'success',
      request_payload: {
        rows: insertRows.length,
        anchor,
        anchorSource,
        symbol,
        stepIdxs: insertRows.map(r => r.step_idx),
        triggers: insertRows.map(r => r.trigger_price),
        range_layering: plan.rangeLayering ?? null,
        strict_deferred: strictDeferred,
        strict_broker_pending: strictBrokerPlaced,
      } as unknown as Record<string, unknown>,
    })
  } catch { /* logging is best-effort */ }
  return true
}
