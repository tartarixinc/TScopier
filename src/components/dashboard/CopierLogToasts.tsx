import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useT } from '../../context/LocaleContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import type { Signal } from '../../types/database'
import {
  copierLogDestinationIcons,
  copierLogDestinationLabel,
  copierLogSourceIcon,
  copierLogSourceLabel,
  copierLogToastFingerprint,
  copierLogToastFromSignal,
  signalHistoryToastLabels,
  type CopierLogToast,
} from '../../lib/copierLogToast'
import { whenRealtimeReady } from '../../lib/whenRealtimeReady'

type ChannelRow = {
  id: string
  display_name: string | null
  channel_username?: string | null
  source_kind?: string | null
}

const TOAST_MS = 6_000
const MAX_TOASTS = 4

const STATUS_ACCENT: Record<string, string> = {
  executed: 'bg-green-400',
  skipped: 'bg-amber-400',
  failed: 'bg-red-500',
  pending: 'bg-neutral-300',
  parsed: 'bg-teal-400',
}

export function CopierLogToasts({ userId }: { userId: string | undefined }) {
  const t = useT()
  const navigate = useNavigate()
  const { brokers } = useBrokerAccounts()
  const [toasts, setToasts] = useState<CopierLogToast[]>([])
  const seen = useRef(new Map<string, string>())
  const timers = useRef(new Map<string, number>())
  const brokersRef = useRef(brokers)
  brokersRef.current = brokers
  const labelsRef = useRef({
    copierLogs: t.copierLogs,
    history: t.signalHistoryPage,
    unknownChannel: t.configurationsPage.unknownChannel,
    copyFrom: t.configurationsPage.copyFrom,
    copyTo: t.configurationsPage.copyTo,
  })
  labelsRef.current = {
    copierLogs: t.copierLogs,
    history: t.signalHistoryPage,
    unknownChannel: t.configurationsPage.unknownChannel,
    copyFrom: t.configurationsPage.copyFrom,
    copyTo: t.configurationsPage.copyTo,
  }
  const channelsRef = useRef(new Map<string, ChannelRow>())

  const dismiss = (signalId: string) => {
    const timer = timers.current.get(signalId)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(signalId)
    setToasts(current => current.filter(toast => toast.signalId !== signalId))
  }

  useEffect(() => {
    const activeTimers = timers.current
    return () => {
      for (const timer of activeTimers.values()) window.clearTimeout(timer)
      activeTimers.clear()
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    seen.current.clear()
    channelsRef.current = new Map()
    setToasts([])
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    const ensureChannels = async () => {
      if (channelsRef.current.size > 0) return channelsRef.current
      const { data, error } = await supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username,source_kind')
        .eq('user_id', userId)
      if (error || !data) return channelsRef.current
      const next = new Map<string, ChannelRow>()
      for (const row of data as ChannelRow[]) next.set(row.id, row)
      channelsRef.current = next
      return next
    }

    const show = async (signal: Signal) => {
      const fingerprint = copierLogToastFingerprint(signal)
      if (seen.current.get(signal.id) === fingerprint) return
      seen.current.set(signal.id, fingerprint)
      const channels = await ensureChannels()
      if (cancelled) return
      if (signal.channel_id && !channels.has(signal.channel_id)) {
        channelsRef.current = new Map()
        await ensureChannels()
      }
      if (cancelled) return
      const channel = signal.channel_id ? channelsRef.current.get(signal.channel_id) : null
      const toast = copierLogToastFromSignal(
        signal,
        labelsRef.current.copierLogs,
        signalHistoryToastLabels(labelsRef.current.history),
        {
          source: copierLogSourceLabel(channel, labelsRef.current.unknownChannel),
          sourceIcon: copierLogSourceIcon(channel),
          destination: copierLogDestinationLabel(brokersRef.current, signal.channel_id),
          destinationIcons: copierLogDestinationIcons(brokersRef.current, signal.channel_id),
        },
      )
      if (!toast) return
      setToasts(current => [...current.filter(item => item.signalId !== toast.signalId), toast].slice(-MAX_TOASTS))
      const previous = timers.current.get(toast.signalId)
      if (previous) window.clearTimeout(previous)
      timers.current.set(toast.signalId, window.setTimeout(() => {
        timers.current.delete(toast.signalId)
        setToasts(current => current.filter(item => item.signalId !== toast.signalId))
      }, TOAST_MS))
    }

    void whenRealtimeReady(userId).then(() => {
      if (cancelled) return
      channel = supabase
        .channel(`copier_log_toasts:${userId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'signals', filter: `user_id=eq.${userId}` },
          payload => show(payload.new as Signal),
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'signals', filter: `user_id=eq.${userId}` },
          payload => show(payload.new as Signal),
        )
        .subscribe()
    })

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [userId])

  if (toasts.length === 0) return null

  const closeLabel = t.copierLogs.detailModal?.close ?? 'Close'

  return (
    <div
      className="pointer-events-none fixed bottom-4 end-4 z-[70] flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map(toast => (
        <div
          key={toast.signalId}
          className="pointer-events-auto flex items-stretch overflow-hidden rounded-lg border border-neutral-200 bg-white text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <span className={clsx('w-1 shrink-0', STATUS_ACCENT[toast.status] ?? 'bg-neutral-300')} aria-hidden />
          <button
            type="button"
            onClick={() => navigate('/copier-logs')}
            className="min-w-0 flex-1 py-2.5 ps-3 text-start"
          >
            <p className="font-semibold text-neutral-900 dark:text-neutral-50">{toast.title}</p>
            <p className="mt-0.5 line-clamp-2 text-neutral-900 dark:text-neutral-50">{toast.detail}</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-neutral-900 dark:text-neutral-50">
              {toast.sourceIcon ? (
                <img src={toast.sourceIcon} alt="" aria-hidden className="h-4 w-4 shrink-0 object-contain" />
              ) : null}
              <span className="truncate">{t.configurationsPage.copyFrom} {toast.source}</span>
            </p>
            <p className="flex items-center gap-1.5 text-xs text-neutral-900 dark:text-neutral-50">
              {toast.destinationIcons.map(icon => (
                <img key={icon} src={icon} alt="" aria-hidden className="h-4 w-4 shrink-0 object-contain" />
              ))}
              <span className="truncate">{t.configurationsPage.copyTo} {toast.destination}</span>
            </p>
          </button>
          <button
            type="button"
            onClick={() => dismiss(toast.signalId)}
            className="my-2 me-2 rounded-md p-1 text-neutral-900 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={closeLabel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
