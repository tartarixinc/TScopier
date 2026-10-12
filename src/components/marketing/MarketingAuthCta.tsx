import clsx from 'clsx'
import { ArrowRight } from 'lucide-react'
import { useMarketingAuthState } from '../../hooks/useMarketingAuthState'
import { useT } from '../../context/LocaleContext'
import { appUrl, withQuery } from '../../lib/site'
import { trackMarketingEvent } from '../../lib/analytics'

type MarketingAuthCtaVariant = 'hero' | 'header' | 'headerMobile'

interface MarketingAuthCtaProps {
  variant: MarketingAuthCtaVariant
  onNavigate?: () => void
}

const primaryBtnClass =
  'inline-flex max-w-[11rem] shrink-0 items-center justify-center truncate rounded-lg border border-green-400 bg-green-400 px-2.5 py-1.5 text-xs font-medium text-neutral-950 transition-colors hover:border-green-500 hover:bg-green-500 focus:outline-none focus:ring-2 focus:ring-green-400 focus:ring-offset-2 xl:max-w-[16rem] xl:px-3 xl:text-sm 2xl:max-w-none dark:focus:ring-offset-neutral-950'

const heroCtaClass =
  'group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-green-400 bg-green-400 px-9 py-4 text-lg font-semibold text-neutral-950 shadow-lg shadow-green-400/25 transition-all duration-300 hover:border-green-400 hover:bg-green-400 hover:shadow-[0_0_28px_rgba(74,222,128,0.55),0_0_56px_rgba(74,222,128,0.22)] sm:w-auto sm:px-11 sm:py-5 sm:text-xl'

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
  const onCtaClick = (action: 'signup' | 'login' | 'dashboard') => {
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
          variant === 'header' && clsx(primaryBtnClass, 'hidden lg:inline-flex'),
          variant === 'headerMobile' &&
            'rounded-lg px-3 py-2.5 text-sm font-medium text-green-400 transition-colors hover:bg-teal-50 dark:text-green-400 dark:hover:bg-teal-950/40',
        )}
        title={variant === 'header' ? nav.dashboard : undefined}
      >
        {nav.dashboard}
        {variant === 'hero' ? (
          <ArrowRight
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        ) : null}
      </a>
    )

    if (variant === 'hero') {
      return (
        <div className="flex w-full flex-col items-center justify-center">{dashboardLink}</div>
      )
    }
    return dashboardLink
  }

  if (variant === 'hero') {
    return (
      <div className="flex w-full flex-col items-center justify-center">
        <a
          href={signupHref}
          onClick={() => onCtaClick('signup')}
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
        className="hidden whitespace-nowrap text-sm font-medium text-neutral-900 transition-colors hover:text-neutral-900 dark:text-neutral-50 dark:hover:text-neutral-100 xl:inline-block xl:px-3"
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
