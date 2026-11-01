/** Row patch for the broker-reported account leverage (500 = 1:500). Empty when the broker sent none. */
export function accountLeveragePatch(leverage: unknown): { account_leverage?: number } {
  const value = Number(leverage)
  if (!Number.isFinite(value)) return {}
  const rounded = Math.round(value)
  return rounded >= 1 && rounded <= 100_000 ? { account_leverage: rounded } : {}
}
