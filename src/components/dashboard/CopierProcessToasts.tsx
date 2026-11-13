import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useT } from '../../context/LocaleContext'
import {
  buildChannelDisplayNames,
  TRADE_EXECUTION_LOG_SELECT,
  type TradeActivityLogRow,
} from '../../lib/tradeActivities'
import {
  buildChannelSourceKinds,
  type SignalSourceKind,
} from '../../lib/signalSourceMark'
import {
  copierProcessToastFromLog,
  mergeCopierProcessToastSeen,
  readCopierProcessToastSeen,
  shouldAnnounceCopierProcessToast,
  writeCopierProcessToastSeen,
  type CopierProcessToast,
} from '../../lib/copierProcessToast'
import { whenRealtimeReady } from '../../lib/whenRealtimeReady'

const TOAST_MS = 6_000
const MAX_TOASTS = 4
const SEEN_HYDRATE_LIMIT = 100

const STATUS_ACCENT: Record<CopierProcessToast['status'], string> = {
  successful: 'bg-green-400',
  skipped: 'bg-amber-400',
  failed: 'bg-red-500',
}

type ChannelRow = {
  id: string
  display_name: string
  channel_username?: string | null
  source_kind?: string | null
}

export function CopierProcessToasts({
  userId,
  embedded = false,
}: {
  userId: string | undefined
  /** When true, omit the fixed stack wrapper (parent provides it). */
  embedded?: boolean
}) {
  const t = useT()
  const navigate = useNavigate()
  const [toasts, setToasts] = useState<CopierProcessToast[]>([])
  const seen = useRef(new Map<string, string>())
  const timers = useRef(new Map<string, number>())
  const channelNamesRef = useRef<Record<string, string>>({})
  const channelKindsRef = useRef<Record<string, SignalSourceKind>>({})
  const labelsRef = useRef({
    channelWorker: t.channelWorker,
    management: t.management,
  })
  labelsRef.current = {
    channelWorker: t.channelWorker,
    management: t.management,
  }

  const dismiss = (logId: string) => {
    const timer = timers.current.get(logId)
    if (timer) window.clearTimeout(timer)
    timers.current.delete(logId)
    setToasts(current => current.filter(toast => toast.logId !== logId))
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
    seen.current = readCopierProcessToastSeen(userId)
    channelNamesRef.current = {}
    channelKindsRef.current = {}
    setToasts([])
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    const ensureChannels = async () => {
      if (Object.keys(channelNamesRef.current).length > 0) return
      const { data, error } = await supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username,source_kind')
        .eq('user_id', userId)
      if (error || !data || cancelled) return
      const rows = data as ChannelRow[]
      channelNamesRef.current = buildChannelDisplayNames(rows)
      channelKindsRef.current = buildChannelSourceKinds(rows)
    }

    const show = async (raw: { id?: unknown; action?: unknown; status?: unknown }) => {
      if (cancelled || typeof raw.id !== 'string') return
      const decision = shouldAnnounceCopierProcessToast(seen.current, {
        id: raw.id,
        action: String(raw.action ?? ''),
        status: String(raw.status ?? ''),
      })
      writeCopierProcessToastSeen(userId, seen.current)
      if (decision !== 'show') return

      await ensureChannels()
      if (cancelled) return

      const { data, error } = await supabase
        .from('trade_execution_logs')
        .select(TRADE_EXECUTION_LOG_SELECT)
        .eq('id', raw.id)
        .maybeSingle()
      if (cancelled || error || !data) return

      const toast = copierProcessToastFromLog(
        data as TradeActivityLogRow,
        labelsRef.current.channelWorker,
        labelsRef.current.management,
        channelNamesRef.current,
        channelKindsRef.current,
      )
      if (!toast) return

      setToasts(current => [...current.filter(item => item.logId !== toast.logId), toast].slice(-MAX_TOASTS))
      const previous = timers.current.get(toast.logId)
      if (previous) window.clearTimeout(previous)
      timers.current.set(toast.logId, window.setTimeout(() => {
        timers.current.delete(toast.logId)
        setToasts(current => current.filter(item => item.logId !== toast.logId))
      }, TOAST_MS))
    }

    const start = async () => {
      const { data } = await supabase
        .from('trade_execution_logs')
        .select('id,status,action')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(SEEN_HYDRATE_LIMIT)
      if (cancelled) return
      mergeCopierProcessToastSeen(
        seen.current,
        (data ?? []) as Array<Pick<TradeActivityLogRow, 'id' | 'status' | 'action'>>,
      )
      writeCopierProcessToastSeen(userId, seen.current)

      await whenRealtimeReady(userId)
      if (cancelled) return
      channel = supabase
        .channel(`copier_process_toasts:${userId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'trade_execution_logs', filter: `user_id=eq.${userId}` },
          payload => void show(payload.new as { id?: unknown; action?: unknown; status?: unknown }),
        )
        .subscribe()
    }

    void start()

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [userId])

  if (toasts.length === 0) return null

  const closeLabel = t.copierLogs.detailModal?.close ?? 'Close'
  const cards = toasts.map(toast => (
    <div
      key={toast.logId}
      className="pointer-events-auto flex items-stretch overflow-hidden rounded-lg border border-neutral-200 bg-white text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      <span className={clsx('w-1 shrink-0', STATUS_ACCENT[toast.status])} aria-hidden />
      <button
        type="button"
        onClick={() => navigate('/activities')}
        className="min-w-0 flex-1 py-2.5 ps-3 text-start"
      >
        <p className="font-semibold text-neutral-900 dark:text-neutral-50">{toast.title}</p>
        <p className="mt-0.5 line-clamp-2 text-neutral-900 dark:text-neutral-50">{toast.detail}</p>
        {(toast.channelName || toast.symbol) ? (
          <p className="mt-1 truncate text-xs text-neutral-900 dark:text-neutral-50">
            {[toast.symbol, toast.channelName].filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => dismiss(toast.logId)}
        className="my-2 me-2 rounded-md p-1 text-neutral-900 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800"
        aria-label={closeLabel}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  ))

  if (embedded) return <>{cards}</>

  return (
    <div
      className="pointer-events-none fixed bottom-4 inset-e-4 z-70 flex w-[min(100vw-2rem,22rem)] flex-col gap-2"
      aria-live="polite"
    >
      {cards}
    </div>
  )
}
