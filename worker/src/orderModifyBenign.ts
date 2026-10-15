/**
 * MT4/MT5 bridge errors that mean stops are already correct — not a real failure.
 * Common when OrderSend included SL/TP and a follow-up OrderModify repeats the same values,
 * or when basket reconcile / parameter-follow-up runs twice on the same ticket.
 */

/**
 * Broker replies meaning the referenced position no longer exists (TP/SL hit,
 * closed, replaced, or opened on another account). The Aug 10 fix added these to
 * the monitor regexes; this shared predicate covers the management paths too.
 */
export function isPositionGoneError(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  return (
    /unknown\s+ticket/i.test(m)
    || /invalid\s+ticket/i.test(m)
    || /\bticket\b.*\bnot\s+found/i.test(m)
    || /no\s+such\s+order/i.test(m)
    || /already\s+closed/i.test(m)
  )
}

/**
 * Close-only gone-position classifier. MT4 error 4108 (ERR_INVALID_REQUEST) is
 * the retcode FxSocket/MetaApi return when an OrderClose references a ticket
 * that no longer exists (TP/SL hit, or a concurrent duplicate close already
 * removed it). Scoped to close-family actions because on OrderModify the same
 * retcode can mean invalid parameters, not a gone position.
 */
export function isPositionGoneCloseError(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  return (
    isPositionGoneError(m)
    || /\b4108\b/.test(m)
    || /invalid\s+request/i.test(m)
  )
}

export function isBenignOrderModifyError(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  return (
    /already\s+have\s+(this\s+)?parameters/i.test(m)
    || /already\s+have\s+these\s+parameters/i.test(m)
    || /\bno\s+changes?\b/i.test(m)
    || /no\s+changes?\s+to\s+order/i.test(m)
    || /request\s+has\s+no\s+changes/i.test(m)
    || /same\s+parameters/i.test(m)
    || isPositionGoneError(m)
  )
}
/**
 * Compare DB-stored stops to planned targets (broker may use different rounding).
 *
 * `opts.requireTakeProfit` — set when a single take-profit target is configured.
 * A target take-profit of 0 then never counts as "already correct"; without it a
 * leg whose target was never resolved stays silently in sync and is never repaired.
 * Callers that have no notion of a selected target must leave it off, because the
 * zero-target rule is shared with the signal-override and channel-stop paths.
 */
export function stopsAlreadyMatchDb(
  tr: { sl: number | null; tp: number | null },
  target: { stoploss: number; takeprofit: number },
  nImmCwe: number,
  legIdx: number,
  epsilon = 1e-8,
  opts?: { requireTakeProfit?: boolean },
): boolean {
  if (legIdx < nImmCwe) {
    const tpOk = tr.tp == null || Number(tr.tp) === 0
    if (!tpOk) return false
  } else if (target.takeprofit > 0) {
    const curTp = Number(tr.tp)
    if (!Number.isFinite(curTp) || Math.abs(curTp - target.takeprofit) > epsilon) return false
  } else if (opts?.requireTakeProfit === true) {
    const curTp = Number(tr.tp)
    if (!Number.isFinite(curTp) || curTp <= 0) return false
  }
  if (target.stoploss > 0) {
    const curSl = Number(tr.sl)
    if (!Number.isFinite(curSl) || Math.abs(curSl - target.stoploss) > epsilon) return false
  }
  return true
}
