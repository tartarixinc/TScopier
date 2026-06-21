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
  APP_ANNOUNCEMENT_DISABLED,
  APP_ANNOUNCEMENT_SETTING_KEY,
  fetchAppAnnouncementState,
  type AppAnnouncementState,
} from '../lib/appAnnouncement'
import { useAuth } from './AuthContext'
import { supabase } from '../lib/supabase'
import { whenRealtimeReady } from '../lib/whenRealtimeReady'

const REFRESH_MS = 5 * 60_000

type AppAnnouncementContextValue = AppAnnouncementState & {
  refresh: () => Promise<void>
}

const AppAnnouncementContext = createContext<AppAnnouncementContextValue | null>(null)

/** Shared app-wide announcement bar state. */
export function AppAnnouncementProvider({ children }: { children: ReactNode }) {
  const { loading: authLoading } = useAuth()
  const [announcement, setAnnouncement] = useState<AppAnnouncementState>(APP_ANNOUNCEMENT_DISABLED)

  const refresh = useCallback(async () => {
    setAnnouncement(await fetchAppAnnouncementState())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (authLoading) return

    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady().then(() => {
      if (cancelled) return
      channel = supabase
        .channel('app_settings_announcement')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'app_settings',
            filter: `key=eq.${APP_ANNOUNCEMENT_SETTING_KEY}`,
          },
          () => void refresh(),
        )
        .subscribe()
    })

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [authLoading, refresh])

  const value = useMemo(
    () => ({ ...announcement, refresh }),
    [announcement, refresh],
  )

  return (
    <AppAnnouncementContext.Provider value={value}>
      {children}
    </AppAnnouncementContext.Provider>
  )
}

export function useAppAnnouncement(): AppAnnouncementContextValue {
  const ctx = useContext(AppAnnouncementContext)
  if (!ctx) {
    throw new Error('useAppAnnouncement must be used within AppAnnouncementProvider')
  }
  return ctx
}
