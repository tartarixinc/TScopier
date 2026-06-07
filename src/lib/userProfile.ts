import { supabase } from './supabase'
import { isAdminAccessActive } from './adminAccess'

export interface UserProfile {
  user_id: string
  display_name: string
  first_name: string
  last_name: string
  username: string
  country: string
  city: string
  mobile_number: string
  address: string
  base_currency: string
  timezone: string
  is_admin?: boolean
  admin_until?: string | null
  subscription_status?: string | null
  onboarding_completed_at?: string | null
  referred_by_user_id?: string | null
  notification_sound_enabled?: boolean
  created_at?: string
  updated_at?: string
}

export const EMPTY_USER_PROFILE: Omit<UserProfile, 'user_id'> = {
  display_name: '',
  first_name: '',
  last_name: '',
  username: '',
  country: '',
  city: '',
  mobile_number: '',
  address: '',
  base_currency: 'USD',
  timezone: typeof Intl !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    : 'UTC',
  notification_sound_enabled: true,
}

/** Admin bypass: DB flag (with timed expiry) or Supabase Auth app_metadata (matches edge subscriptionAccess). */
export function resolveUserIsAdmin(
  profile: Pick<UserProfile, 'is_admin' | 'admin_until'> | null | undefined,
  appMetadata: Record<string, unknown> | undefined,
): boolean {
  if (isAdminAccessActive(profile)) return true
  const meta = appMetadata ?? {}
  if (meta.is_admin === true || meta.role === 'admin') return true
  return false
}

export async function loadUserProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as UserProfile | null
}

export async function saveUserProfile(
  userId: string,
  patch: Omit<UserProfile, 'user_id' | 'created_at' | 'updated_at'>,
): Promise<void> {
  const {
    is_admin: _isAdmin,
    admin_until: _adminUntil,
    subscription_status: _subscriptionStatus,
    referred_by_user_id: _referredByUserId,
    ...safePatch
  } = patch
  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: userId, ...safePatch }, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
}

export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw new Error(error.message)
}
