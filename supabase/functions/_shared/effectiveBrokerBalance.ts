/** MT5 balance shown to users: cash balance plus broker credit/bonus. */
export function effectiveBrokerBalance(
  balance: number | null | undefined,
  credit?: number | null | undefined,
): number | null {
  const b = balance != null && Number.isFinite(Number(balance)) ? Number(balance) : null
  const c = credit != null && Number.isFinite(Number(credit)) ? Number(credit) : 0
  if (b == null) {
    if (c > 0) return Math.round(c * 100) / 100
    return null
  }
  return Math.round((b + c) * 100) / 100
}

export function effectiveAccountSummaryBalance(summary: {
  balance?: number | null
  credit?: number | null
  equity?: number | null
} | null | undefined): number | null {
  if (!summary) return null
  const effective = effectiveBrokerBalance(summary.balance, summary.credit)
  if (effective != null) return effective
  const eq = summary.equity
  if (eq != null && Number.isFinite(Number(eq))) return Number(eq)
  return null
}
