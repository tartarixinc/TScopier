import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { getSubscribeCtaLabel } from '../../lib/subscriptionCta'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'

export function isSubscriptionRequiredError(message: string, localizedLabel: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  if (trimmed === localizedLabel) return true
  return /active subscription is required/i.test(trimmed)
}

/** True when the error should show an upgrade CTA (subscription required or plan limits). */
export function shouldShowPaywallUpgradeCta(message: string, subscriptionRequiredLabel: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  if (isSubscriptionRequiredError(trimmed, subscriptionRequiredLabel)) return true
  if (/upgrade to advanced/i.test(trimmed)) return true
  if (/upgrade for unlimited/i.test(trimmed)) return true
  return false
}

interface PaywallErrorAlertProps {
  message: string
  className?: string
  variant?: 'error' | 'warning'
}

/** Error alert with an upgrade CTA on the right when the message is subscription-related. */
export function PaywallErrorAlert({ message, className, variant = 'error' }: PaywallErrorAlertProps) {
  const t = useT()
  const pw = t.pricing.paywall
  const { openUpgrade, isPastDue, effectivePlan, hasTrialExpired } = useSubscription()
  const upgradeLabel = getSubscribeCtaLabel(t, { isPastDue, effectivePlan, hasTrialExpired })

  if (!shouldShowPaywallUpgradeCta(message, pw.subscriptionRequired)) {
    return (
      <Alert variant={variant} className={className}>
        {message}
      </Alert>
    )
  }

  return (
    <Alert
      variant={variant}
      className={clsx(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
    >
      <span className="min-w-0 flex-1">{message}</span>
      <Button
        type="button"
        size="sm"
        className="w-full shrink-0 sm:w-auto"
        onClick={() => openUpgrade('advanced')}
      >
        {upgradeLabel}
      </Button>
    </Alert>
  )
}
