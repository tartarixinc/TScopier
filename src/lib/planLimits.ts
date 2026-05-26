export type SubscriptionPlan = 'basic' | 'advanced'

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'canceled'
  | 'past_due'
  | 'incomplete'

export type PlanFeatureKey =
  | 'range_trading'
  | 'reverse_signal'
  | 'close_worse_entries'
  | 'auto_management'
  | 'rr_modes'
  | 'channel_keyword_filters'
  | 'multi_trade_style'

export const PLAN_LIMITS = {
  basic: {
    maxBrokerAccounts: 1,
    maxTelegramChannels: 5,
    maxBacktestsPerMonth: 5,
    maxTpRows: 3,
    allowRangeTrading: false,
  },
  advanced: {
    maxBrokerAccountsBase: 5,
    maxBrokerAccountsExtra: 95,
    maxTelegramChannels: null as number | null,
    maxBacktestsPerMonth: null as number | null,
    maxTpRows: null as number | null,
    allowRangeTrading: true,
  },
} as const

export function isSubscriptionActive(status: string | null | undefined): boolean {
  return status === 'active' || status === 'trialing'
}

export function maxBrokerAccounts(
  plan: SubscriptionPlan | null | undefined,
  extraAccounts = 0,
): number {
  if (plan === 'advanced') {
    return PLAN_LIMITS.advanced.maxBrokerAccountsBase
      + Math.max(0, Math.min(PLAN_LIMITS.advanced.maxBrokerAccountsExtra, extraAccounts))
  }
  return PLAN_LIMITS.basic.maxBrokerAccounts
}

export function maxTelegramChannels(plan: SubscriptionPlan | null | undefined): number | null {
  if (plan === 'advanced') return null
  return PLAN_LIMITS.basic.maxTelegramChannels
}

export function maxBacktestsPerMonth(plan: SubscriptionPlan | null | undefined): number | null {
  if (plan === 'advanced') return null
  return PLAN_LIMITS.basic.maxBacktestsPerMonth
}

export function maxTpRows(plan: SubscriptionPlan | null | undefined): number | null {
  if (plan === 'advanced') return null
  return PLAN_LIMITS.basic.maxTpRows
}

export function effectivePlan(
  plan: SubscriptionPlan | null | undefined,
  status: string | null | undefined,
): SubscriptionPlan | null {
  if (!isSubscriptionActive(status)) return null
  return plan ?? null
}

export function canUseFeature(
  plan: SubscriptionPlan | null | undefined,
  status: string | null | undefined,
  feature: PlanFeatureKey,
): boolean {
  const effective = effectivePlan(plan, status)
  if (!effective) return false
  if (effective === 'advanced') return true
  switch (feature) {
    case 'range_trading':
    case 'reverse_signal':
    case 'close_worse_entries':
    case 'auto_management':
    case 'rr_modes':
    case 'channel_keyword_filters':
    case 'multi_trade_style':
      return false
    default:
      return false
  }
}

export function normalizeManualSettingsForPlan<T extends Record<string, unknown>>(
  plan: SubscriptionPlan | null | undefined,
  status: string | null | undefined,
  settings: T,
): T {
  const effective = effectivePlan(plan, status)
  if (effective === 'advanced') return settings
  const next = { ...settings } as Record<string, unknown>

  next.trade_style = 'single'
  next.range_trading = false
  next.reverse_signal = false
  next.close_worse_entries = false
  next.move_sl_to_entry_after_mode = 'none'
  next.rr_for_sl_enabled = false
  next.rr_for_tps_enabled = false

  if (Array.isArray(next.tp_lots) && next.tp_lots.length > PLAN_LIMITS.basic.maxTpRows) {
    next.tp_lots = next.tp_lots.slice(0, PLAN_LIMITS.basic.maxTpRows)
  }

  return next as T
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

export interface PlanLimitsSnapshot {
  maxBrokerAccounts: number
  maxTelegramChannels: number | null
  maxBacktestsPerMonth: number | null
  maxTpRows: number | null
}

export function planLimitsSnapshot(
  plan: SubscriptionPlan | null | undefined,
  status: string | null | undefined,
  extraAccounts = 0,
): PlanLimitsSnapshot {
  const effective = effectivePlan(plan, status)
  return {
    maxBrokerAccounts: maxBrokerAccounts(effective ?? undefined, extraAccounts),
    maxTelegramChannels: maxTelegramChannels(effective ?? undefined),
    maxBacktestsPerMonth: maxBacktestsPerMonth(effective ?? undefined),
    maxTpRows: maxTpRows(effective ?? undefined),
  }
}
