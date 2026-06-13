import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from './AuthContext'
import { BASE_CURRENCY_CODES } from '../lib/baseCurrencies'
import { normalizeCurrencyCode } from '../lib/currency'
import { supabase } from '../lib/supabase'
import { whenRealtimeReady } from '../lib/whenRealtimeReady'
import {
  EMPTY_USER_PROFILE,
  loadUserProfile,
  resolveUserIsAdmin,
  saveUserProfile,
  type UserProfile,
} from '../lib/userProfile'

type ProfileFields = Omit<UserProfile, 'user_id' | 'created_at' | 'updated_at'>

interface UserProfileContextValue {
  loading: boolean
  profile: ProfileFields
  hasProfileRow: boolean
  isAdmin: boolean
  adminUntil: string | null
  subscriptionStatus: string | null
  onboardingCompletedAt: string | null
  baseCurrency: string
  timezone: string
  copierPaused: boolean
  patchProfile: (patch: Partial<ProfileFields>) => void
  refreshProfile: () => Promise<void>
  persistProfile: (patch?: Partial<ProfileFields>) => Promise<void>
}

const UserProfileContext = createContext<UserProfileContextValue | null>(null)

function sanitizeProfile(row: Partial<ProfileFields> | null | undefined): ProfileFields {
  const base = { ...EMPTY_USER_PROFILE, ...row }
  const currency = normalizeCurrencyCode(base.base_currency)
  return {
    ...base,
    base_currency: BASE_CURRENCY_CODES.has(currency) ? currency : 'USD',
    timezone: base.timezone?.trim() || EMPTY_USER_PROFILE.timezone,
    notification_sound_enabled: base.notification_sound_enabled !== false,
    copier_paused: base.copier_paused === true,
  }
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [profile, setProfile] = useState<ProfileFields>(EMPTY_USER_PROFILE)
  const [hasProfileRow, setHasProfileRow] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminUntil, setAdminUntil] = useState<string | null>(null)
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null)
  const [onboardingCompletedAt, setOnboardingCompletedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshProfile = useCallback(async () => {
    if (!user) {
      setProfile(EMPTY_USER_PROFILE)
      setHasProfileRow(false)
      setIsAdmin(false)
      setAdminUntil(null)
      setSubscriptionStatus(null)
      setOnboardingCompletedAt(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const row = await loadUserProfile(user.id)
      setIsAdmin(resolveUserIsAdmin(row, user.app_metadata as Record<string, unknown> | undefined))
      if (row) {
        setHasProfileRow(true)
        setAdminUntil(row.admin_until ?? null)
        setSubscriptionStatus(row.subscription_status ?? null)
        setOnboardingCompletedAt(row.onboarding_completed_at ?? null)
        setProfile(
          sanitizeProfile({
            display_name: row.display_name ?? '',
            first_name: row.first_name ?? '',
            last_name: row.last_name ?? '',
            username: row.username ?? '',
            country: row.country ?? '',
            city: row.city ?? '',
            mobile_number: row.mobile_number ?? '',
            address: row.address ?? '',
            base_currency: row.base_currency,
            timezone: row.timezone,
            notification_sound_enabled: row.notification_sound_enabled ?? true,
            copier_paused: row.copier_paused ?? false,
          }),
        )
      } else {
        setHasProfileRow(false)
        setAdminUntil(null)
        setSubscriptionStatus(null)
        setOnboardingCompletedAt(null)
        const meta = user.user_metadata as Record<string, unknown> | undefined
        const full = String(meta?.full_name ?? meta?.name ?? '').trim()
        const parts = full.split(/\s+/)
        setProfile(
          sanitizeProfile({
            ...EMPTY_USER_PROFILE,
            first_name: String(meta?.first_name ?? parts[0] ?? ''),
            last_name: String(meta?.last_name ?? parts.slice(1).join(' ') ?? ''),
            username: String(user.email?.split('@')[0] ?? ''),
          }),
        )
      }
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void refreshProfile()
  }, [refreshProfile])

  const patchProfile = useCallback((patch: Partial<ProfileFields>) => {
    setProfile(prev => sanitizeProfile({ ...prev, ...patch }))
  }, [])

  useEffect(() => {
    if (!user) return

    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady().then(() => {
      if (cancelled) return
      channel = supabase
        .channel(`user_profile_copier_pause_${user.id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'user_profiles',
            filter: `user_id=eq.${user.id}`,
          },
          payload => {
            const next = payload.new as { copier_paused?: boolean } | undefined
            if (typeof next?.copier_paused === 'boolean') {
              patchProfile({ copier_paused: next.copier_paused })
            }
          },
        )
        .subscribe()
    })

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [user, patchProfile])

  const persistProfile = useCallback(
    async (patch?: Partial<ProfileFields>) => {
      if (!user) return
      const merged = sanitizeProfile({
        ...profile,
        ...patch,
        display_name:
          [patch?.first_name ?? profile.first_name, patch?.last_name ?? profile.last_name]
            .filter(Boolean)
            .join(' ')
            .trim() || patch?.display_name || profile.display_name,
      })
      await saveUserProfile(user.id, merged)
      setProfile(merged)
    },
    [user, profile],
  )

  const value = useMemo(
    (): UserProfileContextValue => ({
      loading,
      profile,
      hasProfileRow,
      isAdmin,
      adminUntil,
      subscriptionStatus,
      onboardingCompletedAt,
      baseCurrency: profile.base_currency,
      timezone: profile.timezone,
      copierPaused: profile.copier_paused === true,
      patchProfile,
      refreshProfile,
      persistProfile,
    }),
    [
      loading,
      profile,
      hasProfileRow,
      isAdmin,
      adminUntil,
      subscriptionStatus,
      onboardingCompletedAt,
      patchProfile,
      refreshProfile,
      persistProfile,
    ],
  )

  return <UserProfileContext.Provider value={value}>{children}</UserProfileContext.Provider>
}

export function useUserProfile(): UserProfileContextValue {
  const ctx = useContext(UserProfileContext)
  if (!ctx) {
    throw new Error('useUserProfile must be used within UserProfileProvider')
  }
  return ctx
}
