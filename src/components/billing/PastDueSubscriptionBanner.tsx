import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { CreditCard } from 'lucide-react'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { lossBannerClass, lossBarClass, lossTextClass } from '../../lib/pnlDisplay'

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
      className={clsx('rounded-xl border px-4 py-3', lossBannerClass, className)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <CreditCard
            className={clsx('mt-0.5 h-5 w-5 shrink-0', lossTextClass)}
            aria-hidden
          />
          <div>
            <p className={clsx('text-sm font-semibold', lossTextClass)}>{title}</p>
            <p className={clsx('mt-0.5 text-sm opacity-90', lossTextClass)}>{body}</p>
          </div>
        </div>
        <Link
          to="/billing"
          className={clsx(
            'inline-flex shrink-0 items-center justify-center rounded-lg px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#737373] focus:ring-offset-2',
            lossBarClass,
          )}
        >
          {cta}
        </Link>
      </div>
    </div>
  )
}
