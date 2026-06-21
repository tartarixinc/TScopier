import { Link, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { supabase } from '../../lib/supabase'
import { getCachedTgSession, setCachedTgSession } from '../../lib/telegramSessionCache'

interface TelegramConnectBannerProps {
  className?: string
}

/** Dashboard banner when the user has not linked Telegram yet. */
export function TelegramConnectBanner({ className }: TelegramConnectBannerProps) {
  const { user } = useAuth()
  const t = useT()
  const d = t.dashboard
  const location = useLocation()
  const [connected, setConnected] = useState<boolean | null>(() => {
    if (!user?.id) return null
    const cached = getCachedTgSession(user.id)
    return cached
  })

  const refreshTelegramSession = useCallback(async () => {
    if (!user?.id) {
      setConnected(null)
      return
    }
    const { data } = await supabase
      .from('telegram_sessions')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    const hasSession = !!data
    setConnected(hasSession)
    setCachedTgSession(user.id, hasSession)
  }, [user?.id])

  useEffect(() => {
    void refreshTelegramSession()
  }, [refreshTelegramSession, location.pathname])

  if (!user?.id || connected !== false) return null

  return (
    <div
      className={clsx(
        'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/30',
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <img
            src="/Telegram.svg"
            alt=""
            className="mt-0.5 h-5 w-5 shrink-0 object-contain"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">{d.telegramNotConnectedTitle}</p>
            <p className="mt-0.5 text-sm text-amber-800/90 dark:text-amber-200/80">{d.telegramNotConnectedBody}</p>
          </div>
        </div>
        <Link
          to="/channels"
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-amber-50 dark:focus:ring-offset-amber-950"
        >
          {d.connectTelegram}
        </Link>
      </div>
    </div>
  )
}
