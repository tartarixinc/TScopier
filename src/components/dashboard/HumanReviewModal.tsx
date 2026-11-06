import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, ShieldAlert, X } from 'lucide-react'
import { useHumanReview } from '../../context/HumanReviewContext'
import {
  formatReviewRemaining,
  reviewRemainingMs,
} from '../../lib/humanReview'

/** Auto-opens when an AI signal is escalated for review. Informational only —
 * approve/dismiss happen on the Live Trades page. */
export function HumanReviewModal() {
  const { pending, isOpen, closeModal } = useHumanReview()
  const navigate = useNavigate()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isOpen) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isOpen])

  useEffect(() => {
    if (isOpen && pending.length === 0) closeModal()
  }, [isOpen, pending.length, closeModal])

  if (!isOpen) return null

  const item = pending[0]
  if (!item) return null

  const remainingMs = reviewRemainingMs(item.signal.created_at, now)
  const expired = remainingMs <= 0

  const handleGo = () => {
    closeModal()
    navigate('/account-trades')
  }

  return (
    <div className="fixed inset-0 z-70 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div
        className="absolute inset-0 bg-neutral-950/55"
        aria-hidden
        onClick={closeModal}
      />
      <div className="relative w-full sm:max-w-md overflow-hidden rounded-t-3xl sm:rounded-3xl border border-amber-200 dark:border-amber-800/70 bg-white shadow-2xl dark:bg-neutral-900">
        <div className="flex items-center gap-3 border-b border-amber-100 bg-amber-50 px-5 py-4 dark:border-amber-900/50 dark:bg-amber-950/40">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
              Signal review required
            </h2>
            <p className={`mt-0.5 text-sm font-semibold tabular-nums ${expired ? 'text-amber-600 dark:text-amber-400' : 'text-amber-700 dark:text-amber-300'}`}>
              {expired ? 'expired — approval window passed' : formatReviewRemaining(remainingMs)}
            </p>
          </div>
          <button
            type="button"
            onClick={closeModal}
            aria-label="Close"
            className="rounded-xl p-2 text-neutral-900 dark:text-neutral-50 hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5">
          <p className="text-sm text-neutral-900 dark:text-neutral-50">
            A signal from your channel was escalated because the AI wasn't sure about
            it. Review it on the Live Trades page to approve or dismiss it before the
            window closes.
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={handleGo}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
            >
              Go to Live Trades
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={closeModal}
              className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-50 dark:hover:bg-neutral-800"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
