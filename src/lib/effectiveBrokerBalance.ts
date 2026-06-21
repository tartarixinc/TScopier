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

/** Prop-style accounts: small cash balance with large broker credit (equity ≫ balance). */
function looksLikeMissingBrokerCredit(balance: number, equity: number): boolean {
  return equity > balance + 0.005 && balance < equity * 0.2
}

/** Total balance (cash + credit) for broker_accounts rows and live snapshots. */
export function resolveBrokerTotalBalance(
  account: { last_balance?: number | null; last_equity?: number | null },
  opts?: { openPnl?: number | null },
): number | null {
  const balance = readFiniteNum(account.last_balance)
  const equity = readFiniteNum(account.last_equity)
  const openPnl = opts?.openPnl

  if (openPnl != null && Number.isFinite(openPnl)) {
    const fromFloating = effectiveAccountSummaryBalance({
      balance,
      equity,
      profit: openPnl,
    })
    if (fromFloating != null) return fromFloating
  }

  const effective = effectiveAccountSummaryBalance({ balance, equity })
  if (
    balance != null
    && equity != null
    && looksLikeMissingBrokerCredit(balance, equity)
  ) {
    return Math.round(equity * 100) / 100
  }

  return effective ?? balance ?? equity ?? null
}
