import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { CreditCard } from 'lucide-react'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'

interface PastDueSubscriptionBannerProps {
  className?: string
}

/** Dashboard alert when Stripe reports a failed subscription payment. */
export function PastDueSubscriptionBanner({ className }: PastDueSubscriptionBannerProps) {
  const t = useT()
  const d = t.dashboard
  const pw = t.pricing.paywall
  const { loading, isPastDue } = useSubscription()

  if (loading || !isPastDue) return null

  const title = d.pastDuePaymentTitle ?? pw.updatePaymentTitle
  const body = d.pastDuePaymentBody ?? pw.updatePaymentReason
  const cta = d.payInvoices ?? pw.manageBilling

  return (
    <div
      role="alert"
      className={clsx(
        'rounded-xl border border-error-200 bg-error-50 px-4 py-3 dark:border-error-800 dark:bg-error-950/40',
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <CreditCard
            className="mt-0.5 h-5 w-5 shrink-0 text-error-600 dark:text-error-400"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold text-error-900 dark:text-error-100">{title}</p>
            <p className="mt-0.5 text-sm text-error-800/90 dark:text-error-200/80">{body}</p>
          </div>
        </div>
        <Link
          to="/billing"
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-error-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-error-700 focus:outline-none focus:ring-2 focus:ring-error-500 focus:ring-offset-2 focus:ring-offset-error-50 dark:focus:ring-offset-error-950"
        >
          {cta}
        </Link>
      </div>
    </div>
  )
}
