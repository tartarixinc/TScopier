import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { UpgradePrompt } from './UpgradePrompt'
import { PastDueSubscriptionBanner } from './PastDueSubscriptionBanner'

/** Top-of-dashboard banner when the user has no active subscription or is past due. */
export function SubscriptionBanner() {
  const t = useT()
  const pw = t.pricing.paywall
  const { loading, hasActiveSubscription, isPastDue } = useSubscription()

  if (loading) return null
  if (isPastDue) return <PastDueSubscriptionBanner className="mb-6" />
  if (hasActiveSubscription) return null

  return (
    <UpgradePrompt
      variant="banner"
      title={pw.noPlanTitle}
      reason={pw.noPlanReason}
      className="mb-6"
    />
  )
}
