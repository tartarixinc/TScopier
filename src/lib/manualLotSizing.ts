import type { ManualSettings } from '../types/database'

/**
 * Mirrors worker `computeLot` dynamic-balance sizing:
 * lot = max(0.01, balance × (percent / 100) / 1000), rounded to 2 decimals.
 */
export function computeDynamicBalanceLot(args: {
  balance: number | null | undefined
  dynamicBalancePercent: number | null | undefined
  fallbackLot?: number
}): number {
  const pct = Number(args.dynamicBalancePercent ?? 1)
  const bal = Number(args.balance ?? 0)
  const fallback = Number(args.fallbackLot ?? 0.01) || 0.01
  if (bal > 0 && pct > 0) {
    return Math.max(0.01, +(bal * (pct / 100) / 1000).toFixed(2))
  }
  return fallback
}

/** Total lot used for multi-trade previews and leg breakdowns. */
export function resolvePreviewManualLot(args: {
  manualSettings: Pick<ManualSettings, 'risk_mode' | 'fixed_lot' | 'dynamic_balance_percent'>
  accountBalance?: number | null
}): number {
  const ms = args.manualSettings
  const fixedFallback = Number(ms.fixed_lot ?? 0.01) || 0.01
  if (ms.risk_mode === 'dynamic_balance_percent') {
    return computeDynamicBalanceLot({
      balance: args.accountBalance,
      dynamicBalancePercent: ms.dynamic_balance_percent,
      fallbackLot: fixedFallback,
    })
  }
  return fixedFallback
}

/** Display lot size with up to 2 decimal places (broker-style). */
export function formatPreviewLotSize(lot: number): string {
  if (!Number.isFinite(lot) || lot <= 0) return '—'
  return lot.toFixed(2)
}
