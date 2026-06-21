import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from './AuthContext'
import { useUserProfile } from './UserProfileContext'
import { useT } from './LocaleContext'
import { supabase } from '../lib/supabase'
import { whenRealtimeReady } from '../lib/whenRealtimeReady'
import { playNotificationSound } from '../lib/notificationSound'
import {
  countUnreadNotifications,
  readNotificationsLastReadAt,
  tradeNotificationsFromLogs,
  TRADE_EXECUTION_LOG_NOTIFICATION_SELECT,
  TRADE_NOTIFICATION_LOG_ACTIONS,
  writeNotificationsLastReadAt,
  type TradeExecutionLogRow,
  type TradeNotification,
} from '../lib/tradeNotifications'

const MAX_NOTIFICATIONS = 30
const FETCH_LIMIT = 120
const REALTIME_DEBOUNCE_MS = 300

function buildChannelDisplayNames(
  channels: Array<{ id: string; display_name: string; channel_username?: string | null }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of channels) {
    const name = c.display_name?.trim()
    const username = c.channel_username?.trim().replace(/^@/, '')
    out[c.id] = name || (username ? `@${username}` : 'Unnamed channel')
  }
  return out
}

function buildBrokerLabels(
  brokers: Array<{ id: string; label?: string | null; broker_name?: string | null }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const b of brokers) {
    const label = b.label?.trim()
    const brokerName = b.broker_name?.trim()
    out[b.id] = label || brokerName || ''
  }
  return out
}

interface NotificationsContextValue {
  items: TradeNotification[]
  unreadCount: number
  loading: boolean
  soundEnabled: boolean
  markAllRead: () => void
  refresh: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

export function NotificationsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode
  enabled?: boolean
}) {
  const { user } = useAuth()
  const { profile } = useUserProfile()
  const t = useT()
  const [items, setItems] = useState<TradeNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [lastReadAt, setLastReadAt] = useState<string | null>(null)
  const channelNamesRef = useRef<Record<string, string>>({})
  const brokerLabelsRef = useRef<Record<string, string>>({})
  const rawRowsRef = useRef<TradeExecutionLogRow[]>([])
  const knownLogIdsRef = useRef(new Set<string>())
  const notificationIdsRef = useRef(new Set<string>())
  const soundEnabled = profile.notification_sound_enabled !== false

  useEffect(() => {
    if (!user?.id) {
      setLastReadAt(null)
      return
    }
    setLastReadAt(readNotificationsLastReadAt(user.id))
  }, [user?.id])

  const applyRows = useCallback(
    (rows: TradeExecutionLogRow[]): TradeNotification[] => {
      rawRowsRef.current = rows
      const ctx = {
        channelDisplayNames: channelNamesRef.current,
        brokerLabels: brokerLabelsRef.current,
      }
      return tradeNotificationsFromLogs(rows, t.tradeNotifications, ctx).slice(0, MAX_NOTIFICATIONS)
    },
    [t.tradeNotifications],
  )

  const refresh = useCallback(async () => {
    if (!user?.id) {
      setItems([])
      setLoading(false)
      knownLogIdsRef.current.clear()
      notificationIdsRef.current.clear()
      rawRowsRef.current = []
      return
    }
    setLoading(true)
    try {
      const [channelsRes, brokersRes, logsRes] = await Promise.all([
        supabase
          .from('telegram_channels')
          .select('id, display_name, channel_username')
          .eq('user_id', user.id),
        supabase
          .from('broker_accounts')
          .select('id, label, broker_name')
          .eq('user_id', user.id),
        supabase
          .from('trade_execution_logs')
          .select(TRADE_EXECUTION_LOG_NOTIFICATION_SELECT)
          .eq('user_id', user.id)
          .eq('status', 'success')
          .in('action', [...TRADE_NOTIFICATION_LOG_ACTIONS])
          .order('created_at', { ascending: false })
          .limit(FETCH_LIMIT),
      ])
      if (channelsRes.error) throw new Error(channelsRes.error.message)
      if (brokersRes.error) throw new Error(brokersRes.error.message)
      if (logsRes.error) throw new Error(logsRes.error.message)

      channelNamesRef.current = buildChannelDisplayNames(channelsRes.data ?? [])
      brokerLabelsRef.current = buildBrokerLabels(brokersRes.data ?? [])
      const rows = (logsRes.data ?? []) as TradeExecutionLogRow[]
      knownLogIdsRef.current = new Set(rows.map(r => r.id))
      const next = applyRows(rows)
      notificationIdsRef.current = new Set(next.map(n => n.id))
      setItems(next)
    } catch (e) {
      console.warn('[notifications] load failed', e)
    } finally {
      setLoading(false)
    }
  }, [user?.id, applyRows])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    void refresh()
  }, [enabled, refresh])

  useEffect(() => {
    if (!enabled || !user?.id) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let pendingSound = false

    const flush = async () => {
      debounceTimer = null
      const prevIds = new Set(notificationIdsRef.current)
      await refresh()
      if (pendingSound && soundEnabled) {
        const hasNew = [...notificationIdsRef.current].some(id => !prevIds.has(id))
        if (hasNew) playNotificationSound()
      }
      pendingSound = false
    }

    const schedule = () => {
      pendingSound = true
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        void flush()
      }, REALTIME_DEBOUNCE_MS)
    }

    const filter = `user_id=eq.${user.id}`
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady(user.id).then(() => {
      if (cancelled) return
      channel = supabase
        .channel(`trade_notifications:${user.id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'trade_execution_logs', filter },
          payload => {
            const row = payload.new as TradeExecutionLogRow
            if (knownLogIdsRef.current.has(row.id)) return
            knownLogIdsRef.current.add(row.id)
            rawRowsRef.current = [row, ...rawRowsRef.current]
              .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
              .slice(0, FETCH_LIMIT)
            const interim = applyRows(rawRowsRef.current)
            setItems(interim.slice(0, MAX_NOTIFICATIONS))
            schedule()
          },
        )
        .subscribe()
    })

    return () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [enabled, user?.id, refresh, soundEnabled, applyRows])

  const markAllRead = useCallback(() => {
    if (!user?.id) return
    const now = new Date().toISOString()
    writeNotificationsLastReadAt(user.id, now)
    setLastReadAt(now)
  }, [user?.id])

  const unreadCount = useMemo(
    () => countUnreadNotifications(items, lastReadAt),
    [items, lastReadAt],
  )

  const value = useMemo(
    (): NotificationsContextValue => ({
      items,
      unreadCount,
      loading,
      soundEnabled,
      markAllRead,
      refresh,
    }),
    [items, unreadCount, loading, soundEnabled, markAllRead, refresh],
  )

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  )
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext)
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationsProvider')
  }
  return ctx
}
