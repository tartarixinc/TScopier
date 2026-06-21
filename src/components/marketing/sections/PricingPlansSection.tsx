import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Check, Zap } from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import { useAuth } from '../../../context/AuthContext'
import { useSubscription } from '../../../context/SubscriptionContext'
import { interpolate } from '../../../i18n/interpolate'
import { appUrl } from '../../../lib/site'
import { HELP_LINKS } from '../../../lib/helpLinks'
import { startPlanCheckout } from '../../../lib/planCheckout'
import { Button } from '../../ui/Button'
import {
  PRICING_ADVANCED_INCLUDED_ACCOUNTS,
  pricingDisplayPrices,
} from '../../../lib/pricingPlans'

interface PricingPlansSectionProps {
  variant?: 'marketing' | 'app'
}

export function PricingPlansSection({ variant = 'marketing' }: PricingPlansSectionProps) {
  const t = useT()
  const lp = t.landing.pricing
  const pt = t.pricing
  const [interval, setInterval] = useState<'monthly' | 'annual'>('monthly')
  const [extraAccounts, setExtraAccounts] = useState(0)

  const { session } = useAuth()
  const { effectivePlan } = useSubscription()
  const [checkoutLoading, setCheckoutLoading] = useState<'basic' | 'advanced' | null>(null)
  const [checkoutError, setCheckoutError] = useState('')

  const isApp = variant === 'app'
  const isAnnual = interval === 'annual'
  const prices = pricingDisplayPrices(interval, extraAccounts)

  const formatMoney = (amount: number) => `$${amount.toFixed(2)}`

  const contactHref = isApp
    ? HELP_LINKS.telegram || '/contact-support'
    : HELP_LINKS.telegram || appUrl('/contact-support')

  const startCheckout = async (plan: 'basic' | 'advanced') => {
    if (!session?.access_token || effectivePlan === plan) return
    setCheckoutError('')
    setCheckoutLoading(plan)
    try {
      const url = await startPlanCheckout({
        accessToken: session.access_token,
        plan,
        interval,
        extraAccounts: plan === 'advanced' ? extraAccounts : 0,
        cancelUrl: `${window.location.origin}/pricing`,
      })
      window.location.href = url
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : pt.checkoutFailed)
      setCheckoutLoading(null)
    }
  }

  const sectionClass = clsx(
    'mx-auto max-w-6xl scroll-mt-28',
    isApp ? 'px-0 py-4 sm:py-6' : 'px-5 py-16 sm:px-8 sm:py-24',
  )

  return (
    <section className={sectionClass}>
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {lp.title}
        </h1>
        <p className="mt-3 text-base text-neutral-500 dark:text-neutral-400">{lp.subtitle}</p>

        {checkoutError ? (
          <div
            role="alert"
            className="mx-auto mt-4 max-w-lg rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {checkoutError}
          </div>
        ) : null}

        <div className="mt-8 inline-flex items-center rounded-full border border-neutral-200 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-900">
          <button
            type="button"
            onClick={() => setInterval('monthly')}
            className={clsx(
              'rounded-full px-5 py-2 text-sm font-medium transition-all',
              !isAnnual
                ? 'bg-teal-600 text-white shadow-sm'
                : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
            )}
          >
            {pt.monthly}
          </button>
          <button
            type="button"
            onClick={() => setInterval('annual')}
            className={clsx(
              'rounded-full px-5 py-2 text-sm font-medium transition-all',
              isAnnual
                ? 'bg-teal-600 text-white shadow-sm'
                : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
            )}
          >
            {pt.annual}
            <span className="ml-2 inline-block rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-400">
              {pt.save20}
            </span>
          </button>
        </div>
      </div>

      <div className="mt-12 grid gap-8 lg:grid-cols-3">
        <div className="relative rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{pt.basic.name}</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{pt.basic.description}</p>
          </div>

          <div className="mb-1">
            <span className="text-4xl font-bold text-neutral-900 dark:text-neutral-50">
              {formatMoney(prices.basicMonthly)}
            </span>
            <span className="text-base text-neutral-500 dark:text-neutral-400">{pt.perMonth}</span>
          </div>
          {isAnnual ? (
            <p className="mb-6 text-xs text-neutral-400 dark:text-neutral-500">
              {pt.billedAnnually} {formatMoney(prices.basicAnnualTotal)}
              {pt.perYear}
            </p>
          ) : (
            <div className="mb-6" />
          )}

          {isApp ? (
            <Button
              size="lg"
              className="w-full"
              loading={checkoutLoading === 'basic'}
              disabled={checkoutLoading !== null || effectivePlan === 'basic'}
              onClick={() => void startCheckout('basic')}
            >
              {effectivePlan === 'basic' ? pt.billing.currentPlan : pt.subscribe}
            </Button>
          ) : (
            <a
              href={appUrl('/signup')}
              className="inline-flex w-full items-center justify-center rounded-xl bg-teal-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-700"
            >
              {pt.subscribe}
            </a>
          )}

          <div className="mt-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              {pt.features}
            </p>
            <ul className="mt-4 space-y-3">
              {pt.basicFeatures.map((feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-500" aria-hidden />
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="relative rounded-2xl border-2 border-teal-500 bg-white p-8 shadow-md dark:bg-neutral-900 lg:-mt-2 lg:mb-2">
          <div className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-teal-500 px-3 py-1 text-xs font-semibold text-white">
            <Zap className="h-3 w-3" aria-hidden />
            {pt.popular}
          </div>

          <div className="mb-6">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{pt.advanced.name}</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{pt.advanced.description}</p>
          </div>

          <div className="mb-1">
            <span className="text-4xl font-bold text-neutral-900 dark:text-neutral-50">
              {formatMoney(prices.advancedMonthly)}
            </span>
            <span className="text-base text-neutral-500 dark:text-neutral-400">{pt.perMonth}</span>
          </div>
          {isAnnual ? (
            <p className="mb-4 text-xs text-neutral-400 dark:text-neutral-500">
              {pt.billedAnnually} {formatMoney(prices.advancedAnnualTotal)}
              {pt.perYear}
            </p>
          ) : (
            <div className="mb-4" />
          )}

          <div className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-left">
                <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                  {pt.extraAccountLabel}
                </p>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">
                  {isAnnual ? pt.extraAccountUnitAnnual : pt.extraAccountUnit}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExtraAccounts((v) => Math.max(0, v - 1))}
                  disabled={extraAccounts === 0 || (isApp && checkoutLoading !== null)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-300 text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
                >
                  −
                </button>
                <input
                  type="number"
                  min={0}
                  max={95}
                  value={extraAccounts}
                  onChange={(e) =>
                    setExtraAccounts(Math.max(0, Math.min(95, Number(e.target.value) || 0)))
                  }
                  className="h-8 w-14 rounded-md border border-neutral-300 bg-white text-center text-sm font-medium text-neutral-900 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-50"
                  aria-label={pt.extraAccountLabel}
                />
                <button
                  type="button"
                  onClick={() => setExtraAccounts((v) => Math.min(95, v + 1))}
                  disabled={extraAccounts >= 95 || (isApp && checkoutLoading !== null)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-300 text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
                >
                  +
                </button>
              </div>
            </div>
            {extraAccounts > 0 ? (
              <p className="mt-2 text-left text-xs text-neutral-500 dark:text-neutral-400">
                {interpolate(pt.extraAccountsSummary, {
                  included: String(PRICING_ADVANCED_INCLUDED_ACCOUNTS),
                  extra: String(extraAccounts),
                  total: String(PRICING_ADVANCED_INCLUDED_ACCOUNTS + extraAccounts),
                })}
              </p>
            ) : null}
          </div>

          {isApp ? (
            <Button
              size="lg"
              className="w-full"
              loading={checkoutLoading === 'advanced'}
              disabled={checkoutLoading !== null || effectivePlan === 'advanced'}
              onClick={() => void startCheckout('advanced')}
            >
              {effectivePlan === 'advanced' ? pt.billing.currentPlan : pt.startTrial}
            </Button>
          ) : (
            <a
              href={appUrl('/signup')}
              className="inline-flex w-full items-center justify-center rounded-xl bg-teal-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-700"
            >
              {pt.startTrial}
            </a>
          )}
          <p className="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500">{pt.trialDays}</p>

          <div className="mt-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              {pt.features}
            </p>
            <ul className="mt-4 space-y-3">
              {pt.advancedFeatures.map((feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-500" aria-hidden />
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="relative rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{pt.custom.name}</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{pt.custom.description}</p>
          </div>

          <div className="mb-6">
            <span className="text-4xl font-bold text-neutral-900 dark:text-neutral-50">{pt.contactUs}</span>
          </div>

          {isApp && !HELP_LINKS.telegram ? (
            <Link
              to={contactHref}
              className="inline-flex w-full items-center justify-center rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
            >
              {pt.contactSales}
            </Link>
          ) : (
            <a
              href={contactHref}
              {...(HELP_LINKS.telegram ? { target: '_blank', rel: 'noopener noreferrer' } : undefined)}
              className="inline-flex w-full items-center justify-center rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
            >
              {pt.contactSales}
            </a>
          )}

          <div className="mt-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              {pt.features}
            </p>
            <ul className="mt-4 space-y-3">
              {pt.customFeatures.map((feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-500" aria-hidden />
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
