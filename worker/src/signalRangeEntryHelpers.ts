import type { SupabaseClient } from '@supabase/supabase-js'
import type { ManualSettings, PlannerRangeEntryWait } from './manualPlanning/types'
import type { BrokerRow, ParsedSignal, SignalRow } from './tradeExecutor/types'
import { syncWaitRow } from './signalRangeEntryService'

export const SIGNAL_RANGE_WAKE_DISPATCH_SOURCE = 'signal_range_wake' as const

export type SignalRangeEntryWaitRow = {
  id: string
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  is_buy: boolean
  entry_price: number | null
  zone_lo: number | null
  zone_hi: number | null
  tolerance_pips: number
  status: string
  expires_at: string | null
}

export { waitRowToPlannerWait } from './signalRangeEntryService'

export async function upsertSignalRangeEntryWait(
  supabase: SupabaseClient,
  args: {
    signal: SignalRow
    broker: BrokerRow
    uuid: string
    symbol: string
    wait: PlannerRangeEntryWait
    manual: ManualSettings
    parsed?: ParsedSignal
    preserveExpiresAt?: boolean
  },
): Promise<void> {
  const parsed = args.parsed ?? args.signal.parsed_data
  if (!parsed) return
  await syncWaitRow(supabase, {
    signal: args.signal,
    broker: args.broker,
    uuid: args.uuid,
    symbol: args.symbol,
    parsed,
    manual: args.manual,
    preserveExpiresAt: args.preserveExpiresAt ?? true,
    logUpdates: false,
  })
}

export async function markSignalRangeEntryFired(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<void> {
  await supabase
    .from('signal_range_entry_waits')
    .update({ status: 'fired', updated_at: new Date().toISOString() })
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .in('status', ['waiting', 'fired'])
}

export async function hasActiveSignalRangeEntryWait(
  supabase: SupabaseClient,
  signalId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('signal_range_entry_waits')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', signalId)
    .eq('status', 'waiting')
  if (error) {
    console.warn(
      `[signalRangeEntry] hasActiveWait failed signal=${signalId}: ${error.message}`,
    )
    return false
  }
  return (count ?? 0) > 0
}

export async function cancelSignalRangeEntryWaitsForSignal(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId?: string,
  reason = 'basket_opened',
): Promise<void> {
  let q = supabase
    .from('signal_range_entry_waits')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('signal_id', signalId)
    .eq('status', 'waiting')
  if (brokerAccountId) q = q.eq('broker_account_id', brokerAccountId)
  const { error } = await q
  if (error) {
    console.warn(
      `[signalRangeEntry] cancel waits failed signal=${signalId} reason=${reason}: ${error.message}`,
    )
  }
}

export async function logSignalRangeEntryNoPrice(
  supabase: SupabaseClient,
  signal: SignalRow,
  broker: BrokerRow,
  parsed: ParsedSignal,
  symbol: string,
): Promise<void> {
  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: broker.id,
      action: 'signal_range_entry_no_price',
      status: 'skipped',
      request_payload: {
        direction: String(parsed.action ?? '').toLowerCase(),
        symbol,
      },
    })
  } catch {
    /* best-effort */
  }
}

export async function logSignalRangeEntryWaiting(
  supabase: SupabaseClient,
  signal: SignalRow,
  broker: BrokerRow,
  wait: PlannerRangeEntryWait,
  symbol: string,
  bid: number,
  ask: number,
): Promise<void> {
  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: broker.id,
      action: 'signal_range_entry_waiting',
      status: 'success',
      request_payload: {
        direction: wait.isBuy ? 'buy' : 'sell',
        symbol,
        entry_price: wait.entryPrice,
        zone_lo: wait.zoneLo,
        zone_hi: wait.zoneHi,
        tolerance_pips: wait.tolerancePips,
        bid,
        ask,
      },
    })
  } catch {
    /* best-effort */
  }
}

export async function logSignalRangeEntryFired(
  supabase: SupabaseClient,
  signal: SignalRow,
  brokerAccountId: string,
  wait: PlannerRangeEntryWait,
  symbol: string,
): Promise<void> {
  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: brokerAccountId,
      action: 'signal_range_entry_fired',
      status: 'success',
      request_payload: {
        direction: wait.isBuy ? 'buy' : 'sell',
        symbol,
        entry_price: wait.entryPrice,
        zone_lo: wait.zoneLo,
        zone_hi: wait.zoneHi,
        tolerance_pips: wait.tolerancePips,
      },
    })
  } catch {
    /* best-effort */
  }
}

export async function logSignalRangeEntryWakeRetry(
  supabase: SupabaseClient,
  signal: SignalRow,
  brokerAccountId: string,
  symbol: string,
  bid: number,
  ask: number,
): Promise<void> {
  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: brokerAccountId,
      action: 'signal_range_entry_wake_retry',
      status: 'success',
      request_payload: { symbol, bid, ask },
    })
  } catch {
    /* best-effort */
  }
}
