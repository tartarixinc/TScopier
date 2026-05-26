import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { UpgradePrompt } from './UpgradePrompt'

/** Top-of-dashboard banner when the user has no active subscription or is past due. */
export function SubscriptionBanner() {
  const t = useT()
  const pw = t.pricing.paywall
  const { loading, hasActiveSubscription, isPastDue } = useSubscription()

  if (loading || (hasActiveSubscription && !isPastDue)) return null

  return (
    <UpgradePrompt
      variant="banner"
      title={isPastDue ? pw.updatePaymentTitle : pw.noPlanTitle}
      reason={isPastDue ? pw.updatePaymentReason : pw.noPlanReason}
      showManageBilling={isPastDue}
      className="mb-6"
    />
  )
}
