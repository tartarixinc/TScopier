import { Link, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { subscribeDiscordSourcesChanged } from '../../lib/discordSource'
import { supabase } from '../../lib/supabase'
import { getCachedTgSession, setCachedTgSession } from '../../lib/telegramSessionCache'
import { subscribeTradingViewWebhooksChanged } from '../../lib/tradingViewWebhook'
import { subscribeWhatsAppSourcesChanged } from '../../lib/whatsappSource'

interface TelegramConnectBannerProps {
  className?: string
}

/** Dashboard banner until the user connects any signal source. */
export function TelegramConnectBanner({ className }: TelegramConnectBannerProps) {
  const { user } = useAuth()
  const t = useT()
  const d = t.dashboard
  const location = useLocation()
  const [hasSource, setHasSource] = useState<boolean | null>(() => {
    if (!user?.id) return null
    return getCachedTgSession(user.id) === true ? true : null
  })

  const refreshSources = useCallback(async () => {
    if (!user?.id) {
      setHasSource(null)
      return
    }
    const [telegram, tradingView, otherSources, whatsapp] = await Promise.all([
      supabase.from('telegram_sessions').select('id').eq('user_id', user.id).maybeSingle(),
      supabase.from('tradingview_webhooks').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase
        .from('telegram_channels')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .in('source_kind', ['tradingview', 'discord', 'whatsapp']),
      supabase.from('whatsapp_sessions').select('status').eq('user_id', user.id).maybeSingle(),
    ])
    const hasTelegram = !!telegram.data
    setCachedTgSession(user.id, hasTelegram)
    const linkedWhatsApp = !whatsapp.error && (whatsapp.data as { status?: string } | null)?.status === 'connected'
    setHasSource(
      hasTelegram
      || (!tradingView.error && (tradingView.count ?? 0) > 0)
      || (!otherSources.error && (otherSources.count ?? 0) > 0)
      || linkedWhatsApp,
    )
  }, [user?.id])

  useEffect(() => {
    void refreshSources()
    const stopTradingView = subscribeTradingViewWebhooksChanged(() => {
      void refreshSources()
    })
    const stopDiscord = subscribeDiscordSourcesChanged(() => {
      void refreshSources()
    })
    const stopWhatsApp = subscribeWhatsAppSourcesChanged(() => {
      void refreshSources()
    })
    return () => {
      stopTradingView()
      stopDiscord()
      stopWhatsApp()
    }
  }, [refreshSources, location.pathname])

  if (!user?.id || hasSource !== false) return null

  return (
    <div
      className={clsx(
        'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/30',
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">{d.telegramNotConnectedTitle}</p>
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
