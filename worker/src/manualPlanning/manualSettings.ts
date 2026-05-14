import type { ManualSettings } from './types'

/** True when `manual_settings.use_signal_entry_price` is enabled (tolerates string/number from JSON). */
export function manualUseSignalEntryPriceOn(manual: ManualSettings): boolean {
  const v = manual.use_signal_entry_price as unknown
  if (v === true || v === 1) return true
  if (v === false || v === 0 || v == null) return false
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes'
  }
  return false
}

/** True when planner/executor should apply strict signal-entry routing (single trade only). */
export function signalEntryPriceStrictEnabled(manual: ManualSettings): boolean {
  return manualUseSignalEntryPriceOn(manual) && manual.trade_style !== 'multi'
}

/**
 * Pending expiry for broker Limit/Stop sends and virtual range legs.
 * Values are clamped to 1–24 hours; non-positive / invalid → 0 (no expiry).
 */
export function clampPendingExpiryHours(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.max(1, Math.min(24, Math.floor(n)))
}
