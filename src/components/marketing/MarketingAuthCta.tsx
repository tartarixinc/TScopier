import clsx from 'clsx'
import { ArrowRight } from 'lucide-react'
import { useMarketingAuthState } from '../../hooks/useMarketingAuthState'
import { useT } from '../../context/LocaleContext'
import { appUrl } from '../../lib/site'
import { trackMarketingEvent } from '../../lib/analytics'

type MarketingAuthCtaVariant = 'hero' | 'header' | 'headerMobile'

interface MarketingAuthCtaProps {
  variant: MarketingAuthCtaVariant
  onNavigate?: () => void
}

const primaryBtnClass =
  'inline-flex shrink-0 items-center justify-center rounded-lg border border-teal-600 bg-teal-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:border-teal-700 hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-neutral-950'

export function MarketingAuthCta({ variant, onNavigate }: MarketingAuthCtaProps) {
  const { isSignedIn, loading } = useMarketingAuthState()
  const nav = useT().landing.nav
  const hero = useT().landing.hero
  const referralSuffix = (() => {
    if (typeof window === 'undefined') return ''
    const params = new URLSearchParams(window.location.search)
    const ref = params.get('ref')?.trim()
    if (!ref) return ''
    return `?ref=${encodeURIComponent(ref)}`
  })()
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
          variant === 'hero' &&
            'group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-teal-600 bg-teal-600 px-7 py-3.5 text-base font-semibold text-white transition-colors hover:border-teal-700 hover:bg-teal-700 sm:w-auto',
          variant === 'header' && primaryBtnClass,
          variant === 'headerMobile' &&
            'rounded-lg px-3 py-2.5 text-sm font-medium text-teal-600 transition-colors hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-teal-950/40',
        )}
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
      <div className="flex w-full flex-col items-center justify-center gap-3 sm:flex-row">
        <a
          href={`${appUrl('/signup')}${referralSuffix}`}
          onClick={() => onCtaClick('signup')}
          className="group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-teal-600 bg-teal-600 px-7 py-3.5 text-base font-semibold text-white transition-colors hover:border-teal-700 hover:bg-teal-700 sm:w-auto"
        >
          {hero.primaryCta}
        </a>
        <a
          href={`${appUrl('/login')}${referralSuffix}`}
          onClick={() => onCtaClick('login')}
          className="inline-flex w-full items-center justify-center rounded-xl border border-neutral-200 bg-white px-7 py-3.5 text-base font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 sm:w-auto"
        >
          {hero.secondaryCta}
        </a>
      </div>
    )
  }

  if (variant === 'headerMobile') {
    return (
      <>
        <a
          href={`${appUrl('/login')}${referralSuffix}`}
          onClick={() => onCtaClick('login')}
          className="rounded-lg px-3 py-2.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
        >
          {nav.signIn}
        </a>
        <a
          href={`${appUrl('/signup')}${referralSuffix}`}
          onClick={() => onCtaClick('signup')}
          className="mt-1 inline-flex w-full items-center justify-center rounded-lg border border-teal-600 bg-teal-600 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:border-teal-700 hover:bg-teal-700"
        >
          {nav.getStarted}
        </a>
      </>
    )
  }

  return (
    <>
      <a
        href={`${appUrl('/login')}${referralSuffix}`}
        onClick={() => onCtaClick('login')}
        className="hidden text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 lg:inline-block lg:px-3"
      >
        {nav.signIn}
      </a>
      <a
        href={`${appUrl('/signup')}${referralSuffix}`}
        onClick={() => onCtaClick('signup')}
        className={clsx(primaryBtnClass, 'hidden md:inline-flex')}
      >
        {nav.getStarted}
      </a>
    </>
  )
}
