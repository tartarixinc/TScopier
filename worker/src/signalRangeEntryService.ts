import type { SupabaseClient } from '@supabase/supabase-js'
import { clampPendingExpiryHours } from './manualPlanner'
import { buildRangeEntryWait, signalRangeEntryQuoteAllowsImmediate } from './manualPlanning/signalEntryRange'
import { resolvedParsedEntryZone } from './manualPlanning/parsedEntry'
import type { ManualSettings, ParsedSignal, PlannerRangeEntryWait } from './manualPlanning/types'
import { signalEntryRangeStrictEnabled } from './manualPlanning/manualSettings'
import type { SignalRangeEntryWaitRow } from './signalRangeEntryHelpers'
import type { BrokerRow, SignalRow } from './tradeExecutor/types'
import { evaluateTpTouch } from './virtualPendingMonitor'
import { SKIP_REASON_SIGNAL_ENTRY_RANGE_EXPIRED } from './manualPlanning/parsedEntry'

export type PreEntryStaleReason =
  | 'expired_ttl'
  | 'tp_before_entry'
  | 'sl_before_entry'

export function buildWaitFromParsed(args: {
  manual: ManualSettings
  parsed: ParsedSignal
  isBuy: boolean
}): PlannerRangeEntryWait | undefined {
  return buildRangeEntryWait(args)
}

export function evaluateWakeEligibility(args: {
  wait: PlannerRangeEntryWait
  bid: number
  ask: number
  pipSize?: number
}): boolean {
  return signalRangeEntryQuoteAllowsImmediate(args)
}

function readSl(parsed: ParsedSignal): number | null {
  const sl = parsed.sl
  if (sl == null) return null
  const n = typeof sl === 'number' ? sl : Number(sl)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** True when price has invalidated the setup before any entry fill. */
export function evaluatePreEntryStaleness(args: {
  parsed: ParsedSignal
  bid: number
  ask: number
  isBuy: boolean
}): { stale: boolean; reason?: PreEntryStaleReason } {
  const { parsed, bid, ask, isBuy } = args
  const sl = readSl(parsed)
  if (sl != null) {
    if (isBuy && ask <= sl) return { stale: true, reason: 'sl_before_entry' }
    if (!isBuy && bid >= sl) return { stale: true, reason: 'sl_before_entry' }
  }
  const tps = (parsed.tp ?? []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  )
  if (tps.length > 0) {
    const direction = isBuy ? 'buy' : 'sell'
    const tpTouch = evaluateTpTouch({ direction, tps, bid, ask })
    if (tpTouch.touched) return { stale: true, reason: 'tp_before_entry' }
  }
  return { stale: false }
}

function staleActivityAction(reason: PreEntryStaleReason | 'expired_ttl'): string {
  if (reason === 'tp_before_entry') return 'signal_range_entry_tp_before_entry'
  if (reason === 'sl_before_entry') return 'signal_range_entry_sl_before_entry'
  return 'signal_range_entry_expired'
}

export async function logSignalRangeEntryActivity(
  supabase: SupabaseClient,
  args: {
    userId: string
    signalId: string
    brokerAccountId: string
    action: string
    status?: string
    payload?: Record<string, unknown>
  },
): Promise<void> {
  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: args.userId,
      signal_id: args.signalId,
      broker_account_id: args.brokerAccountId,
      action: args.action,
      status: args.status ?? 'success',
      request_payload: args.payload ?? {},
    })
  } catch {
    /* best-effort */
  }
}

export async function expireWait(
  supabase: SupabaseClient,
  args: {
    waitId: string
    signalId: string
    userId: string
    brokerAccountId: string
    reason: PreEntryStaleReason | 'expired_ttl'
    symbol?: string
    bid?: number
    ask?: number
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('signal_range_entry_waits')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', args.waitId)
    .eq('status', 'waiting')
    .select('id')
    .maybeSingle()
  if (error || !data) return false
  await logSignalRangeEntryActivity(supabase, {
    userId: args.userId,
    signalId: args.signalId,
    brokerAccountId: args.brokerAccountId,
    action: staleActivityAction(args.reason),
    status: 'skipped',
    payload: {
      reason: args.reason,
      symbol: args.symbol ?? null,
      bid: args.bid ?? null,
      ask: args.ask ?? null,
    },
  })
  await finalizeSignalIfAllWaitsTerminal(supabase, args.signalId)
  return true
}

export async function cancelWaitWithLog(
  supabase: SupabaseClient,
  args: {
    waitId: string
    signalId: string
    userId: string
    brokerAccountId: string
    reason: string
    payload?: Record<string, unknown>
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('signal_range_entry_waits')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', args.waitId)
    .eq('status', 'waiting')
    .select('id')
    .maybeSingle()
  if (error || !data) return false
  await logSignalRangeEntryActivity(supabase, {
    userId: args.userId,
    signalId: args.signalId,
    brokerAccountId: args.brokerAccountId,
    action: 'signal_range_entry_cancelled',
    status: 'skipped',
    payload: { reason: args.reason, ...args.payload },
  })
  return true
}

export type WaitSyncResult =
  | { ok: true; updated: boolean }
  | { ok: false; cancelled: true; reason: string }

export async function syncWaitRow(
  supabase: SupabaseClient,
  args: {
    signal: SignalRow
    broker: BrokerRow
    uuid: string
    symbol: string
    parsed: ParsedSignal
    manual: ManualSettings
    preserveExpiresAt?: boolean
    logUpdates?: boolean
  },
): Promise<WaitSyncResult> {
  if (!signalEntryRangeStrictEnabled(args.manual)) {
    return { ok: false, cancelled: true, reason: 'toggle_off' }
  }
  const isBuy = String(args.parsed.action ?? '').toLowerCase() !== 'sell'
  const wait = buildWaitFromParsed({ manual: args.manual, parsed: args.parsed, isBuy })
  if (!wait) {
    return { ok: false, cancelled: true, reason: 'no_entry_anchor' }
  }
  const zone = resolvedParsedEntryZone(args.parsed)
  const waitToStore = zone
    ? { ...wait, zoneLo: zone.lo, zoneHi: zone.hi }
    : wait

  const { data: existing } = await supabase
    .from('signal_range_entry_waits')
    .select('id, status, is_buy, zone_lo, zone_hi, expires_at, tolerance_pips')
    .eq('signal_id', args.signal.id)
    .eq('broker_account_id', args.broker.id)
    .maybeSingle()

  if (existing?.status === 'waiting' && existing.is_buy !== isBuy) {
    await cancelWaitWithLog(supabase, {
      waitId: existing.id,
      signalId: args.signal.id,
      userId: args.signal.user_id,
      brokerAccountId: args.broker.id,
      reason: 'direction_flip',
    })
    return { ok: false, cancelled: true, reason: 'direction_flip' }
  }

  const hours = clampPendingExpiryHours(args.manual.pending_expiry_hours)
  const freshExpiresAt = hours > 0
    ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    : null
  const expiresAt = args.preserveExpiresAt !== false && existing?.status === 'waiting' && existing.expires_at
    ? existing.expires_at
    : freshExpiresAt

  const row = {
    signal_id: args.signal.id,
    user_id: args.signal.user_id,
    broker_account_id: args.broker.id,
    metaapi_account_id: args.uuid,
    symbol: args.symbol,
    is_buy: waitToStore.isBuy,
    entry_price: waitToStore.entryPrice,
    zone_lo: waitToStore.zoneLo,
    zone_hi: waitToStore.zoneHi,
    tolerance_pips: waitToStore.tolerancePips,
    status: 'waiting',
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase
    .from('signal_range_entry_waits')
    .upsert(row, { onConflict: 'signal_id,broker_account_id' })
  if (error) {
    console.warn(
      `[signalRangeEntry] sync wait failed signal=${args.signal.id} broker=${args.broker.id}: ${error.message}`,
    )
    return { ok: true, updated: false }
  }

  const zoneChanged = existing != null && (
    existing.zone_lo !== waitToStore.zoneLo
    || existing.zone_hi !== waitToStore.zoneHi
    || existing.tolerance_pips !== waitToStore.tolerancePips
  )
  if (args.logUpdates && zoneChanged) {
    await logSignalRangeEntryActivity(supabase, {
      userId: args.signal.user_id,
      signalId: args.signal.id,
      brokerAccountId: args.broker.id,
      action: 'signal_range_entry_updated',
      payload: {
        symbol: args.symbol,
        zone_lo: waitToStore.zoneLo,
        zone_hi: waitToStore.zoneHi,
        prior_zone_lo: existing?.zone_lo ?? null,
        prior_zone_hi: existing?.zone_hi ?? null,
        tolerance_pips: waitToStore.tolerancePips,
      },
    })
  }
  return { ok: true, updated: zoneChanged || !existing }
}

export async function countWaitsByStatus(
  supabase: SupabaseClient,
  signalId: string,
): Promise<{ waiting: number; terminal: number; expired: number }> {
  const { data, error } = await supabase
    .from('signal_range_entry_waits')
    .select('status')
    .eq('signal_id', signalId)
  if (error || !data) return { waiting: 0, terminal: 0, expired: 0 }
  let waiting = 0
  let terminal = 0
  let expired = 0
  for (const row of data) {
    const s = String(row.status ?? '')
    if (s === 'waiting') waiting += 1
    else {
      terminal += 1
      if (s === 'expired') expired += 1
    }
  }
  return { waiting, terminal, expired }
}

/** Skip or leave parsed when all range waits are terminal and none opened. */
export async function finalizeSignalIfAllWaitsTerminal(
  supabase: SupabaseClient,
  signalId: string,
): Promise<void> {
  const { waiting, expired } = await countWaitsByStatus(supabase, signalId)
  if (waiting > 0) return

  const { count: openTrades } = await supabase
    .from('trades')
    .select('id', { count: 'exact', head: true })
    .eq('signal_id', signalId)
    .in('status', ['open', 'pending'])
  if ((openTrades ?? 0) > 0) return

  const { data: signalRow } = await supabase
    .from('signals')
    .select('status')
    .eq('id', signalId)
    .maybeSingle()
  if (signalRow?.status !== 'parsed') return

  if (expired > 0) {
    await supabase
      .from('signals')
      .update({ status: 'skipped', skip_reason: SKIP_REASON_SIGNAL_ENTRY_RANGE_EXPIRED })
      .eq('id', signalId)
      .eq('status', 'parsed')
  }
}

export function waitRowToPlannerWait(row: SignalRangeEntryWaitRow): PlannerRangeEntryWait {
  return {
    isBuy: row.is_buy,
    entryPrice: row.entry_price,
    zoneLo: row.zone_lo,
    zoneHi: row.zone_hi,
    tolerancePips: row.tolerance_pips,
  }
}
