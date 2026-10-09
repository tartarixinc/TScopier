/**
 * Last-resort SL/TP assign after a naked broker-pending fill when basket
 * TP% rebalance left the new trade still without stops.
 * Prefer syncRangeBasketTakeProfits(forceLayeringRebalance) as the primary path.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { loadOpenBasketLegs } from './basketSlTpReconcile'
import { resolveEffectiveBasketStops } from './basketEffectiveStops'
import { modifyLegSlTpWithFallback } from './orderModifySafe'
import {
  resolveFiringLegStops,
  resolvePerLegBreakevenSlForNewFill,
  toRangeBasketParsedSlice,
} from './rangeBasketTpSync'
import { shouldStampAutoBeAppliedAt } from './autoManagement'
import type { RangeBrokerPendingRow } from './rangeBrokerPendingHelpers'
import { writeExecutionLog } from './observability/executionLog'
export type AssignNakedBrokerFillStopsArgs = {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  leg: RangeBrokerPendingRow
  tradeRowId: string
  ticket: number
  entryPrice: number
  channelId: string | null
}

export type AssignNakedBrokerFillStopsResult = {
  ok: boolean
  stoploss: number
  takeprofit: number
  error?: string
}

/**
 * Resolve intended stops (leg row + effective basket) and OrderModify the fill.
 * Updates the trades row when at least one side applies.
 */
export async function assignNakedBrokerFillStops(
  args: AssignNakedBrokerFillStopsArgs,
): Promise<AssignNakedBrokerFillStopsResult> {
  const { supabase, api, leg, tradeRowId, ticket, entryPrice, channelId } = args
  if (!(ticket > 0)) {
    return { ok: false, stoploss: 0, takeprofit: 0, error: 'invalid_ticket' }
  }

  let stoploss = 0
  let takeprofit = 0
  let perLegBreakevenSl: number | null = null
  let beOffsetPips: number | undefined
  try {
    const { data: sigMeta } = await supabase
      .from('signals')
      .select('created_at,parsed_data')
      .eq('id', leg.signal_id)
      .maybeSingle()
    const basketCreatedAt = (sigMeta as { created_at?: string } | null)?.created_at ?? null
    const anchorParsed = toRangeBasketParsedSlice(
      (sigMeta as { parsed_data?: { sl?: unknown; tp?: unknown } } | null)?.parsed_data,
    )
    const familyTrades = await loadOpenBasketLegs(
      supabase,
      leg.broker_account_id,
      leg.signal_id,
      leg.symbol,
    )
    const effective = await resolveEffectiveBasketStops({
      supabase,
      userId: leg.user_id,
      channelId,
      anchorSignalId: leg.signal_id,
      symbol: leg.symbol,
      basketCreatedAt,
      anchorParsed,
      familyTrades,
      brokerAccountId: leg.broker_account_id,
    })
    const offsetFromSibling = familyTrades
      .map(t => Number(t.auto_be_offset_pips))
      .find(n => Number.isFinite(n) && n >= 0)
    beOffsetPips = offsetFromSibling
    perLegBreakevenSl = resolvePerLegBreakevenSlForNewFill({
      familyTrades,
      effectiveSource: effective.source,
      isBuy: leg.is_buy,
      fillPrice: entryPrice,
      symbol: leg.symbol,
      manual: offsetFromSibling != null ? { breakeven_offset_pips: offsetFromSibling } : {},
    })
    const firing = resolveFiringLegStops({
      legStoploss: leg.stoploss,
      legTakeprofit: leg.takeprofit,
      cweClosePrice: leg.cwe_close_price,
      effective,
      isBuy: leg.is_buy,
      perLegBreakevenSl,
      effectiveSource: effective.source,
      symbol: leg.symbol,
    })
    stoploss = firing.stoploss
    takeprofit = firing.takeprofit
  } catch (err) {
    // Fall back to stops persisted on the pending row at materialize time.
    const curSl = Number(leg.stoploss)
    const curTp = Number(leg.takeprofit)
    stoploss = Number.isFinite(curSl) && curSl > 0 ? curSl : 0
    takeprofit = leg.cwe_close_price != null
      ? 0
      : (Number.isFinite(curTp) && curTp > 0 ? curTp : 0)
    console.warn(
      `[brokerPendingFillStops] resolve failed leg=${leg.id}; using row stops`
      + ` sl=${stoploss} tp=${takeprofit}:`
      + ` ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!(stoploss > 0) && !(takeprofit > 0)) {
    return { ok: false, stoploss: 0, takeprofit: 0, error: 'no_stops_resolved' }
  }

  const deepestTp = takeprofit > 0 ? takeprofit : undefined
  const outcome = await modifyLegSlTpWithFallback(
    api,
    leg.metaapi_account_id,
    ticket,
    stoploss,
    takeprofit,
    deepestTp != null ? { deepestTp } : undefined,
  )

  if (!outcome.ok) {
    console.warn(
      `[brokerPendingFillStops] OrderModify failed leg=${leg.id} ticket=${ticket}`
      + ` sl=${stoploss} tp=${takeprofit}: ${outcome.error ?? 'unknown'}`,
    )
    return {
      ok: false,
      stoploss,
      takeprofit,
      error: outcome.error ?? 'order_modify_failed',
    }
  }

  const dbPatch: Record<string, number | string | null> = {}
  if (outcome.slApplied && outcome.appliedSl > 0) dbPatch.sl = outcome.appliedSl
  if (outcome.tpApplied && outcome.appliedTp > 0) dbPatch.tp = outcome.appliedTp
  if (
    perLegBreakevenSl != null
    && shouldStampAutoBeAppliedAt({
      appliedSl: outcome.appliedSl > 0 ? outcome.appliedSl : stoploss,
      isBuy: Boolean(leg.is_buy),
      entryPrice,
      symbol: leg.symbol,
      manual: beOffsetPips != null ? { breakeven_offset_pips: beOffsetPips } : {},
    })
  ) {
    dbPatch.auto_be_applied_at = new Date().toISOString()
  }
  if (Object.keys(dbPatch).length > 0) {
    await supabase.from('trades').update(dbPatch).eq('id', tradeRowId)
  }

  console.log(
    `[brokerPendingFillStops] assigned leg=${leg.id} ticket=${ticket}`
    + ` sl=${outcome.appliedSl || 0} tp=${outcome.appliedTp || 0}`
    + ` mode=${outcome.mode} entry=${entryPrice}`,
  )
  await writeExecutionLog(supabase, {
    user_id: leg.user_id,
    signal_id: leg.signal_id,
    broker_account_id: leg.broker_account_id,
    action: 'range_broker_pending_stops_assigned',
    status: 'success',
    request_payload: {
      leg_id: leg.id,
      ticket,
      trade_id: tradeRowId,
      stoploss: outcome.appliedSl || 0,
      takeprofit: outcome.appliedTp || 0,
      mode: outcome.mode,
      naked_fill: true,
    } as unknown as Record<string, unknown>,
  })
  return {
    ok: true,
    stoploss: outcome.appliedSl || stoploss,
    takeprofit: outcome.appliedTp || takeprofit,
  }
}
