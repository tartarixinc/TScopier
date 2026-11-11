import { ExternalLink } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { APP_HELP_ICONS, getAppRouteIcon, APP_ROUTE_ICONS } from '../../lib/appNavIcons'
import { HELP_LINKS } from '../../lib/helpLinks'
import { APP_RAIL_ACTIVE, APP_RAIL_HOVER, APP_SECTION_LABEL } from '../../lib/appSurface'

type HelpSidebarNavProps = {
  collapsed: boolean
  onNavigate?: () => void
}

const ReportedTradesIcon = APP_ROUTE_ICONS['/reported-trades']
const UpdatesIcon = APP_ROUTE_ICONS['/updates']

export function HelpSidebarNav({ collapsed, onNavigate }: HelpSidebarNavProps) {
  const t = useT()
  const hm = t.nav.helpMenu
  const ContactSupportIcon = getAppRouteIcon('/contact-support')
  const DocumentationIcon = APP_HELP_ICONS.documentation

  const itemClass = (isActive = false) =>
    clsx(
      'flex items-center rounded-full px-3 py-2.5 text-sm min-h-[44px] transition-[colors,gap] duration-300 ease-out',
      collapsed ? 'justify-center gap-0' : 'gap-3',
      isActive
        ? clsx(APP_RAIL_ACTIVE, 'font-semibold')
        : clsx('font-medium text-neutral-600 dark:text-neutral-300', APP_RAIL_HOVER),
    )

  const labelClass = clsx(
    'overflow-hidden whitespace-nowrap transition-[opacity,max-width] duration-300 ease-out',
    collapsed ? 'max-w-0 opacity-0' : 'max-w-[11rem] opacity-100',
  )

  return (
    <div className="space-y-3">
      <p
        className={clsx(
          'overflow-hidden px-3 whitespace-nowrap transition-[opacity,max-height,margin] duration-300 ease-out',
          APP_SECTION_LABEL,
          collapsed ? 'mb-0 max-h-0 opacity-0' : 'mb-1.5 max-h-6 opacity-100',
        )}
      >
        {t.nav.sections.help}
      </p>

      <div className="space-y-0.5">
        <NavLink
          to="/updates"
          title={t.nav.items.updates}
          onClick={onNavigate}
          className={({ isActive }) => itemClass(isActive)}
        >
          <UpdatesIcon className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className={labelClass}>{t.nav.items.updates}</span>
        </NavLink>

        <NavLink
          to="/contact-support"
          title={hm.liveChat}
          onClick={onNavigate}
          className={({ isActive }) => itemClass(isActive)}
        >
          <ContactSupportIcon className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className={labelClass}>{hm.liveChat}</span>
        </NavLink>

        <NavLink
          to="/reported-trades"
          title={t.nav.items.reportedTrades}
          onClick={onNavigate}
          className={({ isActive }) => itemClass(isActive)}
        >
          <ReportedTradesIcon className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className={labelClass}>{t.nav.items.reportedTrades}</span>
        </NavLink>

        <a
          href={HELP_LINKS.documentation}
          target="_blank"
          rel="noopener noreferrer"
          title={hm.documentation}
          className={clsx(itemClass(), !collapsed && 'lg:w-full')}
        >
          <DocumentationIcon className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <span className={clsx(labelClass, !collapsed && 'min-w-0 flex-1')}>{hm.documentation}</span>
          <ExternalLink
            className={clsx(
              'h-3.5 w-3.5 shrink-0 opacity-50 transition-[opacity,max-width] duration-300 ease-out',
              collapsed ? 'max-w-0 opacity-0' : 'max-w-[1rem] opacity-50',
            )}
            aria-hidden
          />
        </a>
      </div>

      <div
        className={clsx(
          'px-3 transition-[padding] duration-300 ease-out',
          collapsed && 'flex justify-center',
        )}
        role="status"
        aria-label={`${hm.status}: ${hm.statusOperational}`}
      >
        <div className={clsx('flex items-start gap-2.5', collapsed && 'gap-0')}>
          <span
            className={clsx(
              'relative flex h-2 w-2 shrink-0',
              !collapsed && 'mt-1',
            )}
            title={hm.statusOperational}
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <div
            className={clsx(
              'min-w-0 overflow-hidden transition-[opacity,max-width] duration-300 ease-out',
              collapsed ? 'max-w-0 opacity-0' : 'max-w-[10rem] opacity-100',
            )}
          >
            <p className="whitespace-nowrap text-xs font-semibold text-neutral-900 dark:text-neutral-50">{hm.status}</p>
            <p className="whitespace-nowrap text-xs text-neutral-900 dark:text-neutral-50">{hm.statusOperational}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
