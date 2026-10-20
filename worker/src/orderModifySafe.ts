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
import { isBenignOrderModifyError, isPositionGoneError } from './orderModifyBenign'

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
  /** The SL value actually applied (0 if none). */
  appliedSl: number
  /** The TP value actually applied — may differ from the requested TP when the
   *  original was passed by price and the deepest ladder TP was used (0 if none). */
  appliedTp: number
  mode: 'combined' | 'split' | 'none'
  result?: OrderModifyResultLike
  /** Set when the SL could not be applied (the critical failure). */
  error?: string
  /** True when the broker replied the position no longer exists (unknown
   *  ticket etc.). The modify is a no-op, but the caller should close the trade
   *  instead of recording a plain 'already synced' success. */
  positionGone?: boolean
  /** True when the broker reply was a known no-op / already-applied outcome. */
  benign?: boolean
}

export type SafeModifyOpts = {
  /**
   * Deepest ladder TP (farthest target) to fall back to when the requested TP is
   * rejected because price has already passed it. Lets a leg keep a profit target
   * instead of ending up with none.
   */
  deepestTp?: number
  /**
   * Extra TP candidates, in order, tried when the requested TP is rejected.
   * The selected single target belongs here, ahead of the deepest ladder level,
   * so a leg lands on the level the customer chose rather than the furthest one.
   * Deduplicated against the requested TP and `deepestTp`.
   */
  tpFallbacks?: number[]
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
  opts?: SafeModifyOpts,
): Promise<SafeModifyOutcome> {
  const hasSl = Number.isFinite(stoploss) && stoploss > 0
  const hasTp = Number.isFinite(takeprofit) && takeprofit > 0
  if (!hasSl && !hasTp) {
    return { ok: false, slApplied: false, tpApplied: false, appliedSl: 0, appliedTp: 0, mode: 'none' }
  }

  try {
    const result = await api.orderModify(uuid, {
      ticket,
      ...(hasSl ? { stoploss } : {}),
      ...(hasTp ? { takeprofit } : {}),
    })
    return {
      ok: true,
      slApplied: hasSl,
      tpApplied: hasTp,
      appliedSl: hasSl ? stoploss : 0,
      appliedTp: hasTp ? takeprofit : 0,
      mode: 'combined',
      result,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isBenignOrderModifyError(msg)) {
      const positionGone = isPositionGoneError(msg)
      return {
        ok: true,
        slApplied: hasSl,
        tpApplied: hasTp,
        appliedSl: hasSl ? stoploss : 0,
        appliedTp: hasTp ? takeprofit : 0,
        mode: 'combined',
        benign: true,
        // Carry the original broker reply so callers can tell a real no-op from
        // a position that no longer exists (and close the trade).
        ...(positionGone ? { positionGone: true, error: msg } : {}),
      }
    }
    // Only splitting helps an invalid-stops rejection, and only when both sides
    // were requested. Timeouts / unknown-ticket / disconnects are returned as-is
    // so the caller's existing transient handling and reconcile fallback apply.
    if (!isInvalidStopsError(msg) || !(hasSl && hasTp)) {
      return { ok: false, slApplied: false, tpApplied: false, appliedSl: 0, appliedTp: 0, mode: 'combined', error: msg }
    }

    // SL first — protecting the position is the priority.
    let slApplied = false
    let slErr: string | undefined
    let slResult: OrderModifyResultLike | undefined
    let positionGone = false
    let positionGoneMsg: string | undefined
    let benign = false
    try {
      slResult = await api.orderModify(uuid, { ticket, stoploss })
      slApplied = true
    } catch (e) {
      const m2 = e instanceof Error ? e.message : String(e)
      if (isBenignOrderModifyError(m2)) {
        benign = true
        slApplied = true
        if (isPositionGoneError(m2)) {
          positionGone = true
          positionGoneMsg = m2
        }
      } else slErr = m2
    }
    // TP best-effort: try the requested TP, then (if price passed it) the selected
    // target and finally the deepest ladder TP so the leg still carries a profit
    // target rather than none.
    const deepest = opts?.deepestTp
    const tpCandidates: number[] = [takeprofit]
    const pushCandidate = (v?: number | null) => {
      if (v == null || !Number.isFinite(v) || v <= 0) return
      if (tpCandidates.some(c => Math.abs(c - v) < 1e-9)) return
      tpCandidates.push(v)
    }
    for (const c of opts?.tpFallbacks ?? []) pushCandidate(c)
    pushCandidate(deepest)
    let tpApplied = false
    let appliedTp = 0
    for (const candidate of tpCandidates) {
      try {
        await api.orderModify(uuid, { ticket, takeprofit: candidate })
        tpApplied = true
        appliedTp = candidate
        break
      } catch (e) {
        const m3 = e instanceof Error ? e.message : String(e)
        if (isBenignOrderModifyError(m3)) {
          benign = true
          tpApplied = true
          appliedTp = candidate
          if (isPositionGoneError(m3)) {
            positionGone = true
            positionGoneMsg = positionGoneMsg ?? m3
          }
          break
        }
        // otherwise try the next (deeper) candidate
      }
    }

    return {
      ok: slApplied || tpApplied,
      slApplied,
      tpApplied,
      appliedSl: slApplied ? stoploss : 0,
      appliedTp,
      mode: 'split',
      result: slResult,
      error: slApplied ? positionGoneMsg : (slErr ?? msg),
      ...(benign ? { benign: true } : {}),
      ...(positionGone ? { positionGone: true } : {}),
    }
  }
}
