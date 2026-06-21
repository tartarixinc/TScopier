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

function readFiniteNum(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(Number(v))) return null
  return Number(v)
}

/**
 * Cash + broker credit from AccountSummary.
 * MT5: equity = balance + credit + floating P/L — when credit is omitted from the API,
 * derive balance + credit as equity − profit.
 */
export function effectiveAccountSummaryBalance(summary: {
  balance?: number | null
  credit?: number | null
  equity?: number | null
  profit?: number | null
} | null | undefined): number | null {
  if (!summary) return null

  const fromBalanceCredit = effectiveBrokerBalance(summary.balance, summary.credit)
  const equity = readFiniteNum(summary.equity)
  const profit = readFiniteNum(summary.profit)

  if (equity != null) {
    if (profit != null) {
      const balancePlusCredit = Math.round((equity - profit) * 100) / 100
      if (fromBalanceCredit == null) return balancePlusCredit
      if (balancePlusCredit > fromBalanceCredit + 0.001) return balancePlusCredit
      return fromBalanceCredit
    }
  }

  if (fromBalanceCredit != null) return fromBalanceCredit
  if (equity != null) return equity
  return null
}
