import type { ReactNode } from 'react'
import { MarketingHeader } from './MarketingHeader'
import { useT } from '../../context/LocaleContext'
import { appUrl } from '../../lib/site'
import { HELP_LINKS } from '../../lib/helpLinks'

interface MarketingLayoutProps {
  children: ReactNode
}

export function MarketingLayout({ children }: MarketingLayoutProps) {
  const t = useT()
  const l = t.landing
  const year = new Date().getFullYear()
  const copyright = l.footer.copyright.replace('{year}', String(year))

  return (
    <div className="marketing-hero-bg trustpilot-panel-bg trustpilot-panel-surface relative flex min-h-screen flex-col">
      <div className="trustpilot-panel-radial pointer-events-none absolute inset-0" aria-hidden />
      <MarketingHeader />

      <main className="relative z-10 flex-1 pt-[4.75rem] sm:pt-20">{children}</main>

      <footer className="relative z-10 border-t border-neutral-200/80 bg-white/90 backdrop-blur-md dark:border-neutral-800/80 dark:bg-neutral-900/90">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{copyright}</p>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <a
              href={HELP_LINKS.documentation}
              className="text-neutral-600 hover:text-primary-600 dark:text-neutral-400 dark:hover:text-primary-400"
              target="_blank"
              rel="noopener noreferrer"
            >
              {l.footer.docs}
            </a>
            <a
              href={HELP_LINKS.status}
              className="text-neutral-600 hover:text-primary-600 dark:text-neutral-400 dark:hover:text-primary-400"
              target="_blank"
              rel="noopener noreferrer"
            >
              {l.footer.status}
            </a>
            <a
              href={appUrl('/dashboard')}
              className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
            >
              {l.footer.openApp}
            </a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
