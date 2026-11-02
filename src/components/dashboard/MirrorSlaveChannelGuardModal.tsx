import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { Button } from '../ui/Button'

export interface MirrorSlaveGuardMaster {
  id: string
  label: string
}

type MirrorSlaveChannelGuardModalProps = {
  brokerLabel: string
  masters: MirrorSlaveGuardMaster[]
  onProceed: () => void
  onDisconnectMirror: () => void
  onCancel: () => void
  disconnecting?: boolean
  error?: string | null
}

/**
 * Warns that a broker is already a mirror-trading slave before it is linked
 * to a Telegram channel, so the user can proceed, drop the mirror link, or cancel.
 */
export function MirrorSlaveChannelGuardModal({
  brokerLabel,
  masters,
  onProceed,
  onDisconnectMirror,
  onCancel,
  disconnecting = false,
  error,
}: MirrorSlaveChannelGuardModalProps) {
  const t = useT()
  const guard = t.mirrorSlaveGuard ?? {}
  const title = guard.channelConnectTitle ?? 'Already used in mirror trading'
  const body = guard.channelConnectBody
    ?? 'This account is currently being used in mirror trading as a slave. Connecting it to a channel that the master already copies might lead to duplicate trades.'
  const masterLabel = guard.masterAccountLabel ?? 'Master account'
  const proceedLabel = guard.proceed ?? 'Proceed'
  const disconnectLabel = guard.disconnectMirror ?? 'Disconnect mirror trading'
  const disconnectingLabel = guard.disconnectingMirror ?? 'Disconnecting…'

  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  // Backdrop and Escape stay inert while the disconnect is running, so a stray
  // click cannot cancel the caller while the mirror links are still removed.
  const dismiss = disconnecting ? () => {} : onCancel
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, dismiss)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !disconnecting) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [disconnecting, onCancel])

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-110 flex items-end sm:items-center justify-center p-4 sm:p-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/55" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mirror-slave-guard-title"
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200/65 dark:border-neutral-800/55 animate-modal-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="mirror-slave-guard-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {title}
              </h2>
              <p className="mt-1.5 text-sm text-neutral-900 dark:text-neutral-50 leading-relaxed">
                {body}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-neutral-200/65 dark:border-neutral-800/55 bg-neutral-50/80 dark:bg-neutral-800/40 px-3.5 py-2.5">
            <div className="text-xs font-medium text-neutral-900 dark:text-neutral-50">{brokerLabel}</div>
            {masters.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {masters.map(master => (
                  <li key={master.id} className="text-xs text-neutral-900 dark:text-neutral-50">
                    {masterLabel}: <span className="font-medium">{master.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {error ? (
            <p className="mt-3 text-xs leading-relaxed text-error-600 dark:text-error-300">{error}</p>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disconnecting}
            onClick={onCancel}
            className="sm:min-w-28"
          >
            {t.common.cancel}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            loading={disconnecting}
            onClick={onDisconnectMirror}
            className="sm:min-w-40"
          >
            {disconnecting ? disconnectingLabel : disconnectLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={disconnecting}
            onClick={onProceed}
            className="sm:min-w-28"
          >
            {proceedLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
