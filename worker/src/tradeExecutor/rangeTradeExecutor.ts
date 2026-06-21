import type { TradeExecutorContext } from './context'
import type { SendOrderOutcome } from './types'
import type { PreparedEntry } from './entryPrepare'
import { prepareEntryExecution } from './entryPrepare'
import { placeStrictSignalEntryPending } from './strictEntryPending'
import { materializeVirtualPendingLegs } from './virtualPendingMaterialize'
import { finishEntrySend, type EntryArgs } from './entryExecution'
import {
  logSignalRangeEntryFired,
  markSignalRangeEntryFired,
} from '../signalRangeEntryHelpers'

export type { EntryArgs } from './entryPrepare'

/** Log `multi_range_plan` diagnostics for manual multi / range ladder entries. */
async function logMultiRangePlan(
  ctx: TradeExecutorContext,
  prep: PreparedEntry,
): Promise<void> {
  const { signal, broker, manual, parsed, plan, capped, virtualPendings, baseLot, symbol, liveEntryFast } = prep
  if (!prep.isManual || manual.trade_style !== 'multi') return

  const tpOnOrders = capped.map(o => Number(o.takeprofit) || 0).filter(tp => tp > 0)
  const tpDistinct = [...new Set(tpOnOrders)]
  const payload = {
    manual_lot_used: baseLot,
    multi_trade_leg_percent: Number(manual.multi_trade_leg_percent ?? 5),
    immediate_orders: capped.length,
    virtual_pending_rows: virtualPendings.length,
    range_trading: manual.range_trading === true,
    range_percent: manual.range_percent ?? null,
    range_step_pips: manual.range_step_pips ?? null,
    range_distance_pips: manual.range_distance_pips ?? null,
    symbol,
    plan_fallback: plan.fallback_reason ?? null,
    parsed_tp_levels: (parsed.tp ?? []).filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    ),
    immediate_tp_distinct: tpDistinct,
    tp_lots_enabled: (manual.tp_lots ?? []).filter(r => r?.enabled !== false).length,
  } as unknown as Record<string, unknown>

  const row = {
    user_id: signal.user_id,
    signal_id: signal.id,
    broker_account_id: broker.id,
    action: 'multi_range_plan',
    status: 'success',
    request_payload: payload,
  }

  if (liveEntryFast) {
    try {
      void ctx.supabase.from('trade_execution_logs').insert(row)
    } catch { /* best-effort */ }
    return
  }

  try {
    await ctx.supabase.from('trade_execution_logs').insert(row)
  } catch { /* best-effort */ }
}

export async function runRangeEntry(
  ctx: TradeExecutorContext,
  args: EntryArgs,
): Promise<SendOrderOutcome> {
  const prepared = await prepareEntryExecution(ctx, args)
  if (!prepared.ok) return prepared.outcome
  const prep = prepared.prep

  await logMultiRangePlan(ctx, prep)

  const strictBrokerPlaced = await placeStrictSignalEntryPending(ctx, prep, false)
  const materializedVirtuals = await materializeVirtualPendingLegs(ctx, prep, strictBrokerPlaced)

  const outcome = await finishEntrySend(prep, strictBrokerPlaced, materializedVirtuals, true)
  if (outcome.openedOrMerged === true && prep.plan.rangeEntryWait) {
    await markSignalRangeEntryFired(ctx.supabase, prep.signal.id, prep.broker.id)
    await logSignalRangeEntryFired(
      ctx.supabase,
      prep.signal,
      prep.broker.id,
      prep.plan.rangeEntryWait,
      prep.symbol,
    )
  }
  return outcome
}
