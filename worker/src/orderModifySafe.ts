/**
 * SL-first OrderModify with a split fallback.
 *
 * MT4/MT5 bridges reject the WHOLE OrderModify if EITHER the SL or TP is invalid
 * (e.g. a fast market has already passed the nearest TP, or the level is inside
 * the broker stops/freeze band). Sending SL+TP together therefore meant an
 * invalid TP left the leg with NEITHER stop — a naked position. This helper tries
 * the combined modify once, and on an "invalid stops" rejection retries SL-only
 * (protect the position first) then TP-only (best-effort).
 */
import { isBenignOrderModifyError } from './orderModifyBenign'

export type OrderModifyResultLike = {
  stopLoss?: number | null
  takeProfit?: number | null
} | unknown

export type SafeModifyApi = {
  orderModify(
    uuid: string,
    args: { ticket: number; stoploss?: number; takeprofit?: number },
  ): Promise<OrderModifyResultLike>
}

export function isInvalidStopsError(message: string | null | undefined): boolean {
  const m = (message ?? '').trim()
  if (!m) return false
  return (
    /invalid\s*stops?/i.test(m)
    || /invalid\s*s\s*\/?\s*l/i.test(m)
    || /invalid\s*t\s*\/?\s*p/i.test(m)
    || /invalid\s*(stop\s*loss|take\s*profit)/i.test(m)
    || /stops?\s+too\s+close/i.test(m)
    || /wrong\s+stops?/i.test(m)
  )
}

export type SafeModifyOutcome = {
  /** True if at least one side was applied (or already correct). */
  ok: boolean
  slApplied: boolean
  tpApplied: boolean
  mode: 'combined' | 'split' | 'none'
  result?: OrderModifyResultLike
  /** Set when the SL could not be applied (the critical failure). */
  error?: string
}

/**
 * Apply SL/TP to one leg, never letting an invalid TP block the protective SL.
 * Pass 0 (or a non-positive value) for a side to skip it.
 */
export async function modifyLegSlTpWithFallback(
  api: SafeModifyApi,
  uuid: string,
  ticket: number,
  stoploss: number,
  takeprofit: number,
): Promise<SafeModifyOutcome> {
  const hasSl = Number.isFinite(stoploss) && stoploss > 0
  const hasTp = Number.isFinite(takeprofit) && takeprofit > 0
  if (!hasSl && !hasTp) {
    return { ok: false, slApplied: false, tpApplied: false, mode: 'none' }
  }

  try {
    const result = await api.orderModify(uuid, {
      ticket,
      ...(hasSl ? { stoploss } : {}),
      ...(hasTp ? { takeprofit } : {}),
    })
    return { ok: true, slApplied: hasSl, tpApplied: hasTp, mode: 'combined', result }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isBenignOrderModifyError(msg)) {
      return { ok: true, slApplied: hasSl, tpApplied: hasTp, mode: 'combined' }
    }
    // Only splitting helps an invalid-stops rejection, and only when both sides
    // were requested. Timeouts / unknown-ticket / disconnects are returned as-is
    // so the caller's existing transient handling and reconcile fallback apply.
    if (!isInvalidStopsError(msg) || !(hasSl && hasTp)) {
      return { ok: false, slApplied: false, tpApplied: false, mode: 'combined', error: msg }
    }

    // SL first — protecting the position is the priority.
    let slApplied = false
    let slErr: string | undefined
    let slResult: OrderModifyResultLike | undefined
    try {
      slResult = await api.orderModify(uuid, { ticket, stoploss })
      slApplied = true
    } catch (e) {
      const m2 = e instanceof Error ? e.message : String(e)
      if (isBenignOrderModifyError(m2)) slApplied = true
      else slErr = m2
    }

    // TP best-effort — its failure must not mark the leg as failed.
    let tpApplied = false
    try {
      await api.orderModify(uuid, { ticket, takeprofit })
      tpApplied = true
    } catch (e) {
      const m3 = e instanceof Error ? e.message : String(e)
      if (isBenignOrderModifyError(m3)) tpApplied = true
      // otherwise ignore: the TP is genuinely unreachable right now
    }

    return {
      ok: slApplied || tpApplied,
      slApplied,
      tpApplied,
      mode: 'split',
      result: slResult,
      error: slApplied ? undefined : (slErr ?? msg),
    }
  }
}
