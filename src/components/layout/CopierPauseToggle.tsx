import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { useCopierStartBlocked } from '../../hooks/useCopierStartBlocked'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { Button } from '../ui/Button'
import { CopierActiveIndicator } from './CopierActiveIndicator'
import { CopierStoppedIndicator } from './CopierStoppedIndicator'

interface CopierPauseToggleProps {
  className?: string
}

export function CopierPauseToggle({ className }: CopierPauseToggleProps) {
  const t = useT()
  const cp = t.nav.copierPause
  const { copierPaused, patchProfile, persistProfile, refreshProfile } = useUserProfile()
  const { isPastDue } = useSubscription()
  const pw = t.pricing.paywall
  const d = t.dashboard
  const { copierStartBlocked, copierStartBlockedReason, resolving: startBlockedResolving } =
    useCopierStartBlocked()
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(
    overlayRef,
    backdropRef,
    () => { if (!saving) setConfirmOpen(false) },
  )

  const lockedStopped = copierStartBlocked && !startBlockedResolving
  const showStopped = lockedStopped || copierPaused
  const stoppedHint = lockedStopped
    ? (copierStartBlockedReason === 'subscription'
      ? (isPastDue
        ? (d.pastDuePaymentBody ?? pw.updatePaymentReason)
        : (cp.stoppedHintSubscription ?? cp.statusCopierStopped ?? 'Copier Stopped'))
      : (cp.stoppedHintSetup ?? cp.statusCopierStopped ?? 'Copier Stopped'))
    : cp.pausedHint

  const setPaused = useCallback(async (next: boolean) => {
    if (saving || lockedStopped) return
    setSaving(true)
    patchProfile({ copier_paused: next })
    try {
      await persistProfile({ copier_paused: next })
    } catch {
      await refreshProfile()
    } finally {
      setSaving(false)
    }
  }, [lockedStopped, patchProfile, persistProfile, refreshProfile, saving])

  const confirmPause = useCallback(async () => {
    await setPaused(true)
    setConfirmOpen(false)
  }, [setPaused])

  const handleButtonClick = useCallback(() => {
    if (saving || lockedStopped) return
    if (copierPaused) {
      void setPaused(false)
      return
    }
    setConfirmOpen(true)
  }, [copierPaused, lockedStopped, saving, setPaused])

  useEffect(() => {
    if (!confirmOpen) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) setConfirmOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [confirmOpen, saving])

  useEffect(() => {
    if (!confirmOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [confirmOpen])

  const stoppedLabel = lockedStopped
    ? (cp.statusCopierStopped ?? 'Copier Stopped')
    : (cp.statusPaused ?? cp.statusStopped)

  const confirmModal = confirmOpen ? (
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
        aria-labelledby="copier-pause-confirm-title"
        className="relative w-full max-w-md rounded-2xl bg-white dark:bg-neutral-900 shadow-2xl border border-neutral-200 dark:border-neutral-800 animate-modal-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300">
              <Pause className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="copier-pause-confirm-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {cp.confirmTitle}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 leading-relaxed">
                {cp.confirmBody}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => setConfirmOpen(false)}
            className="sm:min-w-[7rem]"
          >
            {t.common.cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            loading={saving}
            onClick={() => void confirmPause()}
            className="sm:min-w-[7rem]"
          >
            {cp.pauseLabel}
          </Button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <>
      <button
        type="button"
        onClick={handleButtonClick}
        disabled={saving || lockedStopped}
        aria-pressed={showStopped}
        aria-disabled={lockedStopped || undefined}
        aria-label={
          lockedStopped
            ? `${cp.statusCopierStopped ?? 'Copier Stopped'}. ${stoppedHint}`
            : showStopped
              ? `${stoppedLabel}. ${cp.resumeLabel}`
              : `${cp.statusRunning}. ${cp.stopCopier}`
        }
        title={showStopped ? stoppedHint : cp.stopCopier}
        className={clsx(
          'group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 sm:gap-2 sm:px-2.5 sm:text-sm',
          lockedStopped
            ? 'cursor-not-allowed text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40'
            : showStopped
              ? 'text-teal-700 bg-teal-50 hover:bg-teal-100 dark:text-teal-300 dark:bg-teal-950/40 dark:hover:bg-teal-950/60'
              : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:text-neutral-50 dark:hover:bg-neutral-800',
          className,
        )}
      >
        {showStopped ? (
          <>
            {lockedStopped ? (
              <CopierStoppedIndicator />
            ) : (
              <Play className="h-4 w-4 shrink-0 sm:h-[1.125rem] sm:w-[1.125rem]" aria-hidden />
            )}
            <span className="whitespace-nowrap">{stoppedLabel}</span>
          </>
        ) : (
          <>
            <span className="shrink-0 group-hover:hidden">
              <CopierActiveIndicator />
            </span>
            <Pause
              className="hidden h-4 w-4 shrink-0 group-hover:block sm:h-[1.125rem] sm:w-[1.125rem]"
              aria-hidden
            />
            <span className="whitespace-nowrap group-hover:hidden">{cp.statusRunning}</span>
            <span className="hidden whitespace-nowrap group-hover:inline">{cp.stopCopier}</span>
          </>
        )}
      </button>

      {confirmModal ? createPortal(confirmModal, document.body) : null}
    </>
  )
}
