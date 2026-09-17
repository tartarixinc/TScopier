import { useEffect, useMemo, useState } from 'react'
import { Radio, ShieldAlert, X } from 'lucide-react'
import { useHumanReview } from '../../context/HumanReviewContext'
import { useAssistant } from '../../context/useAssistant'
import { useT } from '../../context/LocaleContext'
import { useReviewActions } from '../../hooks/useReviewActions'
import {
  formatReviewRemaining,
  reviewRemainingMs,
} from '../../lib/humanReview'
import { supabase } from '../../lib/supabase'
import type { Signal } from '../../types/database'

interface SignalReviewDetailModalProps {
  signal: Signal | null
  onClose: () => void
}

type ChannelInfo = { display_name: string | null; channel_username: string | null }

/** Detail modal for an AI-escalated signal awaiting approval, opened from the Trades page. */
export function SignalReviewDetailModal({ signal, onClose }: SignalReviewDetailModalProps) {
  const { pending } = useHumanReview()
  const { approvingId, errorBySignal, approve, dismiss } = useReviewActions()
  const assistant = useAssistant()
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  const [channel, setChannel] = useState<ChannelInfo | null | undefined>(undefined)

  useEffect(() => {
    if (!signal) {
      setChannel(undefined)
      return
    }
    let cancelled = false
    setChannel(undefined)
    void (async () => {
      if (!signal.channel_id) {
        if (!cancelled) setChannel(null)
        return
      }
      const { data } = await supabase
        .from('telegram_channels')
        .select('display_name, channel_username')
        .eq('id', signal.channel_id)
        .maybeSingle()
      if (!cancelled) setChannel((data as ChannelInfo | null) ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [signal])

  useEffect(() => {
    if (!signal) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.clearInterval(id)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [signal, onClose])

  const askAssistantExplainSignal = () => {
    const parsed = signal?.parsed_data as Record<string, unknown> | null
    const rawMessage = signal?.raw_message?.trim() || ''
    const context = [
      `Signal ID: ${signal?.id}`,
      `Status: ${signal?.status}`,
      `Symbol: ${parsed?.symbol ?? '—'}`,
      `Action: ${parsed?.action ?? '—'}`,
      parsed?.entry_price ? `Entry price: ${parsed.entry_price}` : '',
      parsed?.sl ? `Stop loss: ${parsed.sl}` : '',
      Array.isArray(parsed?.tp) ? `Take profit: ${parsed.tp.join(', ')}` : '',
      signal?.skip_reason ? `Skip reason: ${signal.skip_reason}` : '',
      rawMessage ? `\nOriginal Telegram message:\n${rawMessage}` : '',
    ].filter(Boolean).join('\n')
    assistant.setPendingAutoSend(`Please explain what happened with this trade signal in plain English.\n\n${context}`)
    assistant.openAssistant()
  }

  const levels = useMemo(() => {
    if (!signal) return null
    const p = (signal.parsed_data ?? {}) as Record<string, unknown>
    const entry = p.entry_price as number | null
    const zoneLow = p.entry_zone_low as number | null
    const zoneHigh = p.entry_zone_high as number | null
    const entryText = zoneLow != null && zoneHigh != null
      ? `${zoneLow} – ${zoneHigh}`
      : entry != null
        ? String(entry)
        : null
    return {
      action: String(p.action ?? '').trim() || null,
      symbol: String(p.symbol ?? '').trim() || null,
      entry: entryText,
      sl: p.sl != null ? String(p.sl) : null,
      tp: Array.isArray(p.tp) && p.tp.length > 0 ? p.tp.join(', ') : null,
    }
  }, [signal])

  if (!signal) return null

  const remainingMs = reviewRemainingMs(signal.created_at, now)
  const expired = remainingMs <= 0
  const error = errorBySignal[signal.id]
  const pendingApprove = approvingId === signal.id
  const fallbackText = (() => {
    const pd = signal.parsed_data
    if (pd && typeof pd === 'object' && !Array.isArray(pd)) {
      const instr = (pd as Record<string, unknown>).raw_instruction
      if (typeof instr === 'string' && instr.trim()) return instr
    }
    return null
  })()
  const messageText = signal.raw_message?.trim() || fallbackText || '(no message)'

  const channelLabel = (() => {
    if (!channel) return null
    const name = channel.display_name?.trim()
    const username = channel.channel_username?.trim().replace(/^@/, '')
    if (name && username) return `${name} (@${username})`
    if (name) return name
    if (username) return `@${username}`
    return null
  })()

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="signal-review-detail-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-amber-200 dark:border-amber-800/70 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-amber-100 bg-amber-50/80 px-5 py-4 dark:border-amber-900/50 dark:bg-amber-950/30">
          <div className="min-w-0">
            <h2 id="signal-review-detail-title" className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              Signal review required
            </h2>
            <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
              {expired ? 'expired — approval window passed' : formatReviewRemaining(remainingMs)}
            </p>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-amber-100/70 dark:hover:bg-amber-900/40 transition-colors"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <section className="rounded-xl border border-amber-200 dark:border-amber-800/70 bg-amber-50/40 dark:bg-amber-950/20 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
                Signal channel
              </p>
            </div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
              {channelLabel ?? '—'}
            </p>
            <p className="text-xs text-neutral-500 tabular-nums">
              {new Date(signal.created_at).toLocaleString([], {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Telegram message
            </p>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap break-words rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-800/30 px-4 py-3">
              {messageText}
            </p>
            {signal.raw_image_url ? (
              <a
                href={signal.raw_image_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-amber-600 dark:text-amber-400 hover:underline"
              >
                {signal.raw_image_url}
              </a>
            ) : null}
          </section>

          <button
            type="button"
            onClick={askAssistantExplainSignal}
            className="text-xs font-semibold text-teal-700 dark:text-teal-300 hover:underline underline-offset-2"
          >
            {t.copierLogs.detailModal?.explainWithAi ?? 'Explain with AI'}
          </button>

          {levels ? (
            <section className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Parsed levels
              </p>
              <dl className="rounded-xl border border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-100 dark:divide-neutral-800">
                {levels.symbol ? (
                  <div className="flex justify-between gap-3 px-4 py-2.5 text-sm">
                    <dt className="text-neutral-500 shrink-0">Symbol</dt>
                    <dd className="text-neutral-800 dark:text-neutral-200 text-right font-medium">{levels.symbol}</dd>
                  </div>
                ) : null}
                {levels.action ? (
                  <div className="flex justify-between gap-3 px-4 py-2.5 text-sm">
                    <dt className="text-neutral-500 shrink-0">Action</dt>
                    <dd className="text-neutral-800 dark:text-neutral-200 text-right font-medium uppercase">{levels.action}</dd>
                  </div>
                ) : null}
                {levels.entry ? (
                  <div className="flex justify-between gap-3 px-4 py-2.5 text-sm">
                    <dt className="text-neutral-500 shrink-0">Entry</dt>
                    <dd className="text-neutral-800 dark:text-neutral-200 text-right font-medium tabular-nums">{levels.entry}</dd>
                  </div>
                ) : null}
                {levels.sl ? (
                  <div className="flex justify-between gap-3 px-4 py-2.5 text-sm">
                    <dt className="text-neutral-500 shrink-0">SL</dt>
                    <dd className="text-neutral-800 dark:text-neutral-200 text-right font-medium tabular-nums">{levels.sl}</dd>
                  </div>
                ) : null}
                {levels.tp ? (
                  <div className="flex justify-between gap-3 px-4 py-2.5 text-sm">
                    <dt className="text-neutral-500 shrink-0">TP</dt>
                    <dd className="text-neutral-800 dark:text-neutral-200 text-right font-medium tabular-nums">{levels.tp}</dd>
                  </div>
                ) : null}
              </dl>
            </section>
          ) : null}

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400 break-words">{error}</p>
          ) : null}
        </div>

        <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t border-amber-100 bg-white px-5 py-3 dark:border-amber-900/50 dark:bg-neutral-900">
          <button
            type="button"
            disabled={pendingApprove || expired}
            onClick={() => { void approve(signal.id) }}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pendingApprove ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            disabled={pendingApprove}
            onClick={() => dismiss(signal.id)}
            className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Dismiss
          </button>
          {pending.length > 1 ? (
            <p className="ml-auto text-xs text-neutral-400">
              {pending.length} awaiting approval
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
