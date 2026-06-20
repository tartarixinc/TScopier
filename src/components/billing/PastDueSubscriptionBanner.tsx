import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { CreditCard } from 'lucide-react'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'

interface PastDueSubscriptionBannerProps {
  className?: string
}

/** Dashboard warning when Stripe reports a failed subscription payment. */
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
      className={clsx(
        'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/30',
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <CreditCard
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">{title}</p>
            <p className="mt-0.5 text-sm text-amber-800/90 dark:text-amber-200/80">{body}</p>
          </div>
        </div>
        <Link
          to="/billing"
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 focus:ring-offset-amber-50 dark:focus:ring-offset-amber-950"
        >
          {cta}
        </Link>
      </div>
    </div>
  )
}
