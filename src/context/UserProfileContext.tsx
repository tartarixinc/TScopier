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
import { useLocale } from './LocaleContext'
import { BASE_CURRENCY_CODES } from '../lib/baseCurrencies'
import { formatMoneyAmount, normalizeCurrencyCode, type FormatMoneyOptions } from '../lib/currency'
import {
  EMPTY_USER_PROFILE,
  loadUserProfile,
  saveUserProfile,
  type UserProfile,
} from '../lib/userProfile'

type ProfileFields = Omit<UserProfile, 'user_id' | 'created_at' | 'updated_at'>

interface UserProfileContextValue {
  loading: boolean
  profile: ProfileFields
  baseCurrency: string
  timezone: string
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
  }
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [profile, setProfile] = useState<ProfileFields>(EMPTY_USER_PROFILE)
  const [loading, setLoading] = useState(true)

  const refreshProfile = useCallback(async () => {
    if (!user) {
      setProfile(EMPTY_USER_PROFILE)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const row = await loadUserProfile(user.id)
      if (row) {
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
          }),
        )
      } else {
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
      baseCurrency: profile.base_currency,
      timezone: profile.timezone,
      patchProfile,
      refreshProfile,
      persistProfile,
    }),
    [loading, profile, patchProfile, refreshProfile, persistProfile],
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

export function useFormatMoney() {
  const { baseCurrency } = useUserProfile()
  const { locale } = useLocale()

  return useMemo(() => {
    const intlLocale = locale === 'en' ? undefined : locale
    const withLocale = (options?: FormatMoneyOptions): FormatMoneyOptions => ({
      locale: intlLocale,
      ...options,
    })
    return {
      baseCurrency,
      formatMoney: (value: number | null | undefined, options?: FormatMoneyOptions) =>
        formatMoneyAmount(value, baseCurrency, withLocale(options)),
      formatAxisMoney: (value: number) =>
        formatMoneyAmount(value, baseCurrency, withLocale({ compact: true, nullAsDash: false })),
      formatSignedMoney: (value: number | null | undefined) =>
        formatMoneyAmount(value, baseCurrency, withLocale({ signed: true })),
    }
  }, [baseCurrency, locale])
}
