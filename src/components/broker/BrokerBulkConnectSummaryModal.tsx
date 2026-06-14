import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, X } from 'lucide-react'
import type { AccountConfigBulkConnectTranslations } from '../../i18n/locales/types'
import type { BulkConnectResult } from '../../lib/bulkConnectBrokers'
import { interpolate } from '../../i18n/interpolate'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { Button } from '../ui/Button'

interface BrokerBulkConnectSummaryModalProps {
  open: boolean
  result: BulkConnectResult | null
  copy: AccountConfigBulkConnectTranslations
  onDismiss: () => void
  onViewBrokers: () => void
}

export function BrokerBulkConnectSummaryModal({
  open,
  result,
  copy,
  onDismiss,
  onViewBrokers,
}: BrokerBulkConnectSummaryModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, onDismiss)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onDismiss])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open || !result) return null

  const failedRows = result.rows.filter(row => row.status === 'failed')
  const body = interpolate(copy.summaryBody, {
    linked: String(result.linkedCount),
    failed: String(result.failedCount),
    skipped: String(result.skippedCount),
  })

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-4 sm:p-6"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/50" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-connect-summary-title"
        className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 animate-modal-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 dark:bg-teal-950/40 text-teal-600 dark:text-teal-400">
              <CheckCircle2 className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="bulk-connect-summary-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {copy.summaryTitle}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                {body}
              </p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              aria-label={copy.dismiss}
              className="shrink-0 rounded-lg p-2 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {failedRows.length > 0 ? (
            <div className="mt-4 rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-800/60">
              <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {copy.summaryFailedTitle}
              </p>
              <ul className="mt-2 space-y-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                {failedRows.map(row => (
                  <li key={row.index} className="truncate">
                    {row.row.account_number.trim() || '—'}
                    {row.row.broker_server.trim() ? ` · ${row.row.broker_server.trim()}` : ''}
                    {row.error ? ` — ${row.error}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" size="sm" onClick={onDismiss}>
            {copy.dismiss}
          </Button>
          <Button type="button" size="sm" onClick={onViewBrokers}>
            {copy.viewBrokers}
          </Button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
