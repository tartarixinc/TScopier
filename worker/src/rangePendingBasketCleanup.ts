/**
 * Reconcile flat baskets against the broker (SL/TP hit, manual close on MT)
 * and purge virtual range ladder rows so deeper rungs cannot re-fire.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import {
  classifyGhostBasketLegs,
  closeStaleOpenTrades,
  fetchOpenBrokerTicketsStrict,
  type BasketOpenLeg,
} from './basketSlTpReconcile'
import {
  type BasketScope,
  purgeRangePendingLegsIfBasketFlat,
} from './rangePendingLegDelete'

type OpenTradeRow = {
  id: string
  status: string | null
  metaapi_order_id: string | null
}

export type { BasketScope } from './rangePendingLegDelete'
export {
  deleteRangePendingLegsForBasket,
  purgeRangePendingLegsIfBasketFlat,
  purgeRangePendingLegsForBaskets,
} from './rangePendingLegDelete'

/**
 * Close DB "open" legs absent from the broker (SL/TP/manual close), then purge
 * virtual pendings when the basket is flat.
 */
export async function reconcileBasketFlatFromBroker(
  supabase: SupabaseClient,
  api: FxsocketBrokerClient | null,
  metaapiAccountId: string,
  scope: BasketScope,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('trades')
    .select('id,status,metaapi_order_id')
    .eq('signal_id', scope.signalId)
    .eq('broker_account_id', scope.brokerAccountId)
    .in('status', ['open', 'pending'])
    .limit(200)
  if (error) {
    console.warn(`[rangePendingBasketCleanup] load trades failed signal=${scope.signalId}: ${error.message}`)
    return null
  }

  const openRows = (data ?? []) as OpenTradeRow[]
  if (!openRows.length) {
    await purgeRangePendingLegsIfBasketFlat(supabase, scope, 'signal_closed')
    return 'signal_closed'
  }

  if (!api || !metaapiAccountId) return null

  let brokerTickets: Set<number>
  try {
    brokerTickets = await fetchOpenBrokerTicketsStrict(api, metaapiAccountId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[rangePendingBasketCleanup] openedOrders failed account=${metaapiAccountId}: ${msg}`)
    return null
  }

  const family: BasketOpenLeg[] = openRows.map(r => ({
    id: r.id,
    signal_id: scope.signalId,
    metaapi_order_id: r.metaapi_order_id,
    opened_at: '',
    lot_size: 0,
    sl: null,
    tp: null,
    entry_price: null,
    direction: 'buy',
    symbol: '',
  }))
  const { ghost } = classifyGhostBasketLegs(family, brokerTickets)
  if (ghost.length) {
    await closeStaleOpenTrades(
      supabase,
      ghost.map(g => g.id),
    )
  }

  const purged = await purgeRangePendingLegsIfBasketFlat(supabase, scope, 'basket_flat_broker')
  if (purged > 0) return 'basket_flat_broker'

  const stillOpen = openRows.length - ghost.length
  return stillOpen > 0 ? null : 'signal_closed'
}

/** Reconcile every unique basket represented in pending leg rows. */
export async function reconcilePendingLegBasketsFromBroker(
  supabase: SupabaseClient,
  legs: Array<{ signal_id: string; broker_account_id: string; metaapi_account_id: string }>,
  apiForAccount: (metaapiAccountId: string) => FxsocketBrokerClient | null,
): Promise<number> {
  const baskets = new Map<string, BasketScope & { metaapiAccountId: string }>()
  for (const leg of legs) {
    const key = `${leg.signal_id}|${leg.broker_account_id}`
    if (!baskets.has(key)) {
      baskets.set(key, {
        signalId: leg.signal_id,
        brokerAccountId: leg.broker_account_id,
        metaapiAccountId: leg.metaapi_account_id,
      })
    }
  }

  let purged = 0
  for (const basket of baskets.values()) {
    const api = apiForAccount(basket.metaapiAccountId)
    const reason = await reconcileBasketFlatFromBroker(
      supabase,
      api,
      basket.metaapiAccountId,
      { signalId: basket.signalId, brokerAccountId: basket.brokerAccountId },
    )
    if (reason) purged += 1
  }
  return purged
}
