import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Bell, ChevronDown, PanelLeftClose, Search, Sparkles } from 'lucide-react'
import { CopierActiveIndicator } from '../../layout/CopierActiveIndicator'
import { TscopierLogo } from '../../ui/TscopierLogo'
import { DirectionalIcon } from '../../ui/DirectionalIcon'
import { useT } from '../../../context/LocaleContext'
import { getAppRouteIcon } from '../../../lib/appNavIcons'
import {
  APP_CANVAS,
  APP_CARD,
  APP_MAIN_SHELL,
  APP_PILL,
  APP_RAIL,
  APP_RAIL_ACTIVE,
  APP_RAIL_HOVER,
  APP_SECTION_LABEL,
} from '../../../lib/appSurface'

const CANVAS_WIDTH = 1100
const CANVAS_HEIGHT = 760
const PREVIEW_NAME = 'Alex'

type AppPreviewWindowProps = {
  /** Route highlighted in the sidebar, e.g. `/mirror-trading`. */
  activeRoute: string
  /** Page content rendered inside the app's `<main>` area. */
  children: ReactNode
  className?: string
}

/**
 * Soft-shell miniature of the real app (canvas + ash rail + white main shell),
 * rendered at a fixed canvas size and scaled to fit its host.
 */
export function AppPreviewWindow({ activeRoute, children, className }: AppPreviewWindowProps) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.4)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const update = () => {
      const next = el.clientWidth / CANVAS_WIDTH
      setScale(next)
      el.style.height = `${CANVAS_HEIGHT * next}px`
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const sections = [
    {
      label: t.nav.sections.general,
      items: [
        { to: '/dashboard', label: t.nav.items.dashboard },
        { to: '/brokers', label: t.nav.items.brokers },
        { to: '/account-trades', label: t.nav.items.trades },
        { to: '/manage-signals', label: t.nav.items.signalHistory },
        { to: '/activities', label: t.nav.items.management },
        { to: '/copier-logs', label: t.nav.items.copierLogs },
        { to: '/reported-trades', label: t.nav.items.reportedTrades },
      ],
    },
    {
      label: t.nav.sections.copy,
      items: [
        { to: '/mirror-trading', label: t.nav.items.mirrorTrading },
        { to: '/social-trading', label: t.nav.items.socialTrading },
        { to: '/channels', label: t.nav.items.channels },
        { to: '/backtest', label: t.nav.items.backtest },
        { to: '/performance', label: t.nav.items.performance },
      ],
    },
  ]

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-2xl shadow-[0_24px_60px_-24px_rgba(15,23,42,0.35)] ring-1 ring-black/5 dark:ring-white/10',
        APP_CANVAS,
        className,
      )}
      aria-hidden
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-black/5 bg-[#ECEEF2]/90 px-3 dark:border-white/8 dark:bg-neutral-900">
        <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
        <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
        <span className="h-2 w-2 rounded-full bg-[#28c840]" />
      </div>
      <div ref={hostRef} dir="ltr" className="relative w-full overflow-hidden">
        <div
          className="pointer-events-none absolute left-0 top-0 select-none"
          style={{
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          <div className={clsx('flex h-full w-full flex-col overflow-hidden', APP_CANVAS)}>
            <div className="flex min-h-0 flex-1 gap-2.5 overflow-hidden p-3">
              <aside className={clsx('flex w-56 shrink-0 flex-col overflow-hidden', APP_RAIL)}>
                <div className="flex h-14 shrink-0 items-center px-4">
                  <TscopierLogo brand="unicopier" className="h-8 w-auto" />
                </div>
                <nav className="min-h-0 flex-1 space-y-4 overflow-hidden px-2.5 pb-3">
                  {sections.map(section => (
                    <div key={section.label}>
                      <p className={clsx('mb-1.5 px-3', APP_SECTION_LABEL)}>{section.label}</p>
                      <div className="space-y-0.5">
                        {section.items.map(item => {
                          const Icon = getAppRouteIcon(item.to)
                          const active = item.to === activeRoute
                          return (
                            <div
                              key={item.to}
                              className={clsx(
                                'flex min-h-8 items-center gap-2.5 rounded-full px-3 py-1.5 text-sm',
                                active
                                  ? clsx(APP_RAIL_ACTIVE, 'font-semibold')
                                  : clsx('font-medium text-neutral-600 dark:text-neutral-300', APP_RAIL_HOVER),
                              )}
                            >
                              <Icon className="h-4 w-4 shrink-0" />
                              <span className="min-w-0 truncate">{item.label}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </nav>
              </aside>

              <div className={clsx('flex min-w-0 flex-1 flex-col overflow-hidden', APP_MAIN_SHELL)}>
                <header className="z-20 flex h-14 shrink-0 items-center gap-2 px-4">
                  <span
                    className={clsx(
                      'inline-flex h-9 w-9 items-center justify-center text-neutral-600 dark:text-neutral-300',
                      APP_PILL,
                    )}
                  >
                    <DirectionalIcon icon={PanelLeftClose} className="h-4.5 w-4.5" />
                  </span>
                  <div
                    className={clsx(
                      'flex h-9 min-w-0 max-w-xs flex-1 items-center gap-2 px-3 text-sm text-neutral-500 dark:text-neutral-400',
                      APP_PILL,
                    )}
                  >
                    <Search className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 truncate">{t.globalSearch.placeholder}</span>
                  </div>
                  <div className="ms-auto flex shrink-0 items-center gap-1.5">
                    <span
                      className={clsx(
                        'flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-50',
                        APP_PILL,
                      )}
                    >
                      <CopierActiveIndicator />
                      <span className="whitespace-nowrap">{t.nav.copierPause.statusRunning}</span>
                    </span>
                    <span
                      className={clsx(
                        'inline-flex h-9 w-9 items-center justify-center text-green-500 dark:text-green-400',
                        APP_PILL,
                      )}
                    >
                      <Sparkles className="h-4.5 w-4.5" />
                    </span>
                    <span
                      className={clsx(
                        'inline-flex h-9 w-9 items-center justify-center text-neutral-700 dark:text-neutral-200',
                        APP_PILL,
                      )}
                    >
                      <Bell className="h-4.5 w-4.5" />
                    </span>
                    <div className={clsx('flex min-h-9 items-center gap-2 ps-1 pe-2', APP_PILL)}>
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-950 dark:bg-neutral-700 dark:text-neutral-50">
                        {PREVIEW_NAME.slice(0, 1)}
                      </span>
                      <span className="hidden text-start sm:block">
                        <span className="block text-sm font-medium leading-tight text-neutral-900 dark:text-neutral-100">
                          {PREVIEW_NAME}
                        </span>
                        <span className="block text-xs leading-tight text-neutral-500 dark:text-neutral-400">
                          {t.pricing.advanced.name}
                        </span>
                      </span>
                      <ChevronDown className="hidden h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400 sm:block" />
                    </div>
                  </div>
                </header>

                <main className="min-h-0 flex-1 overflow-hidden">
                  <div className="flex h-full flex-col overflow-hidden px-5 pb-5 pt-1">{children}</div>
                </main>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Shared page-title row used by the page mockups. */
export function PreviewPageHeader({ title, action }: { title: string; action?: string }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">{title}</h3>
      {action ? (
        <span className="rounded-full bg-green-400 px-3.5 py-2 text-sm font-medium text-neutral-950 shadow-xs">
          {action}
        </span>
      ) : null}
    </div>
  )
}

export const PREVIEW_CARD = `${APP_CARD} overflow-hidden`

export function PreviewToggle({ on = true }: { on?: boolean }) {
  return (
    <span
      className={clsx(
        'relative inline-block h-5 w-9 rounded-full',
        on ? 'bg-green-400' : 'bg-neutral-300 dark:bg-neutral-700',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm',
          on ? 'right-0.5' : 'left-0.5',
        )}
      />
    </span>
  )
}

export function PreviewBadge({
  children,
  tone = 'green',
}: {
  children: ReactNode
  tone?: 'green' | 'neutral' | 'blue' | 'amber'
}) {
  const tones = {
    green: 'bg-green-100 text-neutral-950',
    neutral: 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50',
    blue: 'bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-200',
    amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100',
  } as const
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  )
}
