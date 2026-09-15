import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useT } from '../../context/LocaleContext'
import { useAssistant } from '../../context/useAssistant'
import { en } from '../../i18n/locales/en'
import {
  fetchCopierLogExecutionDetails,
  formatCopierSkipReasonDetail,
  formatCopierSkipReasonShort,
  formatParsedLevels,
  getTradeFailureDisplayFromLog,
  summarizeExecutionLogRow,
  type CopierExecutionLogRow,
} from '../../lib/copierLogDetail'
import { buildTradeFailureAssistantPrompt, resolveTradeFailureDisplay } from '../../lib/tradeFailureDisplay'
import { tradeSignalActionLabel, type TradeSignalSummaryLabels } from '../../lib/copierLogDisplay'
import type { Signal } from '../../types/database'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'

type StatusVariant = 'success' | 'warning' | 'error' | 'neutral' | 'primary'

const DEFAULT_DETAIL_MODAL = en.copierLogs.detailModal!

export function CopierLogDetailModal({
  signal,
  channelName,
  symbol,
  status,
  onClose,
  onRetry,
  isRetrying,
  retryEligible,
}: {
  signal: Signal | null
  channelName: string
  symbol: string
  status: { variant: StatusVariant; label: string }
  onClose: () => void
  onRetry?: () => void
  isRetrying?: boolean
  retryEligible?: boolean
}) {
  const t = useT()
  const assistant = useAssistant()
  const copierLogs = t.copierLogs
  const dm = copierLogs.detailModal ?? DEFAULT_DETAIL_MODAL
  const [timeline, setTimeline] = useState<CopierExecutionLogRow[] | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)

  const parsed = signal?.parsed_data as Record<string, unknown> | null
  const action = String(parsed?.action ?? '').toLowerCase()
  const levels = signal ? formatParsedLevels(signal) : { entry: null, sl: null, tp: null }

  const summaryLabels: TradeSignalSummaryLabels = useMemo(
    () => ({
      actionBuy: t.signalHistoryPage.actionBuy,
      actionSell: t.signalHistoryPage.actionSell,
      actionClose: t.signalHistoryPage.actionClose,
      actionCloseWorseEntries: t.signalHistoryPage.actionCloseWorseEntries,
      actionBreakeven: t.signalHistoryPage.actionBreakeven,
      actionModify: t.signalHistoryPage.actionModify,
      actionPartialProfit: t.signalHistoryPage.actionPartialProfit,
      actionPartialBreakeven: t.signalHistoryPage.actionPartialBreakeven,
      onSymbol: t.signalHistoryPage.onSymbol,
      entryAt: t.signalHistoryPage.entryAt,
      slAt: t.signalHistoryPage.slAt,
      tpAt: t.signalHistoryPage.tpAt,
    }),
    [t],
  )

  const reasonShort = formatCopierSkipReasonShort(signal?.skip_reason, copierLogs)
  const reasonDetail = formatCopierSkipReasonDetail(signal?.skip_reason, copierLogs)
  const structuredFailure = useMemo(() => {
    const fromTimeline = timeline
      ?.map(row => getTradeFailureDisplayFromLog(row))
      .find(Boolean)
    if (fromTimeline) return fromTimeline
    return resolveTradeFailureDisplay({ reasonCode: signal?.skip_reason })
  }, [signal?.skip_reason, timeline])
  const actionLabel = action
    ? tradeSignalActionLabel(action, summaryLabels)
    : '—'

  const askAssistantAboutFailure = () => {
    if (!structuredFailure) return
    assistant.persistMessages(prev => [
      ...prev,
      { role: 'user', content: buildTradeFailureAssistantPrompt(structuredFailure) },
    ])
    assistant.openAssistant()
  }

  const askAssistantExplainSignal = () => {
    const parsed = signal?.parsed_data as Record<string, unknown> | null
    const context = [
      `Signal ID: ${signal?.id}`,
      `Status: ${signal?.status}`,
      `Symbol: ${symbol}`,
      `Action: ${parsed?.action ?? '—'}`,
      parsed?.entry_price ? `Entry price: ${parsed.entry_price}` : '',
      parsed?.sl ? `Stop loss: ${parsed.sl}` : '',
      Array.isArray(parsed?.tp) ? `Take profit: ${parsed.tp.join(', ')}` : '',
      signal?.skip_reason ? `Skip reason: ${signal.skip_reason}` : '',
      timeline?.length ? `Timeline: ${timeline.map(r => `${r.action} (${r.status})`).join(', ')}` : '',
    ].filter(Boolean).join('\n')
    assistant.setPendingAutoSend(`Please explain what happened with this trade signal in plain English.\n\n${context}`)
    assistant.openAssistant()
  }

  useEffect(() => {
    if (!signal) {
      setTimeline(null)
      return
    }
    let cancelled = false
    setTimelineLoading(true)
    setTimeline(null)
    void fetchCopierLogExecutionDetails(supabase, signal.id)
      .then(rows => {
        if (!cancelled) setTimeline(rows)
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [signal?.id])

  useEffect(() => {
    if (!signal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [signal, onClose])

  if (!signal) return null

  const receivedAt = new Date(signal.created_at).toLocaleString()
  const rawMessage = signal.raw_message?.trim() || (signal.raw_image_url ? '(image)' : '—')
  const technicalCode = signal.skip_reason?.trim() || '—'
  const showReason = signal.status === 'skipped' || signal.status === 'failed' || Boolean(signal.skip_reason)
  const effectiveRetryEligible = retryEligible && structuredFailure?.retryable !== false

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="copier-log-detail-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={dm.close}
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <div className="min-w-0">
            <h2 id="copier-log-detail-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate">
              {dm.title}
            </h2>
            <p className="text-xs text-neutral-400 truncate">{symbol} · {channelName}</p>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            aria-label={dm.close}
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={status.variant} size="sm">{status.label}</Badge>
              {action ? (
                <span className={clsx(
                  'text-xs font-semibold uppercase',
                  action === 'buy' ? 'text-primary-600' : action === 'sell' ? 'text-error-600' : 'text-neutral-500',
                )}>
                  {actionLabel}
                </span>
              ) : null}
            </div>
            <DetailRow label={dm.receivedAt} value={receivedAt} />
            {showReason ? (
              <>
                <DetailRow label={dm.reason} value={structuredFailure?.title ?? reasonShort} emphasize />
                {structuredFailure ? (
                  <p className="text-sm text-neutral-600 dark:text-neutral-300 leading-relaxed">
                    <span className="font-medium text-neutral-700 dark:text-neutral-200">{dm.whatHappened}: </span>
                    {structuredFailure.explanation}
                    {structuredFailure.recommendedAction ? ` ${structuredFailure.recommendedAction}` : ''}
                  </p>
                ) : reasonDetail ? (
                  <p className="text-sm text-neutral-600 dark:text-neutral-300 leading-relaxed">
                    <span className="font-medium text-neutral-700 dark:text-neutral-200">{dm.whatHappened}: </span>
                    {reasonDetail}
                  </p>
                ) : null}
                {structuredFailure ? (
                  <button
                    type="button"
                    onClick={askAssistantAboutFailure}
                    className="text-xs font-semibold text-teal-700 dark:text-teal-300 hover:underline underline-offset-2"
                  >
                    Ask AI about this issue
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={askAssistantExplainSignal}
                  className="text-xs font-semibold text-teal-700 dark:text-teal-300 hover:underline underline-offset-2"
                >
                  {dm.explainWithAi}
                </button>
                {technicalCode !== '—' && technicalCode !== reasonShort ? (
                  <DetailRow label={dm.technicalCode} value={technicalCode} mono />
                ) : null}
              </>
            ) : null}
          </section>

          {(levels.entry || levels.sl || levels.tp) ? (
            <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{dm.levels}</p>
              {levels.entry ? <DetailRow label={dm.entry} value={levels.entry} /> : null}
              {levels.sl ? <DetailRow label={dm.stopLoss} value={levels.sl} /> : null}
              {levels.tp ? <DetailRow label={dm.takeProfit} value={levels.tp} /> : null}
            </section>
          ) : null}

          <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{dm.signalMessage}</p>
            <pre className="text-sm text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap font-sans leading-relaxed">
              {rawMessage}
            </pre>
          </section>

          <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{dm.timeline}</p>
            {timelineLoading ? (
              <p className="text-sm text-neutral-500 inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {dm.loadingTimeline}
              </p>
            ) : timeline?.length ? (
              <ul className="space-y-2">
                {timeline.map((row, idx) => (
                  <li
                    key={`${row.created_at}-${row.action}-${idx}`}
                    className={clsx(
                      'flex gap-3 text-sm',
                      row.status === 'failed' && 'text-error-700 dark:text-error-300',
                      row.status === 'skipped' && 'text-warning-700 dark:text-warning-300',
                    )}
                  >
                    <span className="text-xs text-neutral-400 whitespace-nowrap tabular-nums shrink-0 pt-0.5">
                      {new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <span className="min-w-0 break-words">
                      {summarizeExecutionLogRow(row, copierLogs)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-neutral-500">{dm.noTimeline}</p>
            )}
          </section>

          {effectiveRetryEligible && onRetry ? (
            <Button
              type="button"
              variant="secondary"
              disabled={isRetrying}
              onClick={onRetry}
              className="w-full sm:w-auto"
            >
              {isRetrying ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {copierLogs.retry}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  emphasize,
  mono,
}: {
  label: string
  value: string
  emphasize?: boolean
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3 sm:items-start">
      <span className="text-xs font-medium text-neutral-500 shrink-0 sm:w-28">{label}</span>
      <span className={clsx(
        'text-sm text-neutral-800 dark:text-neutral-100 min-w-0 break-words',
        emphasize && 'font-medium',
        mono && 'font-mono text-xs text-neutral-500',
      )}>
        {value}
      </span>
    </div>
  )
}
