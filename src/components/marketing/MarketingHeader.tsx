import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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
    'whitespace-nowrap text-sm font-medium text-neutral-900 transition-colors hover:text-green-500 dark:text-neutral-50 dark:hover:text-green-400'
  const mobileLinkClass =
    'rounded-lg px-3 py-2.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-white/10'

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto flex h-16 max-w-[90rem] items-center gap-3 px-5 sm:px-8 lg:gap-6">
        <Link
          to="/"
          className="flex shrink-0 items-center"
          aria-label="UniCopier home"
          onClick={closeMobile}
        >
          <TscopierLogo className="h-9 w-auto sm:h-10" />
        </Link>

        <nav
          className="hidden min-w-0 flex-1 items-center justify-center gap-6 overflow-hidden lg:flex xl:gap-8"
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

        <div className="ms-auto flex shrink-0 items-center gap-1 lg:ms-0">
          <LanguageSwitcher />
          <ThemeToggle />
          <MarketingAuthCta variant="header" />
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-900 transition-colors hover:bg-neutral-100 hover:text-neutral-900 lg:hidden dark:text-neutral-50 dark:hover:bg-white/10 dark:hover:text-neutral-100"
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
          className="flex flex-col gap-1 border-t border-neutral-200 bg-white px-5 py-3 dark:border-neutral-800 dark:bg-neutral-950 sm:px-8 lg:hidden"
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
