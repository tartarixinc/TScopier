import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import {
  fetchListenerLeaseStatus,
  type ListenerLeaseSnapshot,
} from '../../lib/listenerLeaseStatus'
import { supabase } from '../../lib/supabase'
import { getCachedTgSession, setCachedTgSession } from '../../lib/telegramSessionCache'
import { whenRealtimeReady } from '../../lib/whenRealtimeReady'
import { Button } from '../ui/Button'

interface ListenerLeaseOfflineBannerProps {
  className?: string
  /** When set (e.g. Channels page), use instead of navigating to /channels. */
  onReconnect?: () => void
  /** Extra refresh work after lease re-fetch (e.g. reload channels). */
  onRefresh?: () => void | Promise<void>
}

/**
 * Warning when Telegram is linked but the worker listener lease is expired/missing
 * (“Copier engine offline”). Same banner as Channels / Copier Engine.
 */
export function ListenerLeaseOfflineBanner({
  className,
  onReconnect,
  onRefresh,
}: ListenerLeaseOfflineBannerProps) {
  const { user } = useAuth()
  const { hasActiveSubscription } = useSubscription()
  const t = useT()
  const ce = t.copierEnginePage
  const [hasTgSession, setHasTgSession] = useState(() => {
    if (!user?.id) return false
    return Boolean(getCachedTgSession(user.id))
  })
  const [listenerLease, setListenerLease] = useState<ListenerLeaseSnapshot>({
    status: 'unknown',
    expiresAt: null,
  })
  const [refreshing, setRefreshing] = useState(false)

  const refreshListenerLease = useCallback(async () => {
    if (!user?.id) return
    const snap = await fetchListenerLeaseStatus(supabase, user.id)
    setListenerLease(snap)
  }, [user?.id])

  const refreshTelegramSession = useCallback(async () => {
    if (!user?.id) {
      setHasTgSession(false)
      return
    }
    const { data } = await supabase
      .from('telegram_sessions')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    const hasSession = Boolean(data)
    setHasTgSession(hasSession)
    setCachedTgSession(user.id, hasSession)
  }, [user?.id])

  useEffect(() => {
    void refreshTelegramSession()
  }, [refreshTelegramSession])

  useEffect(() => {
    if (!user?.id || !hasTgSession) {
      setListenerLease({ status: 'unknown', expiresAt: null })
      return
    }
    void refreshListenerLease()
    const interval = setInterval(() => void refreshListenerLease(), 30_000)
    return () => clearInterval(interval)
  }, [user?.id, hasTgSession, refreshListenerLease])

  useEffect(() => {
    if (!user?.id || !hasTgSession) return

    let cancelled = false
    let rt: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady(user.id).then(() => {
      if (cancelled) return
      rt = supabase
        .channel(`worker_session_leases_dashboard:${user.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'worker_session_leases',
            filter: `user_id=eq.${user.id}`,
          },
          () => void refreshListenerLease(),
        )
        .subscribe()
    })

    return () => {
      cancelled = true
      if (rt) void supabase.removeChannel(rt)
    }
  }, [user?.id, hasTgSession, refreshListenerLease])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refreshTelegramSession()
      await refreshListenerLease()
      await onRefresh?.()
    } finally {
      setRefreshing(false)
    }
  }

  const show =
    Boolean(user?.id)
    && hasTgSession
    && hasActiveSubscription
    && (listenerLease.status === 'expired' || listenerLease.status === 'missing')

  if (!show) return null

  return (
    <div
      className={clsx(
        'px-4 py-3 bg-warning-50 dark:bg-amber-950/40 border border-warning-200 dark:border-amber-800 rounded-xl text-sm text-warning-800 dark:text-amber-100 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">{ce.listenerLeaseExpired}</p>
          <p className="text-xs mt-0.5 opacity-90">{ce.listenerLeaseExpiredHint}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:shrink-0">
        <Button size="sm" variant="secondary" onClick={() => void handleRefresh()} loading={refreshing}>
          <RefreshCw className="w-3.5 h-3.5" />
          {t.common.refresh}
        </Button>
        {onReconnect ? (
          <Button size="sm" onClick={onReconnect}>
            {ce.reconnectTelegram}
          </Button>
        ) : (
          <Link
            to="/channels"
            className="inline-flex items-center justify-center rounded-lg bg-green-400 px-3 py-1.5 text-sm font-medium text-neutral-950 shadow-xs transition-all hover:bg-green-500 focus:outline-hidden focus:ring-2 focus:ring-green-400 focus:ring-offset-2"
          >
            {ce.reconnectTelegram}
          </Link>
        )}
      </div>
    </div>
  )
}
