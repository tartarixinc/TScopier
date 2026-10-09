import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Menu, X } from 'lucide-react'
import { TscopierLogo } from '../ui/TscopierLogo'
import { ThemeToggle } from '../ui/ThemeToggle'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { useLocale, useT } from '../../context/LocaleContext'
import { HELP_LINKS } from '../../lib/helpLinks'
import { marketingUrl } from '../../lib/site'
import { MarketingAuthCta } from './MarketingAuthCta'

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

const SCROLL_THRESHOLD_PX = 24
const SCROLL_DELTA_PX = 8

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

export function MarketingHeader() {
  const l = useT().landing.nav
  const { auth } = useLocale()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [visible, setVisible] = useState(true)
  const lastScrollY = useRef(0)

  useEffect(() => {
    lastScrollY.current = window.scrollY

    const onScroll = () => {
      const y = window.scrollY
      const delta = y - lastScrollY.current

      setScrolled(y > SCROLL_THRESHOLD_PX)

      if (y <= SCROLL_THRESHOLD_PX) {
        setVisible(true)
      } else if (delta > SCROLL_DELTA_PX) {
        setVisible(false)
        setMobileOpen(false)
      } else if (delta < -SCROLL_DELTA_PX) {
        setVisible(true)
      }

      lastScrollY.current = y
    }

    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

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

  const closeMobile = () => setMobileOpen(false)

  const desktopLinkClass =
    'whitespace-nowrap text-xs font-medium text-neutral-600 transition-colors hover:text-neutral-900 xl:text-sm dark:text-neutral-400 dark:hover:text-neutral-100'
  const mobileLinkClass =
    'rounded-lg px-3 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-white/10'

  return (
    <header
      className={clsx(
        'marketing-nav-header pointer-events-none fixed inset-x-0 top-0 z-50 px-3 sm:px-6',
        scrolled ? 'pt-2' : 'pt-4',
        !visible && 'marketing-nav-header--hidden',
      )}
    >
      <div
        className={clsx(
          'marketing-nav-header-inner mx-auto max-w-6xl',
          visible ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          className={clsx(
            'marketing-nav-float flex items-center gap-2 px-2.5 sm:gap-3 sm:px-4 lg:gap-4 lg:px-5',
            scrolled && 'marketing-nav-float--scrolled',
          )}
        >
          <Link
            to="/"
            className="flex shrink-0 items-center"
            aria-label="UniCopier home"
            onClick={closeMobile}
          >
            <TscopierLogo
              className={clsx(
                'w-auto transition-all duration-300 ease-out',
                scrolled ? 'h-8 sm:h-9' : 'h-10 sm:h-11',
              )}
            />
          </Link>

          {/* Flex-centered nav (not absolute) so long locale labels cannot overlap logo/CTAs. */}
          <nav
            className="hidden min-w-0 flex-1 items-center justify-center gap-2.5 overflow-hidden lg:flex xl:gap-5"
            aria-label="Main"
          >
            {marketingNavItems().map(item => (
              <MarketingNavLink
                key={item.key}
                item={item}
                label={l[item.key]}
                className={desktopLinkClass}
              />
            ))}
          </nav>

          <div className="ms-auto flex shrink-0 items-center gap-0.5 sm:gap-1 lg:ms-0">
            <LanguageSwitcher />
            <ThemeToggle />
            <MarketingAuthCta variant="header" />
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 lg:hidden dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
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
              'marketing-nav-mobile mt-2 flex flex-col gap-1 p-2 lg:hidden',
              scrolled && 'marketing-nav-mobile--scrolled',
            )}
            aria-label="Main mobile"
          >
            {marketingNavItems().map(item => (
              <MarketingNavLink
                key={item.key}
                item={item}
                label={l[item.key]}
                className={mobileLinkClass}
                onClick={closeMobile}
              />
            ))}
            <div className="flex items-center justify-between gap-2 border-t border-neutral-200/80 px-2 py-2 dark:border-neutral-700/80">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {auth.language.label}
              </span>
              <LanguageSwitcher />
            </div>
            <MarketingAuthCta variant="headerMobile" onNavigate={closeMobile} />
          </nav>
        )}
      </div>
    </header>
  )
}
