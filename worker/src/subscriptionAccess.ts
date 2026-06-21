import type { SupabaseClient } from '@supabase/supabase-js'
import {
  effectivePlan,
  isSubscriptionActive,
  manualSettingsUseAdvancedFeatures,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from './planLimits'
import { isAdminAccessActive } from './adminAccess'

export interface UserSubscriptionRow {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  extra_accounts: number
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { expiresAt: number; row: UserSubscriptionRow | null }>()
const adminCache = new Map<string, { expiresAt: number; isAdmin: boolean }>()

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

function adminUserIdsFromEnv(): Set<string> {
  const raw = process.env.TSCOPIER_ADMIN_USER_IDS ?? ''
  return new Set(raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean))
}

export async function loadCachedUserIsAdmin(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const hit = adminCache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.isAdmin

  let isAdmin = adminUserIdsFromEnv().has(userId)

  if (!isAdmin) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('is_admin, admin_until')
      .eq('user_id', userId)
      .maybeSingle()
    if (!error && isAdminAccessActive(data)) isAdmin = true
  }

  if (!isAdmin) {
    try {
      const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(userId)
      if (!authErr && authData?.user) {
        const meta = authData.user.app_metadata ?? {}
        if (meta.is_admin === true || meta.role === 'admin') isAdmin = true
      }
    } catch {
      /* best-effort */
    }
  }

  adminCache.set(userId, { isAdmin, expiresAt: Date.now() + CACHE_TTL_MS })
  return isAdmin
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
  isAdmin = false,
): string | null {
  if (isAdmin) return null
  if (!isSubscriptionActive(sub?.status)) return 'subscription_inactive'
  const plan = effectivePlan(sub?.plan, sub?.status)
  if (plan === 'basic' && brokerManualSettingsUseAdvancedFeatures(manualSettings)) {
    return 'plan_advanced_feature_required'
  }
  return null
}

export { isSubscriptionActive, effectivePlan, manualSettingsUseAdvancedFeatures }
