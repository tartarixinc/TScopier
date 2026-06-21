import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, X } from 'lucide-react'
import type { BrokerAccount } from '../../types/database'
import { getBrokerDisplayLabel } from '../../lib/brokerChannelLink'
import { interpolate } from '../../i18n/interpolate'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { Button } from '../ui/Button'

export interface BrokerConnectedSuccessModalCopy {
  title: string
  titlePending: string
  body: string
  bodyPending: string
  addChannel: string
  configure: string
  detailLogin: string
  detailServer: string
  dismiss: string
}

interface BrokerConnectedSuccessModalProps {
  open: boolean
  broker: BrokerAccount | null
  copy: BrokerConnectedSuccessModalCopy
  onAddChannel: () => void
  onConfigure: () => void
  onDismiss: () => void
}

function platformLogo(platform: string): string | null {
  if (platform === 'MT5') return '/MT5.png'
  if (platform === 'MT4') return '/MT4.png'
  return null
}

export function BrokerConnectedSuccessModal({
  open,
  broker,
  copy,
  onAddChannel,
  onConfigure,
  onDismiss,
}: BrokerConnectedSuccessModalProps) {
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

  if (!open || !broker) return null

  const logo = platformLogo(broker.platform)
  const label = getBrokerDisplayLabel(broker)
  const modalTitle = copy.title
  const modalBody = interpolate(copy.body, { account: label })

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/55" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="broker-connected-success-title"
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 animate-modal-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 dark:bg-teal-950/40 text-teal-600 dark:text-teal-400">
              <CheckCircle2 className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="broker-connected-success-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {modalTitle}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                {modalBody}
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

          <div className="mt-4 flex items-center gap-3 rounded-xl border border-neutral-100 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-800/60">
            {logo ? (
              <img src={logo} alt="" className="h-8 w-8 shrink-0 object-contain" />
            ) : (
              <div className="h-8 w-8 shrink-0 rounded-lg bg-neutral-200 dark:bg-neutral-700" aria-hidden />
            )}
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium text-neutral-900 dark:text-neutral-50">{label}</p>
              <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                {copy.detailLogin}: {broker.account_login || '—'}
                {broker.broker_server ? (
                  <>
                    <span className="mx-1.5 text-neutral-300 dark:text-neutral-600" aria-hidden>·</span>
                    {copy.detailServer}: {broker.broker_server}
                  </>
                ) : null}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" size="sm" onClick={onAddChannel} className="sm:min-w-[8.5rem]">
            {copy.addChannel}
          </Button>
          <Button type="button" size="sm" onClick={onConfigure} className="sm:min-w-[8.5rem]">
            {copy.configure}
          </Button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
