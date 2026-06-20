import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { AlertTriangle } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { Button } from '../ui/Button'
import type { ForceCloseConfirmRequest } from '../../hooks/useForceCloseSignalTrades'

type CloseSignalTradesConfirmModalProps = {
  request: ForceCloseConfirmRequest
  formatSignedMoney: (value: number) => string
  onCancel: () => void
  onConfirm: () => void
  confirming?: boolean
}

export function CloseSignalTradesConfirmModal({
  request,
  formatSignedMoney,
  onCancel,
  onConfirm,
  confirming = false,
}: CloseSignalTradesConfirmModalProps) {
  const t = useT()
  const bs = t.dashboard.brokerStats
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, onCancel)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirming) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirming, onCancel])

  const title =
    request.scope === 'channel'
      ? bs.closeConfirmTitleChannel
      : request.scope === 'broker'
        ? bs.closeConfirmTitleBroker
        : bs.closeConfirmTitleAllAccounts

  const body =
    request.scope === 'channel'
      ? interpolate(bs.closeConfirmBodyChannel, { channel: request.channelLabel })
      : request.scope === 'broker'
        ? bs.closeConfirmBodyBroker
        : interpolate(bs.closeConfirmBodyAllAccounts, { count: String(request.accountCount) })

  const pnlColor = (n: number) =>
    n > 0 ? 'text-teal-600' : n < 0 ? 'text-error-600' : 'text-neutral-900 dark:text-neutral-50'

  const detailRows: { label: string; value: string; valueClass?: string }[] = []

  if (request.accountLabel) {
    detailRows.push({ label: bs.closeConfirmAccount, value: request.accountLabel })
  }
  if (request.scope === 'channel') {
    detailRows.push({ label: bs.channel, value: request.channelLabel })
  } else if (request.channelCount > 0) {
    detailRows.push({
      label: bs.channel,
      value: interpolate(bs.closeConfirmChannelCount, { count: String(request.channelCount) }),
    })
  }
  if (request.positionCount > 0) {
    detailRows.push({
      label: bs.closeConfirmPositionsLabel,
      value: interpolate(bs.closeConfirmPositions, { count: String(request.positionCount) }),
    })
  }
  if (request.totalLots > 0) {
    detailRows.push({
      label: bs.lots,
      value: interpolate(bs.closeConfirmLots, { lots: request.totalLots.toFixed(2) }),
    })
  }
  detailRows.push({
    label: bs.openPnl,
    value: formatSignedMoney(request.pnl),
    valueClass: pnlColor(request.pnl),
  })

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/55" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-signal-trades-confirm-title"
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 animate-modal-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="close-signal-trades-confirm-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {title}
              </h2>
              <p className="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                {body}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-800/40 divide-y divide-neutral-200/80 dark:divide-neutral-700/80">
            {detailRows.map(row => (
              <div key={row.label} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{row.label}</span>
                <span
                  className={clsx(
                    'text-sm font-semibold tabular-nums text-right truncate max-w-[60%]',
                    row.valueClass ?? 'text-neutral-900 dark:text-neutral-50',
                  )}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500 leading-relaxed">
            {bs.closeConfirmWarning}
          </p>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={confirming}
            onClick={onCancel}
            className="sm:min-w-[7rem]"
          >
            {t.common.cancel}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            loading={confirming}
            onClick={onConfirm}
            className="sm:min-w-[7rem]"
          >
            {confirming ? bs.closing : bs.closeConfirmAction}
          </Button>
        </div>
      </div>
    </div>
  )
}
