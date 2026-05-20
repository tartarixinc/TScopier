/**
 * MT4/MT5 bridge errors that mean stops are already correct — not a real failure.
 * Common when OrderSend included SL/TP and a follow-up OrderModify repeats the same values,
 * or when basket reconcile / parameter-follow-up runs twice on the same ticket.
 */

export function isBenignOrderModifyError(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  return (
    /already\s+have\s+(this\s+)?parameters/i.test(m)
    || /already\s+have\s+these\s+parameters/i.test(m)
    || /no\s+changes?\s+to\s+order/i.test(m)
    || /request\s+has\s+no\s+changes/i.test(m)
    || /same\s+parameters/i.test(m)
  )
}

/** Compare DB-stored stops to planned targets (broker may use different rounding). */
export function stopsAlreadyMatchDb(
  tr: { sl: number | null; tp: number | null },
  target: { stoploss: number; takeprofit: number },
  nImmCwe: number,
  legIdx: number,
  epsilon = 1e-8,
): boolean {
  if (legIdx < nImmCwe) {
    const tpOk = tr.tp == null || Number(tr.tp) === 0
    if (!tpOk) return false
  } else if (target.takeprofit > 0) {
    const curTp = Number(tr.tp)
    if (!Number.isFinite(curTp) || Math.abs(curTp - target.takeprofit) > epsilon) return false
  }
  if (target.stoploss > 0) {
    const curSl = Number(tr.sl)
    if (!Number.isFinite(curSl) || Math.abs(curSl - target.stoploss) > epsilon) return false
  }
  return true
}
