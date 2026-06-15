import type { ManualSettings } from './types'

/**
 * Mirrors `computeLot` manual-mode sizing for planner previews and burst-cap seeding.
 */
export function resolveManualLotForSettings(
  settings: Pick<ManualSettings, 'risk_mode' | 'fixed_lot' | 'dynamic_balance_percent'>,
  accountBalance?: number | null,
): number {
  const fixedFallback = Number(settings.fixed_lot ?? 0.01) || 0.01
  if (settings.risk_mode === 'dynamic_balance_percent') {
    const pct = Number(settings.dynamic_balance_percent ?? 1)
    const bal = Number(accountBalance ?? 0)
    if (bal > 0 && pct > 0) {
      return Math.max(0.01, +(bal * (pct / 100) / 1000).toFixed(2))
    }
  }
  return fixedFallback
}
