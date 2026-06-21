import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { getSubscribeCtaLabel } from '../../lib/subscriptionCta'
import { lossBadgeOutlineClass, lossBannerClass, lossTextClass } from '../../lib/pnlDisplay'
import { Button } from '../ui/Button'

export type UpgradePromptVariant = 'inline' | 'banner' | 'compact'

interface UpgradePromptProps {
  title?: string
  reason: string
  variant?: UpgradePromptVariant
  className?: string
  showManageBilling?: boolean
}

export function UpgradePrompt({
  title,
  reason,
  variant = 'inline',
  className,
  showManageBilling,
}: UpgradePromptProps) {
  const t = useT()
  const pw = t.pricing.paywall
  const { isPastDue, openUpgrade, effectivePlan, hasTrialExpired } = useSubscription()
  const heading = title ?? (isPastDue ? pw.updatePaymentTitle : pw.upgradeTitle)
  const upgradeCta = getSubscribeCtaLabel(t, { isPastDue, effectivePlan, hasTrialExpired })

  const manageBilling = showManageBilling ?? isPastDue

  if (variant === 'banner') {
    return (
      <div
        role="alert"
        className={clsx('rounded-xl border px-4 py-3', lossBannerClass, className)}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className={clsx('text-sm font-semibold', lossTextClass)}>{heading}</p>
            <p className={clsx('mt-0.5 text-sm opacity-90', lossTextClass)}>{reason}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {manageBilling ? (
              <Link
                to="/billing"
                className={clsx(
                  'inline-flex items-center justify-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-sm font-medium shadow-sm transition-all hover:bg-error-50 dark:bg-error-950 dark:hover:bg-error-900',
                  lossBadgeOutlineClass,
                )}
              >
                {pw.manageBilling}
              </Link>
            ) : null}
            <Button size="sm" variant="primary" onClick={() => openUpgrade('advanced')}>
              {upgradeCta}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (variant === 'compact') {
    return (
      <p className={clsx('text-xs text-neutral-500 dark:text-neutral-400', className)}>
        {reason}{' '}
        <button
          type="button"
          onClick={() => openUpgrade('advanced')}
          className="font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400"
        >
          {upgradeCta}
        </button>
      </p>
    )
  }

  return (
    <div
      className={clsx(
        'rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{heading}</p>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{reason}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {manageBilling ? (
            <Link
              to="/billing"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm transition-all hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              {pw.manageBilling}
            </Link>
          ) : null}
          <Button size="sm" onClick={() => openUpgrade('advanced')}>
            {upgradeCta}
          </Button>
        </div>
      </div>
    </div>
  )
}
