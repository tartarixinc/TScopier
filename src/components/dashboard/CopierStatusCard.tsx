import clsx from 'clsx'
import { Activity, ChevronDown, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { isSignalSourceLocked } from '../../lib/featureFlags'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { isBrokerSessionConnected, isBrokerSessionHealthy } from '../../lib/brokerReconnect'
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
import { APP_CARD, APP_SECTION_LABEL, APP_WORKSPACE } from '../../lib/appSurface'
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

function toneText(tone: Tone): string {
  if (tone === 'ok') return 'text-green-600 dark:text-green-400'
  if (tone === 'warn') return 'text-amber-600 dark:text-amber-400'
  if (tone === 'bad') return 'text-rose-600 dark:text-rose-400'
  return 'text-neutral-600 dark:text-neutral-300'
}

function toneDot(tone: Tone): string {
  if (tone === 'ok') return 'bg-green-500'
  if (tone === 'warn') return 'bg-amber-500'
  if (tone === 'bad') return 'bg-rose-500'
  return 'bg-neutral-300 dark:bg-neutral-600'
}

function toneWash(tone: Tone): string {
  if (tone === 'ok') return 'border-green-200/70 bg-green-50/70 dark:border-green-900/50 dark:bg-green-950/30'
  if (tone === 'warn') return 'border-amber-200/70 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/30'
  if (tone === 'bad') return 'border-rose-200/70 bg-rose-50/70 dark:border-rose-900/50 dark:bg-rose-950/30'
  return 'border-neutral-200/70 bg-neutral-50/80 dark:border-neutral-800 dark:bg-white/3'
}

function StatusValue({ children, tone }: { children: string; tone: Tone }) {
  return (
    <span className={clsx('font-medium tabular-nums', toneText(tone))}>
      {children}
    </span>
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

function MetricCell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: Tone
}) {
  return (
    <div className={clsx('rounded-xl border px-3.5 py-3', APP_WORKSPACE, 'border-neutral-200/60 dark:border-neutral-800/60')}>
      <p className={APP_SECTION_LABEL}>{label}</p>
      <p className={clsx('mt-1.5 text-sm font-semibold tracking-tight', toneText(tone))}>{value}</p>
    </div>
  )
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

  const hasConnectedBroker = useMemo(
    () => accounts.some(account => account.is_active !== false && isBrokerSessionConnected(account)),
    [accounts],
  )

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
  const processState = !hasActiveSubscription || !hasConnectedBroker
    ? 'stopped'
    : resolveCopierProcessState(links)

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
        ? ''
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

  const bannerTone: Tone = headline === 'issues'
    ? 'bad'
    : headline === 'ready'
      ? 'ok'
      : headline === 'checking'
        ? 'warn'
        : 'muted'

  return (
    <div
      className={clsx(
        !embedded && ['overflow-hidden', APP_CARD],
        className,
      )}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className={clsx(
          'flex w-full items-center gap-2.5 px-5 py-4 text-left',
          'transition-colors hover:bg-neutral-50 dark:hover:bg-white/3',
          expanded && 'border-b border-neutral-100/90 dark:border-white/8',
        )}
      >
        <span
          className={clsx(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
            expanded ? 'bg-neutral-100 dark:bg-white/6' : toneWash(collapsedSummaryTone),
          )}
        >
          <Activity
            className={clsx(
              'h-4 w-4',
              expanded ? 'text-neutral-700 dark:text-neutral-200' : toneText(collapsedSummaryTone),
            )}
          />
        </span>
        {!expanded ? (
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-semibold text-neutral-900 dark:text-neutral-50">
              {cs.title}
            </span>
            <span className="mx-2 text-neutral-300 dark:text-neutral-700" aria-hidden>·</span>
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
            'h-4 w-4 shrink-0 text-neutral-400 transition-transform dark:text-neutral-500',
            expanded && 'rotate-180',
          )}
          aria-hidden
        />
        <span className="sr-only">{expanded ? ce.collapse : ce.expand}</span>
      </button>

      {expanded ? (
        <div className="space-y-4 px-5 py-4">
          {statusMessage || lastHealthy ? (
            <div className={clsx('rounded-xl border px-3.5 py-3', toneWash(bannerTone))}>
              {statusMessage ? (
                <p className={clsx('text-sm font-medium leading-snug', toneText(bannerTone))}>
                  {statusMessage}
                </p>
              ) : null}
              {lastHealthy ? (
                <p className={clsx(
                  'text-xs text-neutral-500 dark:text-neutral-400',
                  statusMessage && 'mt-1',
                )}
                >
                  {cs.lastHealthy}: {lastHealthy}
                </p>
              ) : null}
            </div>
          ) : null}

          <div>
            <p className={clsx(APP_SECTION_LABEL, 'mb-2.5')}>{cs.signalSources}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {SOURCE_ORDER.map(kind => {
                const link = links[kind]
                const tone = sourceTone(link)
                const showConnect = link === 'not_connected' && !isSignalSourceLocked(kind)
                return (
                  <div
                    key={kind}
                    className="flex items-center gap-3 rounded-xl border border-neutral-200/65 bg-white px-3 py-2.5 dark:border-neutral-800/55 dark:bg-neutral-950"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-50 ring-1 ring-neutral-200/70 dark:bg-white/4 dark:ring-white/8">
                      <SignalSourceLogo kind={kind} className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                        {SIGNAL_SOURCE_MARKS[kind].label}
                      </p>
                      {!showConnect ? (
                        <p className={clsx('mt-0.5 flex items-center gap-1.5 text-xs font-medium', toneText(tone))}>
                          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', toneDot(tone))} aria-hidden />
                          {sourceLabel(link)}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
                          {cs.notConnected}
                        </p>
                      )}
                    </div>
                    {showConnect ? (
                      <Link
                        to={`/channels?source=${kind}`}
                        className="inline-flex shrink-0 items-center rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 transition-colors hover:border-green-400 hover:bg-green-50 hover:text-neutral-950 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:border-green-500/60 dark:hover:bg-green-950/40"
                      >
                        {cs.connectSource}
                      </Link>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <MetricCell
              label={cs.allBrokerConnections}
              value={brokerConnectionsLabel}
              tone={brokerConnectionsTone}
            />
            <MetricCell
              label={cs.copierEngine}
              value={processLabel(processState)}
              tone={!hasActiveSubscription ? 'muted' : processTone(processState)}
            />
            <MetricCell
              label={cs.brokerErrors}
              value={String(brokerErrorCount)}
              tone={brokerErrorCount > 0 ? 'bad' : 'ok'}
            />
          </div>

          <div className="flex justify-end border-t border-neutral-100 pt-3 dark:border-neutral-800/80">
            <button
              type="button"
              onClick={refreshAll}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition-colors hover:text-green-600 dark:text-neutral-400 dark:hover:text-green-400"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              {cs.refreshStatus}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
