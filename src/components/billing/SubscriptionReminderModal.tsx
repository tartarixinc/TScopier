import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, X } from 'lucide-react'
import { useSubscription } from '../../context/SubscriptionContext'
import { useAuth } from '../../context/AuthContext'
import { Button } from '../ui/Button'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'

const DISMISSED_KEY = 'tsc_sub_reminder_dismissed'
const DISMISS_DURATION_MS = 1000 * 60 * 60 * 4 // re-show after 4 hours

function wasDismissedRecently(): boolean {
  try {
    const ts = window.sessionStorage.getItem(DISMISSED_KEY)
    if (!ts) return false
    return Date.now() - Number(ts) < DISMISS_DURATION_MS
  } catch {
    return false
  }
}

function markDismissed() {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch { /* noop */ }
}

/**
 * Shows once per session (per 4 hours) on the dashboard when the user has no
 * active subscription. Offers "Start your 5-day free trial" (if never trialed)
 * or "Subscribe now", plus "View pricing".
 */
export function SubscriptionReminderModal() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const {
    subscription,
    hasActiveSubscription,
    loading,
    checkoutSyncPending,
    isAdmin,
  } = useSubscription()

  const [open, setOpen] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)

  const close = () => {
    markDismissed()
    setOpen(false)
  }

  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, close)

  useEffect(() => {
    if (loading || checkoutSyncPending || !user) return
    if (isAdmin || hasActiveSubscription) return
    if (wasDismissedRecently()) return
    const timer = window.setTimeout(() => setOpen(true), 600)
    return () => window.clearTimeout(timer)
  }, [loading, checkoutSyncPending, user, isAdmin, hasActiveSubscription])

  if (!open) return null

  const neverTrialed = !subscription?.trial_ends_at

  const handlePrimary = () => {
    close()
    if (neverTrialed) {
      navigate('/pricing?startCheckout=1')
    } else {
      navigate('/pricing')
    }
  }

  const handleViewPricing = () => {
    close()
    navigate('/pricing')
  }

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-4 sm:p-6"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/50" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sub-reminder-title"
        className="relative w-full max-w-md rounded-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-900 animate-modal-in overflow-hidden"
      >
        <button
          type="button"
          onClick={close}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:text-neutral-200 dark:hover:bg-neutral-800 transition-colors"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="px-6 py-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-950/40">
            <AlertTriangle className="h-8 w-8 text-amber-600 dark:text-amber-400" />
          </div>

          <h2
            id="sub-reminder-title"
            className="text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50"
          >
            No active subscription
          </h2>
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            Copying signals requires an active subscription.
          </p>

          <div className="mt-8 flex flex-col gap-3">
            <Button
              size="lg"
              variant="primary"
              className="w-full"
              onClick={handlePrimary}
            >
              {neverTrialed ? 'Start your 5-day free trial' : 'Subscribe now'}
            </Button>

            <Button
              size="lg"
              variant="secondary"
              className="w-full"
              onClick={handleViewPricing}
            >
              View pricing
            </Button>
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
