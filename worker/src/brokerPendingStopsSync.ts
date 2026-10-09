/**
 * Apply SL/TP onto resting Broker Pending BuyLimit/SellLimit tickets.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { modifyLegSlTpWithFallback } from './orderModifySafe'
import type { RangeBrokerPendingRow } from './rangeBrokerPendingHelpers'
import { writeExecutionLog } from './observability/executionLog'
export type BrokerPendingStopTarget = {
  id: string
  ticket: string
  metaapi_account_id: string
  stoploss: number | null
  takeprofit: number | null
  user_id: string
  signal_id: string
  broker_account_id: string
}

/**
 * OrderModify each ticketed broker_pending row that has a desired SL and/or TP.
 * Returns how many legs were successfully modified (at least one side).
 */
export async function applyStopsToBrokerPendingTickets(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  legs: BrokerPendingStopTarget[]
  logAction?: string
}): Promise<number> {
  const { supabase, api, legs, logAction = 'range_broker_pending_stops_synced' } = args
  let modified = 0

  for (const leg of legs) {
    const ticket = Number(leg.ticket)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    const sl = leg.stoploss != null && Number(leg.stoploss) > 0 ? Number(leg.stoploss) : 0
    const tp = leg.takeprofit != null && Number(leg.takeprofit) > 0 ? Number(leg.takeprofit) : 0
    if (sl <= 0 && tp <= 0) continue

    try {
      const out = await modifyLegSlTpWithFallback(api, leg.metaapi_account_id, ticket, sl, tp)
      if (!out.ok) continue
      modified += 1
      try {
        await writeExecutionLog(supabase, {
          user_id: leg.user_id,
          signal_id: leg.signal_id,
          broker_account_id: leg.broker_account_id,
          action: logAction,
          status: 'success',
          request_payload: {
            leg_id: leg.id,
            ticket,
            stoploss: sl > 0 ? sl : null,
            takeprofit: tp > 0 ? tp : null,
            applied_sl: out.appliedSl,
            applied_tp: out.appliedTp,
          } as unknown as Record<string, unknown>,
        })
      } catch { /* best-effort */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[brokerPendingStops] OrderModify failed leg=${leg.id} ticket=${ticket}: ${msg}`,
      )
    }
  }

  return modified
}

/** Pull ticketed broker_pending rows for one basket and push DB stops to the broker. */
export async function syncBrokerPendingStopsForBasket(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  signalId: string
  brokerAccountId: string
  /** When set, write this SL onto every pending row before OrderModify. */
  stoploss?: number | null
}): Promise<number> {
  const { supabase, api, signalId, brokerAccountId, stoploss } = args
  const { data, error } = await supabase
    .from('range_pending_legs')
    .select('id,ticket,metaapi_account_id,stoploss,takeprofit,user_id,signal_id,broker_account_id')
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('status', 'broker_pending')
    .not('ticket', 'is', null)
    .limit(200)
  if (error || !data?.length) return 0

  const explicitSl = stoploss != null && Number(stoploss) > 0 ? Number(stoploss) : null
  if (explicitSl != null) {
    await supabase
      .from('range_pending_legs')
      .update({ stoploss: explicitSl })
      .eq('signal_id', signalId)
      .eq('broker_account_id', brokerAccountId)
      .eq('status', 'broker_pending')
  }

  const legs: BrokerPendingStopTarget[] = (data as BrokerPendingStopTarget[]).map(row => ({
    ...row,
    stoploss: explicitSl ?? row.stoploss,
  }))

  return applyStopsToBrokerPendingTickets({ supabase, api, legs })
}

/**
 * When pending DB rows still have null stops, copy SL/TP inventory from open basket trades.
 * Assigns TPs by step order across the unique open-trade TP levels (round-robin).
 */
export async function backfillBrokerPendingStopsFromOpenTrades(args: {
  supabase: SupabaseClient
  signalId: string
  brokerAccountId: string
}): Promise<{ stoploss: number | null; finalTps: number[]; updated: number }> {
  const { supabase, signalId, brokerAccountId } = args
  const { data: trades } = await supabase
    .from('trades')
    .select('sl,tp,direction')
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('status', 'open')
    .limit(100)
  const rows = trades ?? []
  const sls = rows
    .map(t => Number((t as { sl?: number | null }).sl))
    .filter(n => Number.isFinite(n) && n > 0)
  const stoploss = sls.length ? sls[0]! : null
  const dir = String((rows[0] as { direction?: string } | undefined)?.direction ?? '').toLowerCase()
  const isBuy = dir.startsWith('buy')
  const finalTps = [...new Set(
    rows
      .map(t => Number((t as { tp?: number | null }).tp))
      .filter(n => Number.isFinite(n) && n > 0),
  )].sort((a, b) => (isBuy ? a - b : b - a))

  if (stoploss == null && !finalTps.length) {
    return { stoploss: null, finalTps: [], updated: 0 }
  }

  const { data: pendingRows, error: pendErr } = await supabase
    .from('range_pending_legs')
    .select('id,step_idx,takeprofit')
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('status', 'broker_pending')
    .order('step_idx', { ascending: true })
    .limit(200)
  if (pendErr || !pendingRows?.length) {
    return { stoploss, finalTps, updated: 0 }
  }

  let updated = 0
  for (let i = 0; i < pendingRows.length; i++) {
    const row = pendingRows[i] as { id: string; takeprofit?: number | null }
    const patch: Record<string, number> = {}
    if (stoploss != null) patch.stoploss = stoploss
    if (finalTps.length) {
      const existingTp = Number(row.takeprofit)
      if (!(existingTp > 0)) {
        patch.takeprofit = finalTps[i % finalTps.length]!
      }
    }
    if (!Object.keys(patch).length) continue
    const { error } = await supabase
      .from('range_pending_legs')
      .update(patch)
      .eq('id', row.id)
    if (!error) updated += 1
  }

  return { stoploss, finalTps, updated }
}

/**
 * Heal naked resting broker limits: backfill DB stops from open basket when
 * needed, then OrderModify any ticketed leg that has SL/TP in DB.
 */
export async function healNakedBrokerPendingStops(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  signalId: string
  brokerAccountId: string
}): Promise<number> {
  const backfilled = await backfillBrokerPendingStopsFromOpenTrades(args)
  return syncBrokerPendingStopsForBasket({
    supabase: args.supabase,
    api: args.api,
    signalId: args.signalId,
    brokerAccountId: args.brokerAccountId,
    stoploss: backfilled.stoploss,
  })
}

export function brokerPendingRowNeedsStopSync(
  row: Pick<RangeBrokerPendingRow, 'ticket' | 'stoploss' | 'takeprofit'>,
): boolean {
  const ticket = Number(row.ticket)
  if (!Number.isFinite(ticket) || ticket <= 0) return false
  const sl = row.stoploss != null && Number(row.stoploss) > 0
  const tp = row.takeprofit != null && Number(row.takeprofit) > 0
  return sl || tp
}
