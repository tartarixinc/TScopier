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

/**
 * The `plan_fallback` reason recorded when one or more partial take-profit
 * slices fall below the broker's minimum lot (e.g. a 0.01 lot split 50/30/20).
 */
export function isTpSplitSkippedReason(reason: unknown): boolean {
  return String(reason ?? '') === 'partial_tp_below_min_lot'
}

/**
 * Latest partial-close outcome for THIS position (broker account + ticket) on
 * this entry signal and its child management signals:
 *  - true when the most recent `mgmt_partial_profit` row for that ticket was
 *    skipped because the position was too small to split
 *    (`partial_close_unavailable_for_position_size`);
 *  - false when that ticket's most recent row is not the size refusal — a
 *    later success, failure, or unrelated skip clears the note — or when
 *    nothing was recorded.
 *
 * Scoped per leg on purpose: one management instruction can cover several
 * accounts, and a 0.01-lot leg refused next to a 0.5-lot leg that closed must
 * not paint both trades with the same note. Best-effort like the other notes:
 * any query error → false (the note must never block the modal).
 *
 * Limitation: a channel-wide (non-reply) instruction has no parent signal, so
 * it is never found here — the log and copier surfaces still explain it.
 */
export async function fetchPartialCloseTooSmall(
  supabase: SupabaseClient,
  args: { userId: string; signalId: string; brokerAccountId: string; ticket: number },
): Promise<boolean> {
  const { data: children } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', args.userId)
    .eq('parent_signal_id', args.signalId)
    .limit(50)
  const signalIds = [args.signalId, ...((children ?? []) as Array<{ id: string }>).map(c => c.id)]

  const { data, error } = await supabase
    .from('trade_execution_logs')
    .select('status, request_payload, created_at')
    .in('signal_id', signalIds)
    .eq('user_id', args.userId)
    .eq('broker_account_id', args.brokerAccountId)
    .eq('action', 'mgmt_partial_profit')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error || !data?.length) return false

  for (const row of data as Array<{
    status: string
    request_payload: unknown
    created_at: string
  }>) {
    const payload = row.request_payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const p = payload as Record<string, unknown>
    if (Number(p.ticket) !== Number(args.ticket)) continue
    // Newest row for this ticket decides: a later success clears the note.
    return (
      row.status === 'skipped'
      && String(p.skip_reason ?? '') === 'partial_close_unavailable_for_position_size'
    )
  }
  return false
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
