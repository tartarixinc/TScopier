import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'

export function isSubscriptionRequiredError(message: string, localizedLabel: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  if (trimmed === localizedLabel) return true
  return /active subscription is required/i.test(trimmed)
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
  const { openUpgrade, isPastDue } = useSubscription()
  const upgradeLabel = isPastDue ? pw.updatePayment : pw.upgradeCta

  if (!isSubscriptionRequiredError(message, pw.subscriptionRequired)) {
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
