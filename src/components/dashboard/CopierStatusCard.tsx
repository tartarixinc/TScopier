import clsx from 'clsx'
import { Activity, ChevronDown, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { isBrokerSessionHealthy } from '../../lib/brokerReconnect'
import { hasLinkedBrokerForUi } from '../../lib/brokerLink'
import {
  fetchCopierHealthStatus,
  type CopierHealthSnapshot,
} from '../../lib/copierHealthStatus'
import {
  resolveCopierProcessState,
  resolveCopierSourceLinks,
  resolveCopierStatusHeadline,
  type CopierProcessState,
  type CopierSourceLink,
  type CopierSourceLinks,
} from '../../lib/copierSourceStatus'
import { subscribeDiscordSourcesChanged } from '../../lib/discordSource'
import { SIGNAL_SOURCE_MARKS, type SignalSourceKind } from '../../lib/signalSourceMark'
import { supabase } from '../../lib/supabase'
import { getCachedTgSession, setCachedTgSession } from '../../lib/telegramSessionCache'
import { subscribeTradingViewWebhooksChanged } from '../../lib/tradingViewWebhook'
import { subscribeWhatsAppSourcesChanged } from '../../lib/whatsappSource'
import type { BrokerAccount } from '../../types/database'
import { SignalSourceLogo } from './SignalSourceLogo'

const EXPANDED_STORAGE_KEY = 'tscopier.dashboard.copierStatusExpanded'
const SOURCE_ORDER: SignalSourceKind[] = ['telegram', 'discord', 'whatsapp', 'tradingview']

type Tone = 'ok' | 'warn' | 'bad' | 'muted'

type SourcePresence = {
  loaded: boolean
  discordChannels: number
  whatsappStatus: string | null
  whatsappChannels: number
  tradingViewConnected: boolean
}

const EMPTY_SOURCES: SourcePresence = {
  loaded: false,
  discordChannels: 0,
  whatsappStatus: null,
  whatsappChannels: 0,
  tradingViewConnected: false,
}

function readExpandedPreference(defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* ignore */
  }
  return defaultValue
}

function StatusValue({ children, tone }: { children: string; tone: Tone }) {
  return (
    <span
      className={clsx(
        'font-medium tabular-nums',
        tone === 'ok' && 'text-teal-600 dark:text-teal-400',
        tone === 'warn' && 'text-amber-600 dark:text-amber-400',
        tone === 'bad' && 'text-rose-600 dark:text-rose-400',
        tone === 'muted' && 'text-neutral-500 dark:text-neutral-400',
      )}
    >
      {children}
    </span>
  )
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: Tone
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <span className="text-sm text-neutral-600 dark:text-neutral-400">{label}</span>
      <StatusValue tone={tone}>{value}</StatusValue>
    </div>
  )
}

function sourceTone(link: CopierSourceLink): Tone {
  if (link === 'connected') return 'ok'
  if (link === 'reconnecting') return 'warn'
  if (link === 'reconnect' || link === 'offline') return 'bad'
  return 'muted'
}

function processTone(state: CopierProcessState): Tone {
  if (state === 'operational') return 'ok'
  if (state === 'degraded') return 'warn'
  if (state === 'offline') return 'bad'
  return 'muted'
}

export function CopierStatusCard({
  accounts,
  className,
  /** When true, omit outer card chrome (for embedding in the balance section). */
  embedded = false,
  defaultExpanded = true,
}: {
  accounts: BrokerAccount[]
  className?: string
  embedded?: boolean
  defaultExpanded?: boolean
}) {
  const { user } = useAuth()
  const { hasActiveSubscription } = useSubscription()
  const userId = user?.id ?? null
  const t = useT()
  const cs = t.dashboard.copierStatus
  const ce = t.copierEnginePage

  const [expanded, setExpanded] = useState(() => readExpandedPreference(defaultExpanded))
  const [hasTgSession, setHasTgSession] = useState(() => {
    if (!userId) return false
    return Boolean(getCachedTgSession(userId))
  })
  const [sources, setSources] = useState<SourcePresence>(EMPTY_SOURCES)
  const [copierHealth, setCopierHealth] = useState<CopierHealthSnapshot>({
    telegramAccountStatus: 'unknown',
    signalListenerStatus: 'unknown',
    copierEngineStatus: 'unknown',
    workerOwnershipStatus: 'unknown',
    lastSuccessfulHealthAt: null,
    updatedAt: null,
    reason: null,
  })
  // Number of completed server snapshots. Distinguishes an initial "checking"
  // pass from a persistent "no data" state (reporter never wrote a health row).
  const [healthSnapshots, setHealthSnapshots] = useState(0)

  const toggleExpanded = useCallback(() => {
    setExpanded(prev => {
      const next = !prev
      try {
        localStorage.setItem(EXPANDED_STORAGE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const refreshCopierHealth = useCallback(async () => {
    if (!userId) return
    const snap = await fetchCopierHealthStatus(supabase, userId)
    setCopierHealth(snap)
    setHealthSnapshots(count => count + 1)
  }, [userId])

  const refreshSources = useCallback(async () => {
    if (!userId) {
      setHasTgSession(false)
      setSources({ ...EMPTY_SOURCES, loaded: true })
      return
    }
    const [telegram, discord, whatsappSession, whatsappChannels, tradingViewHooks, tradingViewChannels] = await Promise.all([
      supabase.from('telegram_sessions').select('id').eq('user_id', userId).maybeSingle(),
      supabase.from('telegram_channels').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('source_kind', 'discord'),
      supabase.from('whatsapp_sessions').select('status').eq('user_id', userId).maybeSingle(),
      supabase.from('telegram_channels').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('source_kind', 'whatsapp'),
      supabase.from('tradingview_webhooks').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('telegram_channels').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('source_kind', 'tradingview'),
    ])
    const hasSession = Boolean(telegram.data)
    setHasTgSession(hasSession)
    setCachedTgSession(userId, hasSession)
    const whatsappRow = whatsappSession.data as { status?: string } | null
    setSources({
      loaded: true,
      discordChannels: discord.error ? 0 : (discord.count ?? 0),
      whatsappStatus: whatsappSession.error ? null : (whatsappRow?.status ?? null),
      whatsappChannels: whatsappChannels.error ? 0 : (whatsappChannels.count ?? 0),
      tradingViewConnected:
        (!tradingViewHooks.error && (tradingViewHooks.count ?? 0) > 0)
        || (!tradingViewChannels.error && (tradingViewChannels.count ?? 0) > 0),
    })
  }, [userId])

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
  }, [refreshSources])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const snap = userId
        ? await fetchCopierHealthStatus(supabase, userId)
        : {
            telegramAccountStatus: 'unknown' as const,
            signalListenerStatus: 'unknown' as const,
            copierEngineStatus: 'unknown' as const,
            workerOwnershipStatus: 'unknown' as const,
            lastSuccessfulHealthAt: null,
            updatedAt: null,
            reason: null,
          }
      if (!cancelled) {
        setCopierHealth(snap)
        setHealthSnapshots(count => count + 1)
      }
    })()
    if (!userId) {
      return () => {
        cancelled = true
      }
    }
    const interval = setInterval(() => {
      void refreshCopierHealth()
      void refreshSources()
    }, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [userId, refreshCopierHealth, refreshSources])

  const { brokerConnectionsLabel, brokerConnectionsTone, brokerErrorCount } = useMemo(() => {
    const linked = accounts.filter(hasLinkedBrokerForUi)
    const activeLinked = linked.filter(a => a.is_active !== false)
    const errors = activeLinked.filter(a => !isBrokerSessionHealthy(a)).length

    if (activeLinked.length === 0) {
      return {
        brokerConnectionsLabel: cs.none,
        brokerConnectionsTone: 'muted' as Tone,
        brokerErrorCount: 0,
      }
    }
    if (errors === 0) {
      return {
        brokerConnectionsLabel: cs.healthy,
        brokerConnectionsTone: 'ok' as Tone,
        brokerErrorCount: 0,
      }
    }
    return {
      brokerConnectionsLabel: cs.issues,
      brokerConnectionsTone: 'bad' as Tone,
      brokerErrorCount: errors,
    }
  }, [accounts, cs.healthy, cs.issues, cs.none])

  const healthUnreported =
    hasActiveSubscription &&
    healthSnapshots >= 2 &&
    copierHealth.copierEngineStatus === 'unknown' &&
    hasTgSession

  const links: CopierSourceLinks = resolveCopierSourceLinks({
    loaded: sources.loaded,
    hasTelegramSession: hasTgSession,
    telegramAccountStatus: copierHealth.telegramAccountStatus,
    signalListenerStatus: copierHealth.signalListenerStatus,
    telegramHealthUnreported: healthUnreported,
    discordChannels: sources.discordChannels,
    whatsappStatus: sources.whatsappStatus,
    whatsappChannels: sources.whatsappChannels,
    tradingViewConnected: sources.tradingViewConnected,
  })

  const headline = resolveCopierStatusHeadline({
    hasActiveSubscription,
    brokerIssue: brokerConnectionsTone === 'bad' || brokerErrorCount > 0,
    links,
  })
  const processState = !hasActiveSubscription ? 'stopped' : resolveCopierProcessState(links)

  const sourceLabel = (link: CopierSourceLink): string => {
    if (link === 'connected') return cs.connected
    if (link === 'reconnect') return cs.reconnectRequired
    if (link === 'reconnecting') return cs.reconnecting
    if (link === 'offline') return cs.offline
    if (link === 'unknown') return cs.unknown
    if (link === 'checking') return cs.checking
    return cs.notConnected
  }

  const processLabel = (state: CopierProcessState): string => {
    if (!hasActiveSubscription) return t.pricing.billing.noActiveSubscription
    if (state === 'operational') return cs.operational
    if (state === 'degraded') return cs.degraded
    if (state === 'offline') return cs.offline
    if (state === 'unknown') return cs.unknown
    if (state === 'checking') return cs.checking
    return cs.stopped
  }

  const sourceNotes: string[] = []
  if (links.telegram === 'reconnect') sourceNotes.push(cs.telegramReconnectMessage)
  else if (links.telegram === 'offline') sourceNotes.push(cs.telegramOfflineMessage)
  else if (links.telegram === 'reconnecting') sourceNotes.push(cs.telegramReconnectingMessage)
  if (links.whatsapp === 'offline') sourceNotes.push(cs.whatsappOfflineMessage)

  const statusMessage = !hasActiveSubscription
    ? t.pricing.billing.noActiveSubscription
    : headline === 'checking'
      ? links.telegram === 'reconnecting'
        ? cs.telegramReconnectingMessage
        : cs.checkingMessage
      : headline === 'no_source'
        ? cs.noSourceMessage
        : headline === 'unknown'
          ? cs.unreportedMessage
          : headline === 'ready'
            ? sourceNotes.length
              ? `${cs.readyMessage} ${sourceNotes.join(' ')} ${cs.otherSourcesStillCopying}`
              : cs.readyMessage
            : links.telegram === 'reconnect'
              ? cs.telegramReconnectMessage
              : links.whatsapp === 'offline'
                ? cs.whatsappOfflineMessage
                : links.telegram === 'offline'
                  ? cs.listenerOfflineMessage
                  : links.telegram === 'reconnecting' || links.whatsapp === 'reconnecting'
                    ? cs.telegramReconnectingMessage
                    : brokerConnectionsTone === 'bad'
                      ? cs.checksFailed
                      : cs.stoppedMessage

  const lastHealthy = hasTgSession
    ? (copierHealth.lastSuccessfulHealthAt
      ? new Date(copierHealth.lastSuccessfulHealthAt).toLocaleString()
      : cs.notAvailable)
    : null

  const collapsedSummaryTone: Tone = headline === 'issues'
    ? 'bad'
    : headline === 'ready'
      ? 'ok'
      : 'muted'

  const collapsedSummary = headline === 'subscription'
    ? t.pricing.billing.noActiveSubscription
    : headline === 'issues'
      ? cs.checksFailed
      : headline === 'checking'
        ? cs.checking
        : headline === 'unknown'
          ? cs.unknown
          : headline === 'no_source'
            ? cs.noSignalSource
            : cs.allChecksPassed

  const refreshAll = () => {
    void refreshCopierHealth()
    void refreshSources()
  }

  return (
    <div
      className={clsx(
        !embedded &&
          'overflow-hidden rounded-2xl border border-neutral-200/65 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-neutral-800/55 dark:bg-neutral-950 dark:shadow-none',
        className,
      )}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className={clsx(
          'flex w-full items-center gap-2 px-5 py-4 text-left',
          'transition-colors hover:bg-[#F7F8FA] dark:hover:bg-white/[0.03]',
          expanded && 'border-b border-neutral-100 dark:border-neutral-800',
        )}
      >
        <Activity className="h-4 w-4 shrink-0 text-neutral-400" />
        {!expanded ? (
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-semibold text-neutral-900 dark:text-neutral-50">
              {cs.title}:{' '}
            </span>
            <StatusValue tone={collapsedSummaryTone}>{collapsedSummary}</StatusValue>
          </span>
        ) : (
          <>
            <span className="shrink-0 text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              {cs.title}
            </span>
            <span className="flex-1" />
          </>
        )}
        <ChevronDown
          className={clsx(
            'w-4 h-4 text-neutral-400 shrink-0 transition-transform',
            expanded && 'rotate-180',
          )}
          aria-hidden
        />
        <span className="sr-only">{expanded ? ce.collapse : ce.expand}</span>
      </button>

      {expanded ? (
        <div className="divide-y divide-neutral-100 px-5 py-4 dark:divide-neutral-800/80">
          <div className="pb-3 text-sm text-neutral-700 dark:text-neutral-300">
            <div>{statusMessage}</div>
            {lastHealthy ? (
              <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {cs.lastHealthy}: {lastHealthy}
              </div>
            ) : null}
          </div>
          <div className="py-1">
            <p className="pb-1 text-xs font-medium uppercase tracking-wide text-neutral-400">
              {cs.signalSources}
            </p>
            {SOURCE_ORDER.map(kind => (
              <div key={kind} className="flex items-center justify-between gap-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                  <SignalSourceLogo kind={kind} className="h-4 w-4 shrink-0" />
                  <span className="truncate">{SIGNAL_SOURCE_MARKS[kind].label}</span>
                </span>
                <StatusValue tone={sourceTone(links[kind])}>{sourceLabel(links[kind])}</StatusValue>
              </div>
            ))}
          </div>
          <div className="grid sm:grid-cols-2 sm:gap-x-10 sm:divide-y-0">
            <StatusRow
              label={cs.allBrokerConnections}
              value={brokerConnectionsLabel}
              tone={brokerConnectionsTone}
            />
            <StatusRow label={cs.copierEngine} value={processLabel(processState)} tone={!hasActiveSubscription ? 'muted' : processTone(processState)} />
            <StatusRow
              label={cs.brokerErrors}
              value={String(brokerErrorCount)}
              tone={brokerErrorCount > 0 ? 'bad' : 'ok'}
            />
          </div>
          <button
            type="button"
            onClick={refreshAll}
            className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {cs.refreshStatus}
          </button>
        </div>
      ) : null}
    </div>
  )
}
