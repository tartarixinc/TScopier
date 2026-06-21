import { ExternalLink } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { APP_HELP_ICONS, getAppRouteIcon } from '../../lib/appNavIcons'
import { HELP_LINKS } from '../../lib/helpLinks'

type HelpSidebarNavProps = {
  collapsed: boolean
  onNavigate?: () => void
}

export function HelpSidebarNav({ collapsed, onNavigate }: HelpSidebarNavProps) {
  const t = useT()
  const hm = t.nav.helpMenu
  const ContactSupportIcon = getAppRouteIcon('/contact-support')
  const DocumentationIcon = APP_HELP_ICONS.documentation

  const itemClass = (isActive = false) =>
    clsx(
      'flex items-center px-3 py-2.5 rounded-lg text-sm transition-colors min-h-[44px]',
      collapsed ? 'justify-center' : 'gap-3',
      isActive
        ? 'bg-teal-50 text-teal-700 font-semibold dark:bg-teal-950/60 dark:text-teal-400'
        : 'text-neutral-600 font-medium hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
    )

  return (
    <div className="space-y-3">
      <p
        className={clsx(
          'px-3 text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 tracking-widest',
          collapsed && 'hidden',
        )}
      >
        {t.nav.sections.help}
      </p>

      <div className="space-y-0.5">
        <NavLink
          to="/contact-support"
          title={hm.liveChat}
          onClick={onNavigate}
          className={({ isActive }) => itemClass(isActive)}
        >
          <ContactSupportIcon className="h-4 w-4 shrink-0" aria-hidden />
          <span className={clsx(collapsed && 'lg:hidden')}>{hm.liveChat}</span>
        </NavLink>

        <a
          href={HELP_LINKS.documentation}
          target="_blank"
          rel="noopener noreferrer"
          title={hm.documentation}
          className={clsx(itemClass(), !collapsed && 'lg:w-full')}
        >
          <DocumentationIcon className="h-4 w-4 shrink-0" aria-hidden />
          <span className={clsx('min-w-0 flex-1', collapsed && 'lg:hidden')}>{hm.documentation}</span>
          {!collapsed ? (
            <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />
          ) : null}
        </a>
      </div>

      <div
        className={clsx('px-3', collapsed && 'flex justify-center')}
        role="status"
        aria-label={`${hm.status}: ${hm.statusOperational}`}
      >
        {collapsed ? (
          <span className="relative flex h-2 w-2 shrink-0" title={hm.statusOperational}>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        ) : (
          <div className="flex items-start gap-2.5">
            <span className="relative mt-1 flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-50">{hm.status}</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">{hm.statusOperational}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
