import type { SupabaseClient } from '@supabase/supabase-js'
import {
  effectivePlan,
  isSubscriptionActive,
  manualSettingsUseAdvancedFeatures,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from './planLimits'

export interface UserSubscriptionRow {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  extra_accounts: number
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { expiresAt: number; row: UserSubscriptionRow | null }>()

export async function loadCachedUserSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserSubscriptionRow | null> {
  const hit = cache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.row

  const { data } = await supabase
    .from('subscriptions')
    .select('plan,status,extra_accounts')
    .eq('user_id', userId)
    .maybeSingle()

  const row = (data as UserSubscriptionRow | null) ?? null
  cache.set(userId, { row, expiresAt: Date.now() + CACHE_TTL_MS })
  return row
}

export function brokerManualSettingsUseAdvancedFeatures(
  manualSettings: Record<string, unknown> | null | undefined,
): boolean {
  if (!manualSettings || typeof manualSettings !== 'object') return false
  return manualSettingsUseAdvancedFeatures(manualSettings)
}

export function subscriptionBlocksSignalExecution(
  sub: UserSubscriptionRow | null,
  manualSettings: Record<string, unknown> | null | undefined,
): string | null {
  if (!isSubscriptionActive(sub?.status)) return 'subscription_inactive'
  const plan = effectivePlan(sub?.plan, sub?.status)
  if (plan === 'basic' && brokerManualSettingsUseAdvancedFeatures(manualSettings)) {
    return 'plan_advanced_feature_required'
  }
  return null
}

export { isSubscriptionActive, effectivePlan, manualSettingsUseAdvancedFeatures }
