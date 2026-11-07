/** Resolve the account's initial / total deposit from server-written broker fields. */
export function resolveAccountDeposit(account: {
  total_deposits?: number | string | null
  performance_baseline_balance?: number | string | null
} | null | undefined): number | null {
  if (!account) return null
  for (const raw of [account.total_deposits, account.performance_baseline_balance]) {
    if (raw == null || raw === '') continue
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(value)) return Math.round(value * 100) / 100
  }
  return null
}
