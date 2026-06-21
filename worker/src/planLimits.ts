export type SubscriptionPlan = 'basic' | 'advanced'

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'canceled'
  | 'past_due'
  | 'incomplete'

export function isSubscriptionActive(status: string | null | undefined): boolean {
  return status === 'active' || status === 'trialing'
}

export function effectivePlan(
  plan: SubscriptionPlan | null | undefined,
  status: string | null | undefined,
): SubscriptionPlan | null {
  if (!isSubscriptionActive(status)) return null
  return plan ?? null
}

export function manualSettingsUseAdvancedFeatures(settings: Record<string, unknown>): boolean {
  if (settings.trade_style === 'multi') return true
  if (settings.range_trading === true) return true
  if (settings.reverse_signal === true) return true
  if (settings.close_worse_entries === true) return true
  const beMode = String(settings.move_sl_to_entry_after_mode ?? 'none')
  if (beMode !== 'none' && beMode !== '') return true
  if (settings.rr_for_sl_enabled === true || settings.rr_for_tps_enabled === true) return true
  return false
}
