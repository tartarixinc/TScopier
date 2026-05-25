import clsx from 'clsx'
import { Zap } from 'lucide-react'
import { GlassCard } from '../GlassCard'
import { useT } from '../../../context/LocaleContext'
import { appUrl } from '../../../lib/site'

export function PricingTeaserSection() {
  const l = useT().landing.pricing
  const plans = [
    { key: 'basic' as const, popular: false },
    { key: 'advanced' as const, popular: true },
  ]

  return (
    <section id="pricing" className="mx-auto max-w-6xl scroll-mt-28 px-5 py-16 sm:px-8 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
          {l.title}
        </h2>
        <p className="mt-4 text-neutral-600 dark:text-neutral-400">{l.subtitle}</p>
      </div>
      <div className="mt-12 grid gap-8 lg:grid-cols-2">
        {plans.map(({ key, popular }) => {
          const plan = l[key]
          return (
            <GlassCard
              key={key}
              variant="pricing"
              className={clsx(
                'relative',
                popular && 'border-2 border-teal-600 dark:border-teal-500',
              )}
            >
              {popular ? (
                <div className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-teal-500 px-3 py-1 text-xs font-semibold text-white">
                  <Zap className="h-3 w-3" aria-hidden />
                  {l.popular}
                </div>
              ) : null}
              <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {plan.name}
              </h3>
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                {plan.description}
              </p>
              <div className="mt-6">
                <span className="text-4xl font-bold text-neutral-900 dark:text-neutral-50">
                  {plan.priceLabel}
                </span>
                <span className="text-neutral-500 dark:text-neutral-400">{l.perMonth}</span>
              </div>
              <a
                href={appUrl('/signup')}
                className={clsx(
                  'mt-8 inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition-colors',
                  popular
                    ? 'bg-teal-600 text-white hover:bg-teal-700'
                    : 'border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700',
                )}
              >
                {plan.cta}
              </a>
            </GlassCard>
          )
        })}
      </div>
      <p className="mt-10 text-center">
        <a
          href={appUrl('/pricing')}
          className="text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
        >
          {l.viewPlans} →
        </a>
      </p>
    </section>
  )
}
