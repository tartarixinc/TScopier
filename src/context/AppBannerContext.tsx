import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  APP_BANNER_DISABLED,
  APP_BANNER_SETTING_KEY,
  fetchAppBannerState,
  type AppBannerState,
} from '../lib/appBanner'
import { supabase } from '../lib/supabase'

const REFRESH_MS = 5 * 60_000

type AppBannerContextValue = AppBannerState & {
  refresh: () => Promise<void>
}

const AppBannerContext = createContext<AppBannerContextValue | null>(null)

/** Shared app-wide banner state (one fetch + realtime subscription for the whole app). */
export function AppBannerProvider({ children }: { children: ReactNode }) {
  const [banner, setBanner] = useState<AppBannerState>(APP_BANNER_DISABLED)

  const refresh = useCallback(async () => {
    setBanner(await fetchAppBannerState())
  }, [])

  useEffect(() => {
    void refresh()

    const channel = supabase
      .channel('app_settings_banner')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'app_settings',
          filter: `key=eq.${APP_BANNER_SETTING_KEY}`,
        },
        () => void refresh(),
      )
      .subscribe()

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)

    return () => {
      window.clearInterval(interval)
      void supabase.removeChannel(channel)
    }
  }, [refresh])

  const value = useMemo(
    () => ({ ...banner, refresh }),
    [banner, refresh],
  )

  return (
    <AppBannerContext.Provider value={value}>
      {children}
    </AppBannerContext.Provider>
  )
}

export function useAppBanner(): AppBannerContextValue {
  const ctx = useContext(AppBannerContext)
  if (!ctx) {
    throw new Error('useAppBanner must be used within AppBannerProvider')
  }
  return ctx
}
