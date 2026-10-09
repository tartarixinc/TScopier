import type { SupabaseClient } from '@supabase/supabase-js'
import { shouldLockBasketLayering } from './rangeBasketLayeringLock'
import {
  loadRangeLayerTillCloseForSignal,
  stopRangeLayeringUnlessEnabled,
} from './rangeLayerTillClose'
import { setTpTouchedLock } from './rangePendingFireGuard'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { writeExecutionLog } from './observability/executionLog'
export type RangeLayerBasketTradeRow = {
  signal_id: string
  broker_account_id: string
  user_id: string
  direction: string
  tp: number | null
  status: string
  symbol?: string | null
}

export type WatchRangeLayeringBasketsArgs = {
  signalIds: string[]
  brokerIds: string[]
  symbol: string
  bid: number
  ask: number
  /** When set, write trade_execution_logs with this action on stop. */
  logAction?: string
}

/**
 * Detect TP-touch / partial basket close and stop range layering when layer-till-close is OFF.
 * Shared by virtual and broker-pending range monitors.
 *
 * When layer-till-close is OFF: deletes virtual + broker pending ladder rows (and
 * OrderCloses resting BuyLimit/SellLimit tickets) so they cannot fire after a TP hit.
 */
export async function watchRangeLayeringBasketEvents(
  supabase: SupabaseClient,
  args: WatchRangeLayeringBasketsArgs,
): Promise<Set<string>> {
  const touched = new Set<string>()
  const { signalIds, brokerIds, symbol, bid, ask, logAction = 'range_layering_stopped' } = args
  if (!signalIds.length || !brokerIds.length || !symbol) return touched

  // Do not filter by exact symbol spelling (XAUUSD vs XAUUSDm) — match in memory.
  const { data, error } = await supabase
    .from('trades')
    .select('signal_id,broker_account_id,user_id,direction,tp,status,symbol')
    .in('signal_id', signalIds)
    .in('broker_account_id', brokerIds)
    .in('status', ['open', 'closed'])

  if (error) {
    console.warn(`[rangeLayerBasketWatch] tp-touch scan failed: ${error.message}`)
    return touched
  }

  const byBasket = new Map<string, RangeLayerBasketTradeRow[]>()
  for (const row of (data ?? []) as RangeLayerBasketTradeRow[]) {
    if (row.symbol && !symbolsCompatibleForBasket(symbol, row.symbol)) continue
    const basketKey = `${row.signal_id}|${row.broker_account_id}`
    const arr = byBasket.get(basketKey) ?? []
    arr.push(row)
    byBasket.set(basketKey, arr)
  }

  for (const [basketKey, rows] of byBasket) {
    const openRows = rows.filter(r => r.status === 'open')
    const closedCount = rows.length - openRows.length
    const direction = String((openRows[0] ?? rows[0])?.direction ?? '').toLowerCase()
    const openTps = openRows
      .map(r => Number(r.tp))
      .filter(tp => Number.isFinite(tp) && tp > 0)
    const decision = shouldLockBasketLayering({
      direction,
      openTps,
      openCount: openRows.length,
      closedCount,
      bid,
      ask,
    })
    if (!decision.lock) continue

    const [signalId, brokerAccountId] = basketKey.split('|')
    if (!signalId || !brokerAccountId) continue
    const userId = (openRows[0] ?? rows[0])?.user_id
    if (!userId) continue

    const layerTillClose = await loadRangeLayerTillCloseForSignal(
      supabase,
      signalId,
      brokerAccountId,
    )
    // Layer-till-close ON keeps layering after TP/partial close, but a fully
    // flat basket must still purge remaining ladder rows (no refire).
    if (layerTillClose && decision.reason !== 'basket_fully_closed') {
      await setTpTouchedLock(supabase, {
        signalId,
        brokerAccountId,
        symbol,
        userId,
        lockReason: decision.reason ?? 'tp_touched',
        triggerPrice: decision.triggerPrice ?? null,
        triggerSide: decision.triggerSide ?? null,
      })
      continue
    }

    const { stopped, deleted } = await stopRangeLayeringUnlessEnabled(
      supabase,
      { signalId, brokerAccountId, symbol, userId },
      decision.reason ?? 'tp_touched',
    )
    if (!stopped) continue
    touched.add(basketKey)
    await writeExecutionLog(supabase, {
      user_id: userId,
      signal_id: signalId,
      broker_account_id: brokerAccountId,
      action: logAction,
      status: 'info',
      request_payload: {
        symbol,
        direction,
        trigger_price: decision.triggerPrice,
        trigger_side: decision.triggerSide,
        lock_trigger: decision.reason,
        closed_trades: closedCount,
        open_trades: openRows.length,
        bid,
        ask,
        deleted_rows: deleted,
        lock_reason: 'layering_stopped',
        layer_till_close: layerTillClose,
      } as unknown as Record<string, unknown>,
    })
  }

  return touched
}
