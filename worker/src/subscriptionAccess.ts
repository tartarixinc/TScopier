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
  trial_ends_at: string | null
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { expiresAt: number; row: UserSubscriptionRow | null }>()
const adminCache = new Map<string, { expiresAt: number; isAdmin: boolean }>()
const extensionCache = new Map<string, { expiresAt: number; endMs: number | null }>()

/** Latest admin-granted extension end in epoch milliseconds, cached for a minute. */
export async function loadCachedSubscriptionExtensionEnd(
  supabase: SupabaseClient,
  userId: string,
): Promise<number | null> {
  const hit = extensionCache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.endMs

  const { data, error } = await supabase
    .from('subscription_extensions')
    .select('days, granted_at')
    .eq('user_id', userId)
    .order('granted_at', { ascending: false })
    .limit(30)

  let endMs: number | null = null
  if (!error && data) {
    for (const row of data) {
      const days = Number((row as { days: unknown }).days)
      const start = Date.parse(String((row as { granted_at: unknown }).granted_at ?? ''))
      if (Number.isFinite(days) && days > 0 && !Number.isNaN(start)) {
        const end = start + days * 86_400_000
        if (endMs == null || end > endMs) endMs = end
      }
    }
  }
  extensionCache.set(userId, { endMs, expiresAt: Date.now() + CACHE_TTL_MS })
  return endMs
}

/** True while an admin-granted extension window is still open. */
export function extensionAccessActive(endMs: number | null, now = Date.now()): boolean {
  return endMs != null && endMs > now
}

export async function loadCachedUserSubscription(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserSubscriptionRow | null> {
  const hit = cache.get(userId)
  if (hit && hit.expiresAt > Date.now()) return hit.row

  const { data } = await supabase
    .from('subscriptions')
    .select('plan,status,extra_accounts,trial_ends_at')
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
  extensionEndMs: number | null = null,
): string | null {
  if (isAdmin) return null
  const active = isSubscriptionActive(sub?.status, sub?.trial_ends_at)
  if (!active && !extensionAccessActive(extensionEndMs)) return 'subscription_inactive'
  // While a trial or an extension keeps access alive, plan limits follow the stored plan.
  const plan = active
    ? effectivePlan(sub?.plan, sub?.status, sub?.trial_ends_at)
    : (sub?.plan ?? 'basic')
  if (plan === 'basic' && brokerManualSettingsUseAdvancedFeatures(manualSettings)) {
    return 'plan_advanced_feature_required'
  }
  return null
}

/** True when the worker may start or renew a Telegram listener for this user. */
export async function userMayRunCopierListener(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  if (await loadCachedUserIsAdmin(supabase, userId)) return true
  const sub = await loadCachedUserSubscription(supabase, userId)
  if (isSubscriptionActive(sub?.status, sub?.trial_ends_at)) return true
  return extensionAccessActive(await loadCachedSubscriptionExtensionEnd(supabase, userId))
}

export { isSubscriptionActive, effectivePlan, manualSettingsUseAdvancedFeatures }
