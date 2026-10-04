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
  type CopierEngineStatus,
  type SignalListenerStatus,
  type TelegramAccountStatus,
} from '../../lib/copierHealthStatus'
import { supabase } from '../../lib/supabase'
import { getCachedTgSession, setCachedTgSession } from '../../lib/telegramSessionCache'
import type { BrokerAccount } from '../../types/database'

const EXPANDED_STORAGE_KEY = 'tscopier.dashboard.copierStatusExpanded'

type Tone = 'ok' | 'warn' | 'bad' | 'muted'

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

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!userId) {
        if (!cancelled) setHasTgSession(false)
        return
      }
      const { data } = await supabase
        .from('telegram_sessions')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle()
      if (cancelled) return
      const hasSession = Boolean(data)
      setHasTgSession(hasSession)
      setCachedTgSession(userId, hasSession)
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

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
    const interval = setInterval(() => void refreshCopierHealth(), 30_000)
    return () => clearInterval(interval)
  }, [userId, refreshCopierHealth])

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

  const accountLabel = (status: TelegramAccountStatus): { label: string; tone: Tone } => {
    if (!hasTgSession || status === 'not_linked') return { label: 'Not linked', tone: 'bad' }
    if (status === 'reconnect_required' || status === 'invalid') return { label: 'Reconnect required', tone: 'bad' }
    if (status === 'linked') return { label: 'Linked', tone: 'ok' }
    return { label: 'Linked', tone: 'ok' }
  }
  const listenerLabel = (status: SignalListenerStatus): { label: string; tone: Tone } => {
    if (status === 'connected') return { label: 'Connected', tone: 'ok' }
    if (status === 'reconnecting') return { label: 'Reconnecting', tone: 'warn' }
    if (status === 'disconnected' || status === 'failed') return { label: 'Offline', tone: 'bad' }
    return { label: cs.checking, tone: 'muted' }
  }
  const engineLabel = (status: CopierEngineStatus): { label: string; tone: Tone } => {
    if (!hasActiveSubscription) return { label: t.pricing.billing.noActiveSubscription, tone: 'muted' }
    if (status === 'operational') return { label: 'Operational', tone: 'ok' }
    if (status === 'degraded') return { label: 'Degraded', tone: 'warn' }
    if (status === 'stopped') return { label: 'Stopped', tone: 'muted' }
    if (status === 'offline') return { label: 'Offline', tone: 'bad' }
    return { label: cs.checking, tone: 'muted' }
  }

  const engine = engineLabel(copierHealth.copierEngineStatus)
  const telegramAccount = accountLabel(copierHealth.telegramAccountStatus)
  const listener = listenerLabel(copierHealth.signalListenerStatus)

  // After two empty snapshots (~30s of polling), an all-unknown row is no longer
  // "checking" — the worker has not reported for this account at all. Say so
  // explicitly instead of showing a perpetual spinner-style status.
  const healthUnreported =
    hasActiveSubscription &&
    healthSnapshots >= 2 &&
    copierHealth.copierEngineStatus === 'unknown'
  if (healthUnreported) {
    engine.label = 'Unknown'
    if (copierHealth.signalListenerStatus === 'unknown') {
      listener.label = 'Unknown'
    }
  }

  const statusMessage =
    copierHealth.telegramAccountStatus === 'reconnect_required' || copierHealth.telegramAccountStatus === 'invalid'
      ? 'Telegram connection expired. Reconnect Telegram to resume copying.'
      : copierHealth.copierEngineStatus === 'operational'
        ? 'Copier is ready and listening for signals.'
        : copierHealth.signalListenerStatus === 'reconnecting' || copierHealth.copierEngineStatus === 'degraded'
          ? 'Telegram is reconnecting. New signals may be delayed.'
          : copierHealth.copierEngineStatus === 'stopped'
            ? 'Copying is stopped for this account.'
            : copierHealth.copierEngineStatus === 'offline'
              ? 'Signal listener is offline. Trades may not copy until it reconnects.'
              : healthUnreported
                ? 'Copier status has not reported yet. If this continues, the signal listener may be offline.'
                : 'Checking copier status.'

  const lastHealthy = copierHealth.lastSuccessfulHealthAt
    ? new Date(copierHealth.lastSuccessfulHealthAt).toLocaleString()
    : 'Not available'

  const hasIssues =
    hasActiveSubscription &&
    (brokerConnectionsTone === 'bad' ||
      engine.tone === 'bad' ||
      telegramAccount.tone === 'bad' ||
      listener.tone === 'bad' ||
      brokerErrorCount > 0)
  const isChecking =
    hasActiveSubscription &&
    !hasIssues &&
    !healthUnreported &&
    (engine.tone === 'muted' || copierHealth.copierEngineStatus === 'unknown')
  const collapsedSummaryTone: Tone = !hasActiveSubscription
    ? 'muted'
    : hasIssues
      ? 'bad'
      : healthUnreported
        ? 'muted'
        : isChecking
          ? 'muted'
          : 'ok'

  const collapsedSummary = !hasActiveSubscription
    ? t.pricing.billing.noActiveSubscription
    : collapsedSummaryTone === 'bad'
      ? cs.checksFailed
      : isChecking
        ? cs.checking
        : healthUnreported
          ? 'Unknown'
          : cs.allChecksPassed

  return (
    <div
      className={clsx(
        !embedded &&
          'bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800',
        className,
      )}
    >
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className={clsx(
          'w-full px-4 sm:px-5 py-3.5 flex items-center gap-2 text-left',
          'hover:bg-neutral-50/80 dark:hover:bg-neutral-800/40 transition-colors',
          expanded && 'border-b border-neutral-100 dark:border-neutral-800',
        )}
      >
        <Activity className="w-4 h-4 text-teal-500 shrink-0" />
        {!expanded ? (
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-semibold text-neutral-900 dark:text-neutral-50">
              {cs.title}:{' '}
            </span>
            <StatusValue tone={collapsedSummaryTone}>{collapsedSummary}</StatusValue>
          </span>
        ) : (
          <>
            <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 shrink-0">
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
        <div className="px-4 sm:px-5 py-3 divide-y divide-neutral-100 dark:divide-neutral-800">
          <div className="pb-3 text-sm text-neutral-700 dark:text-neutral-300">
            <div>{statusMessage}</div>
            <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              Last healthy: {lastHealthy}
            </div>
          </div>
          <div className="grid sm:grid-cols-2 sm:gap-x-10 sm:divide-y-0">
          <StatusRow
            label={cs.allBrokerConnections}
            value={brokerConnectionsLabel}
            tone={brokerConnectionsTone}
          />
          <StatusRow label={cs.copierEngine} value={engine.label} tone={engine.tone} />
          <StatusRow label="Telegram account" value={telegramAccount.label} tone={telegramAccount.tone} />
          <StatusRow label="Signal listener" value={listener.label} tone={listener.tone} />
          <StatusRow
            label={cs.brokerErrors}
            value={String(brokerErrorCount)}
            tone={brokerErrorCount > 0 ? 'bad' : 'ok'}
          />
          </div>
          <button
            type="button"
            onClick={() => void refreshCopierHealth()}
            className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Refresh status
          </button>
        </div>
      ) : null}
    </div>
  )
}
