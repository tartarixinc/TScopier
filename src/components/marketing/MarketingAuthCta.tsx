import clsx from 'clsx'
import { ArrowRight } from 'lucide-react'
import { useMarketingAuthState } from '../../hooks/useMarketingAuthState'
import { useT } from '../../context/LocaleContext'
import { appUrl, marketingUrl, withQuery } from '../../lib/site'
import { trackMarketingEvent } from '../../lib/analytics'

type MarketingAuthCtaVariant = 'hero' | 'heroInline' | 'header' | 'headerMobile'

interface MarketingAuthCtaProps {
  variant: MarketingAuthCtaVariant
  onNavigate?: () => void
}

const primaryBtnClass =
  'inline-flex max-w-44 shrink-0 items-center justify-center truncate rounded-full border border-green-400 bg-green-400 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_6px_18px_-8px_rgba(74,222,128,0.7)] transition-all hover:border-green-400 hover:bg-green-400 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_20px_rgba(74,222,128,0.5)] focus:outline-hidden focus:ring-2 focus:ring-green-400 focus:ring-offset-2 xl:max-w-[16rem] xl:text-sm 2xl:max-w-none dark:focus:ring-offset-neutral-950'

const heroCtaClass =
  'group inline-flex w-fit self-center items-center justify-center gap-2 rounded-full border border-green-400 bg-green-400 px-8 py-3.5 text-base font-semibold text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_12px_32px_-10px_rgba(74,222,128,0.7)] transition-all duration-300 hover:-translate-y-0.5 hover:border-green-400 hover:bg-green-400 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_28px_rgba(74,222,128,0.55),0_0_56px_rgba(74,222,128,0.22)] sm:px-10 sm:py-4 sm:text-lg'

/** Left-aligned pill used in the two-column hero (sits next to a secondary button). */
const heroInlineCtaClass =
  'group inline-flex items-center justify-center gap-2 rounded-full border border-green-400 bg-green-400 px-6 py-3 text-sm font-semibold text-neutral-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_10px_28px_-10px_rgba(74,222,128,0.7)] transition-all duration-300 hover:-translate-y-0.5 hover:border-green-400 hover:bg-green-400 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_24px_rgba(74,222,128,0.5)] sm:px-7 sm:py-3.5 sm:text-base'

export function MarketingAuthCta({ variant, onNavigate }: MarketingAuthCtaProps) {
  const { isSignedIn, loading } = useMarketingAuthState()
  const nav = useT().landing.nav
  const hero = useT().landing.hero
  const referralRef = (() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('ref')?.trim() || null
  })()
  const signupHref = withQuery(appUrl('/signup'), { ref: referralRef })
  const loginHref = withQuery(appUrl('/login'), { ref: referralRef })
  // The hero's primary button ("Choose your plan") goes to the pricing page.
  const pricingHref = withQuery(marketingUrl('/pricing'), { ref: referralRef })
  const onCtaClick = (action: 'signup' | 'login' | 'dashboard' | 'pricing') => {
    trackMarketingEvent('marketing_cta_click', {
      action,
      variant,
    })
    onNavigate?.()
  }

  if (loading) {
    if (variant === 'header') {
      return <span className="hidden h-9 w-28 lg:inline-block" aria-hidden />
    }
    return null
  }

  if (isSignedIn) {
    const dashboardLink = (
      <a
        href={appUrl('/dashboard')}
        onClick={() => onCtaClick('dashboard')}
        className={clsx(
          variant === 'hero' && heroCtaClass,
          variant === 'heroInline' && heroInlineCtaClass,
          variant === 'header' && clsx(primaryBtnClass, 'hidden lg:inline-flex'),
          variant === 'headerMobile' &&
            'rounded-lg px-3 py-2.5 text-sm font-medium text-green-400 transition-colors hover:bg-teal-50 dark:text-green-400 dark:hover:bg-teal-950/40',
        )}
        title={variant === 'header' ? nav.dashboard : undefined}
      >
        {nav.dashboard}
        {variant === 'hero' || variant === 'heroInline' ? (
          <ArrowRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        ) : null}
      </a>
    )

    if (variant === 'hero') {
      return (
        <div className="flex w-full flex-col items-center">{dashboardLink}</div>
      )
    }
    return dashboardLink
  }

  if (variant === 'heroInline') {
    return (
      <a href={pricingHref} onClick={() => onCtaClick('pricing')} className={heroInlineCtaClass}>
        {hero.primaryCta}
      </a>
    )
  }

  if (variant === 'hero') {
    return (
      <div className="flex w-full flex-col items-center">
        <a
          href={pricingHref}
          onClick={() => onCtaClick('pricing')}
          className={heroCtaClass}
        >
          {hero.primaryCta}
        </a>
      </div>
    )
  }

  if (variant === 'headerMobile') {
    return (
      <>
        <a
          href={loginHref}
          onClick={() => onCtaClick('login')}
          className="rounded-lg px-3 py-2.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-white/10"
        >
          {nav.signIn}
        </a>
        <a
          href={signupHref}
          onClick={() => onCtaClick('signup')}
          className="mt-1 inline-flex w-full items-center justify-center rounded-lg border border-green-400 bg-green-400 px-3 py-2.5 text-sm font-medium text-neutral-950 transition-colors hover:border-green-500 hover:bg-green-500"
        >
          {nav.getStarted}
        </a>
      </>
    )
  }

  return (
    <>
      <a
        href={loginHref}
        onClick={() => onCtaClick('login')}
        className="hidden whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-900/6 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white xl:inline-block"
      >
        {nav.signIn}
      </a>
      <a
        href={signupHref}
        onClick={() => onCtaClick('signup')}
        className={clsx(primaryBtnClass, 'hidden lg:inline-flex')}
        title={nav.getStarted}
      >
        {nav.getStarted}
      </a>
    </>
  )
}
