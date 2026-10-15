import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import { TscopierLogo } from '../ui/TscopierLogo'
import { ThemeToggle } from '../ui/ThemeToggle'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { useLocale, useT } from '../../context/LocaleContext'
import { HELP_LINKS } from '../../lib/helpLinks'
import { marketingUrl } from '../../lib/site'
import { MarketingAuthCta } from './MarketingAuthCta'
import { MarketingProductMenu, MarketingProductMenuMobile } from './MarketingProductMenu'

type NavItemKey = 'product' | 'features' | 'pricing' | 'faq' | 'docs'

type NavItem = {
  key: NavItemKey
  href: string
  external?: boolean
}

function marketingNavItems(): NavItem[] {
  return [
    { key: 'product', href: '#product' },
    { key: 'features', href: '#features' },
    { key: 'pricing', href: marketingUrl('/pricing') },
    { key: 'faq', href: '#faq' },
    { key: 'docs', href: HELP_LINKS.documentation, external: true },
  ]
}

function MarketingNavLink({
  item,
  label,
  className,
  onClick,
}: {
  item: NavItem
  label: string
  className: string
  onClick?: () => void
}) {
  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={onClick}
      >
        {label}
      </a>
    )
  }

  if (item.href.startsWith('/')) {
    return (
      <Link to={item.href} className={className} onClick={onClick}>
        {label}
      </Link>
    )
  }

  return (
    <a href={item.href} className={className} onClick={onClick}>
      {label}
    </a>
  )
}

/** At the top of the page the bar is invisible; it keeps the same footprint so nothing shifts on scroll. */
const GLASS_BAR =
  'border border-transparent bg-transparent shadow-none backdrop-blur-none'
const GLASS_BAR_SCROLLED =
  'border border-white/80 bg-white/80 shadow-[0_10px_40px_rgba(15,23,42,0.12)] backdrop-blur-2xl dark:border-white/10 dark:bg-neutral-950/70 dark:shadow-[0_10px_40px_rgba(0,0,0,0.55)]'

export function MarketingHeader() {
  const l = useT().landing.nav
  const { auth } = useLocale()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  // Close the drawer when the viewport can show the desktop nav (avoids stuck open state).
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => {
      if (mq.matches) setMobileOpen(false)
    }
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Floating bar firms up once the page moves under it.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const closeMobile = () => setMobileOpen(false)

  const desktopLinkClass =
    'whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-900/[0.06] hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white'
  const mobileLinkClass =
    'rounded-xl px-3 py-2.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-900/[0.06] dark:text-neutral-50 dark:hover:bg-white/10'

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4">
      <div
        className={clsx(
          'pointer-events-auto relative mx-auto flex h-14 max-w-6xl items-center gap-2 rounded-full ps-4 pe-2 transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300 sm:ps-5 lg:gap-4',
          scrolled ? GLASS_BAR_SCROLLED : GLASS_BAR,
        )}
      >
        <Link
          to="/"
          className="flex shrink-0 items-center"
          aria-label="UniCopier home"
          onClick={closeMobile}
        >
          <TscopierLogo className="h-8 w-auto sm:h-9" />
        </Link>

        <nav
          className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 lg:flex"
          aria-label="Main"
        >
          {marketingNavItems().map(item =>
            item.key === 'product' ? (
              <MarketingProductMenu key={item.key} triggerClassName={desktopLinkClass} />
            ) : (
              <MarketingNavLink
                key={item.key}
                item={item}
                label={l[item.key]}
                className={desktopLinkClass}
              />
            ),
          )}
        </nav>

        <div className="ms-auto flex shrink-0 items-center gap-1 lg:ms-0">
          <LanguageSwitcher />
          <ThemeToggle className="rounded-full" />
          <MarketingAuthCta variant="header" />
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-neutral-900 transition-colors hover:bg-neutral-900/[0.06] lg:hidden dark:text-neutral-50 dark:hover:bg-white/10"
            aria-expanded={mobileOpen}
            aria-controls="marketing-mobile-nav"
            aria-label={mobileOpen ? l.menuClose : l.menuOpen}
            onClick={() => setMobileOpen(open => !open)}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav
          id="marketing-mobile-nav"
          className={clsx(
            'pointer-events-auto mx-auto mt-2 flex max-w-6xl flex-col gap-1 rounded-3xl px-3 py-3 lg:hidden',
            GLASS_BAR_SCROLLED,
          )}
          aria-label="Main mobile"
        >
          {marketingNavItems().map(item =>
            item.key === 'product' ? (
              <MarketingProductMenuMobile key={item.key} linkClassName={mobileLinkClass} onNavigate={closeMobile} />
            ) : (
              <MarketingNavLink
                key={item.key}
                item={item}
                label={l[item.key]}
                className={mobileLinkClass}
                onClick={closeMobile}
              />
            ),
          )}
          <div className="flex items-center justify-between gap-2 border-t border-neutral-200/80 px-2 py-2 dark:border-white/10">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-900 dark:text-neutral-50">
              {auth.language.label}
            </span>
            <LanguageSwitcher />
          </div>
          <MarketingAuthCta variant="headerMobile" onNavigate={closeMobile} />
        </nav>
      )}
    </header>
  )
}
