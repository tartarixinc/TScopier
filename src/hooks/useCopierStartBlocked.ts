import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { useSubscription } from '../context/SubscriptionContext'
import { isBrokerSessionConnected } from '../lib/brokerReconnect'
import { resolveCopierStartBlocked, type CopierStartBlockedReason } from '../lib/copierStartBlocked'
import { subscribeDiscordSourcesChanged } from '../lib/discordSource'
import { subscribeWhatsAppSourcesChanged } from '../lib/whatsappSource'
import { subscribeTradingViewWebhooksChanged } from '../lib/tradingViewWebhook'
import { getCachedTgSession, setCachedTgSession } from '../lib/telegramSessionCache'
import { supabase } from '../lib/supabase'

export function useCopierStartBlocked() {
  const { user } = useAuth()
  const { hasActiveSubscription, usage, usageLoading, loading: subscriptionLoading } = useSubscription()
  const { brokers, loading: brokersLoading } = useBrokerAccounts()
  const [telegramConnected, setTelegramConnected] = useState<boolean | null>(() => {
    if (!user?.id) return null
    return getCachedTgSession(user.id)
  })
  const [telegramLoading, setTelegramLoading] = useState(() => user?.id ? telegramConnected === null : false)
  const [hasTradingViewWebhook, setHasTradingViewWebhook] = useState<boolean | null>(() => (user?.id ? null : false))
  const [hasDiscordChannel, setHasDiscordChannel] = useState<boolean | null>(() => (user?.id ? null : false))
  const [hasWhatsAppSource, setHasWhatsAppSource] = useState<boolean | null>(() => (user?.id ? null : false))

  const refreshTelegramSession = useCallback(async () => {
    if (!user?.id) {
      setTelegramConnected(null)
      setTelegramLoading(false)
      return
    }
    setTelegramLoading(true)
    const { data } = await supabase
      .from('telegram_sessions')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    const hasSession = !!data
    setTelegramConnected(hasSession)
    setCachedTgSession(user.id, hasSession)
    setTelegramLoading(false)
  }, [user?.id])

  const refreshTradingViewWebhooks = useCallback(async () => {
    if (!user?.id) {
      setHasTradingViewWebhook(false)
      return
    }
    const { count, error } = await supabase
      .from('tradingview_webhooks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    setHasTradingViewWebhook(!error && (count ?? 0) > 0)
  }, [user?.id])

  const refreshDiscordChannels = useCallback(async () => {
    if (!user?.id) {
      setHasDiscordChannel(false)
      return
    }
    const { count, error } = await supabase
      .from('telegram_channels')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('source_kind', 'discord')
    setHasDiscordChannel(!error && (count ?? 0) > 0)
  }, [user?.id])

  const refreshWhatsApp = useCallback(async () => {
    if (!user?.id) {
      setHasWhatsAppSource(false)
      return
    }
    const [groups, session] = await Promise.all([
      supabase.from('whatsapp_groups').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('whatsapp_sessions').select('status').eq('user_id', user.id).maybeSingle(),
    ])
    const linked = !session.error && (session.data as { status?: string } | null)?.status === 'connected'
    setHasWhatsAppSource(!groups.error && linked && (groups.count ?? 0) > 0)
  }, [user?.id])

  useEffect(() => {
    void refreshTelegramSession()
    void refreshTradingViewWebhooks()
    void refreshDiscordChannels()
    void refreshWhatsApp()
    const stopWebhooks = subscribeTradingViewWebhooksChanged(() => {
      void refreshTradingViewWebhooks()
    })
    const stopDiscord = subscribeDiscordSourcesChanged(() => {
      void refreshDiscordChannels()
    })
    const stopWhatsApp = subscribeWhatsAppSourcesChanged(() => {
      void refreshWhatsApp()
    })
    return () => {
      stopWebhooks()
      stopDiscord()
      stopWhatsApp()
    }
  }, [refreshDiscordChannels, refreshTelegramSession, refreshTradingViewWebhooks, refreshWhatsApp])

  const resolving = subscriptionLoading || usageLoading || brokersLoading || telegramLoading || hasTradingViewWebhook === null || hasDiscordChannel === null || hasWhatsAppSource === null

  const hasConnectedBroker = useMemo(
    () => brokers.some(b => b.is_active !== false && isBrokerSessionConnected(b)),
    [brokers],
  )

  const { blocked, reason } = useMemo(
    () => resolveCopierStartBlocked({
      hasActiveSubscription,
      hasConnectedBroker,
      hasTelegramSession: telegramConnected === true,
      hasChannels: usage.telegramChannels > 0,
      hasTradingViewWebhook: hasTradingViewWebhook === true,
      hasDiscordChannel: hasDiscordChannel === true,
      hasWhatsAppSource: hasWhatsAppSource === true,
    }),
    [hasActiveSubscription, hasConnectedBroker, telegramConnected, usage.telegramChannels, hasTradingViewWebhook, hasDiscordChannel, hasWhatsAppSource],
  )

  return {
    copierStartBlocked: blocked,
    copierStartBlockedReason: reason as CopierStartBlockedReason | null,
    resolving,
  }
}
