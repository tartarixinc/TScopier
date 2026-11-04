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

/**
 * Equity that moves with floating P/L.
 * `balance` is cash + credit (no floating P/L). Position ticks update open P/L
 * without a fresh equity field, so equity is balance + open P/L.
 */
export function equityWithFloatingPnl(
  balance: number | null | undefined,
  openPnl: number | null | undefined,
  equity?: number | null,
): number | null {
  const cash = readFiniteNum(balance)
  const floating = readFiniteNum(openPnl)
  const marked = readFiniteNum(equity)
  if (cash != null && floating != null && floating !== 0) {
    const fromFloating = Math.round((cash + floating) * 100) / 100
    if (marked == null || Math.abs(fromFloating - marked) > 0.009) return fromFloating
    return marked
  }
  return marked ?? (cash != null && floating != null ? Math.round((cash + floating) * 100) / 100 : cash)
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
