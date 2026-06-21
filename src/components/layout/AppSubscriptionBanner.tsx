import { CreditCard } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { getSubscribeCtaLabel } from '../../lib/subscriptionCta'

const linkClassName =
  'font-semibold underline underline-offset-2 decoration-error-400/80 hover:opacity-80'

/** Red subscription bar when the signed-in user has no active plan (all app routes). */
export function AppSubscriptionBanner() {
  const t = useT()
  const { user } = useAuth()
  const {
    hasActiveSubscription,
    subscriptionLoading,
    openUpgrade,
    isPastDue,
    effectivePlan,
    hasTrialExpired,
  } = useSubscription()
  const subscribeCta = getSubscribeCtaLabel(t, {
    isPastDue,
    effectivePlan,
    hasTrialExpired,
  })

  if (!user || subscriptionLoading || hasActiveSubscription) {
    return null
  }

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-error-200 bg-error-50 px-3 py-2.5 text-center text-sm text-[#737373] dark:border-error-900/60 dark:bg-error-950/40 sm:px-6"
    >
      <CreditCard className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
      <p className="min-w-0 font-medium leading-snug">
        <span>{t.pricing.billing.noSubscriptionHeaderBanner}</span>
        {' '}
        <button
          type="button"
          onClick={() => openUpgrade('advanced')}
          className={linkClassName}
        >
          {subscribeCta}
        </button>
      </p>
    </div>
  )
}
