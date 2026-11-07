import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Fill deviation from the signal's stated entry beyond which we tell the user
 * price had already moved when the order was sent. 15 bps is far above normal
 * slippage (a few bps on FX) while catching stale/late signals quickly.
 */
export const STALE_ENTRY_RATIO = 0.0015

export interface StaleEntryNotice {
  signalEntry: number
  fillPrice: number
  deltaPct: number
}

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Compare the broker fill against the signal's `parsed_data.entry_price`.
 * Returns a notice when the deviation reaches STALE_ENTRY_RATIO or more — the
 * trade opened as a market chase, not at the advertised entry. Null when either
 * side is missing (zone-only entries, mirror copies) or within slippage.
 */
export function staleEntryNotice(
  signalEntry: unknown,
  fillPrice: unknown,
): StaleEntryNotice | null {
  const entry = finitePositive(signalEntry)
  const fill = finitePositive(fillPrice)
  if (entry == null || fill == null) return null
  const deltaPct = Math.abs(fill - entry) / entry
  if (deltaPct < STALE_ENTRY_RATIO) return null
  return { signalEntry: entry, fillPrice: fill, deltaPct }
}

export interface StrippedTpNotice {
  levels: number[]
  fillPrice: number
}

/**
 * Take-profits the worker stripped as wrong-side at send time
 * (`stripInvalidStopsForSide`): the trade has no broker take-profit and at
 * least one signal TP level sits on the wrong side of the fill — a buy's
 * take-profits at or below its fill, a sell's at or above. Applying such a
 * level would close the trade immediately, so the order went out without it
 * (single take-profit per leg, so one wrong-side level leaves the trade with
 * no broker TP even when other levels were still valid — only the wrong-side
 * levels are listed).
 *
 * Scope: signal-carried TPs only (channel active-trade overlays are not in
 * `parsed_data.tp`). Pip-denominated levels (`tpUnit === 'pips'`) and
 * magnitudes that cannot be prices for this fill (pip offsets like 15/30) are
 * never reported — they are not price levels to compare.
 * Null in every other case (trade carries a broker TP, no wrong-side level,
 * missing data, unknown direction).
 */
export function strippedTpNotice(args: {
  tpLevels: unknown
  fillPrice: unknown
  brokerTp: unknown
  direction: unknown
  tpUnit?: unknown
}): StrippedTpNotice | null {
  if (finitePositive(args.brokerTp) != null) return null
  if (String(args.tpUnit ?? '').toLowerCase() === 'pips') return null
  const fill = finitePositive(args.fillPrice)
  if (fill == null) return null
  const dir = String(args.direction ?? '').toLowerCase()
  if (dir !== 'buy' && dir !== 'sell') return null
  const levels = (Array.isArray(args.tpLevels) ? args.tpLevels : [])
    .map(v => Number(v))
    .filter(n => Number.isFinite(n) && n > 0)
  if (!levels.length) return null
  // A price level for this fill must be in the same order of magnitude;
  // anything far off (e.g. pip offsets 15/30 against a fill of 4104) is not a
  // price and must never be printed as one.
  const plausiblePrice = (t: number) => t > fill / 2 && t < fill * 2
  const wrongSide = levels.filter(t =>
    plausiblePrice(t) && (dir === 'buy' ? t <= fill : t >= fill)
  )
  if (!wrongSide.length) return null
  return { levels: wrongSide, fillPrice: fill }
}

/**
 * The `plan_fallback` reason recorded when one or more partial take-profit
 * slices fall below the broker's minimum lot (e.g. a 0.01 lot split 50/30/20).
 */
export function isTpSplitSkippedReason(reason: unknown): boolean {
  return String(reason ?? '') === 'partial_tp_below_min_lot'
}

/**
 * Latest `plan_fallback` reason for a signal on one broker account. Children of
 * the signal are included because a message revision re-enters under its own
 * signal row. Returns null when nothing was recorded (or on any error — the
 * note is best-effort and must never block the modal).
 */
export async function fetchPlanFallbackReason(
  supabase: SupabaseClient,
  args: { userId: string; signalId: string; brokerAccountId: string },
): Promise<string | null> {
  const { data: children } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', args.userId)
    .eq('parent_signal_id', args.signalId)
    .limit(50)
  const signalIds = [args.signalId, ...((children ?? []) as Array<{ id: string }>).map(c => c.id)]

  const { data, error } = await supabase
    .from('trade_execution_logs')
    .select('request_payload, created_at')
    .in('signal_id', signalIds)
    .eq('user_id', args.userId)
    .eq('broker_account_id', args.brokerAccountId)
    .eq('action', 'plan_fallback')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data?.length) return null

  const payload = (data[0] as { request_payload?: unknown }).request_payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const reason = (payload as Record<string, unknown>).reason
  return reason == null ? null : String(reason)
}
