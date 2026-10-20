import clsx from 'clsx'
import { Link, useLocation } from 'react-router-dom'
import { useT } from '../../context/LocaleContext'
import { marketingUrl } from '../../lib/site'

type Audience = 'traders' | 'providers'

/**
 * "For Traders / For Providers" segmented switch that sits next to the logo.
 * Each side is its own page: the landing page (`/`) and the provider page (`/providers`).
 */
export function MarketingAudienceSwitch({
  className,
  onNavigate,
}: {
  className?: string
  onNavigate?: () => void
}) {
  const l = useT().landing.nav
  const { pathname } = useLocation()
  const active: Audience = pathname.startsWith('/providers') ? 'providers' : 'traders'

  const items: { key: Audience; label: string; href: string }[] = [
    { key: 'traders', label: l.forTraders, href: marketingUrl('/') },
    { key: 'providers', label: l.forProviders, href: marketingUrl('/providers') },
  ]

  return (
    <div
      role="group"
      aria-label="Audience"
      className={clsx(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full bg-neutral-900/[0.07] p-1 dark:bg-black/30',
        className,
      )}
    >
      {items.map(item => {
        const isActive = active === item.key
        return (
          <Link
            key={item.key}
            to={item.href}
            onClick={() => {
              onNavigate?.()
              window.scrollTo({ top: 0 })
            }}
            aria-current={isActive ? 'page' : undefined}
            className={clsx(
              'whitespace-nowrap rounded-full px-3.5 py-1.5 text-center text-[0.8125rem] font-medium transition-colors',
              isActive
                ? 'bg-neutral-950 text-white'
                : 'text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white',
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </div>
  )
}
