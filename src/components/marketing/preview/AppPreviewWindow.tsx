import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Bell, PanelLeftClose, Search } from 'lucide-react'
import { CopierActiveIndicator } from '../../layout/CopierActiveIndicator'
import { TscopierLogo } from '../../ui/TscopierLogo'
import { DirectionalIcon } from '../../ui/DirectionalIcon'
import { useT } from '../../../context/LocaleContext'
import { getAppRouteIcon } from '../../../lib/appNavIcons'

const CANVAS_WIDTH = 1100
const CANVAS_HEIGHT = 760

type AppPreviewWindowProps = {
  /** Route highlighted in the sidebar, e.g. `/mirror-trading`. */
  activeRoute: string
  /** Page content rendered inside the app's `<main>` area. */
  children: ReactNode
  className?: string
}

/**
 * A faithful, non-interactive miniature of the real app shell (browser chrome,
 * sidebar, header) rendered at a fixed canvas size and scaled to fit its host.
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
        { to: '/mirror-trading', label: t.nav.items.mirrorTrading },
        { to: '/social-trading', label: t.nav.items.socialTrading },
        { to: '/account-trades', label: t.nav.items.trades },
      ],
    },
    {
      label: t.nav.sections.signals,
      items: [
        { to: '/channels', label: t.nav.items.channels },
        { to: '/backtest', label: t.nav.items.backtest },
        { to: '/activities', label: t.nav.items.management },
        { to: '/copier-logs', label: t.nav.items.copierLogs },
      ],
    },
  ]

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-xl border border-neutral-200/80 bg-white shadow-[0_30px_80px_-20px_rgba(0,0,0,0.65)] dark:border-white/10 dark:bg-neutral-950',
        className,
      )}
      aria-hidden
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-neutral-200/80 bg-neutral-100 px-3 dark:border-white/10 dark:bg-neutral-900">
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
          <div className="flex h-full w-full overflow-hidden bg-white dark:bg-neutral-950">
            <aside className="flex w-56 shrink-0 flex-col border-e border-neutral-100 bg-[#F7F8FA] dark:border-neutral-800 dark:bg-neutral-950">
              <div className="flex h-16 shrink-0 items-center border-b border-neutral-100 px-4 dark:border-neutral-800">
                <TscopierLogo className="h-12 w-auto" />
              </div>
              <nav className="min-h-0 flex-1 space-y-5 overflow-hidden px-3 py-4">
                {sections.map(section => (
                  <div key={section.label}>
                    <p className="mb-1.5 px-3 text-[10px] font-semibold tracking-widest text-neutral-900 dark:text-neutral-50">
                      {section.label}
                    </p>
                    <div className="space-y-0.5">
                      {section.items.map(item => {
                        const Icon = getAppRouteIcon(item.to)
                        const active = item.to === activeRoute
                        return (
                          <div
                            key={item.to}
                            className={clsx(
                              'flex min-h-[20px] items-center gap-2 rounded-xl px-3 py-2.5 text-sm',
                              active
                                ? 'bg-green-400 font-semibold text-neutral-950'
                                : 'font-medium text-neutral-900 dark:text-neutral-50',
                            )}
                          >
                            <Icon className={clsx('h-4 w-4 shrink-0', active && 'text-neutral-950')} />
                            <span className="min-w-0 truncate">{item.label}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </nav>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-16 shrink-0 items-center gap-3 border-b border-neutral-100 bg-white px-5 dark:border-neutral-800 dark:bg-neutral-950">
                <DirectionalIcon icon={PanelLeftClose} className="h-5 w-5 shrink-0 text-neutral-900 dark:text-neutral-50" />
                <div className="flex h-9 min-w-0 max-w-xs flex-1 items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-50">
                  <Search className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate">{t.globalSearch.placeholder}</span>
                </div>
                <div className="ms-auto flex shrink-0 items-center gap-3">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-50">
                    <CopierActiveIndicator />
                    <span className="whitespace-nowrap">{t.nav.copierPause.statusRunning}</span>
                  </span>
                  <Bell className="h-5 w-5 text-neutral-900 dark:text-neutral-50" />
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-950">
                    A
                  </span>
                </div>
              </header>
              <main className="min-h-0 flex-1 overflow-hidden bg-[#F7F8FA] p-6 dark:bg-neutral-950">{children}</main>
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
    <div className="mb-5 flex items-center justify-between">
      <h3 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">{title}</h3>
      {action ? (
        <span className="rounded-lg bg-green-400 px-3.5 py-2 text-sm font-medium text-neutral-950">{action}</span>
      ) : null}
    </div>
  )
}

export const PREVIEW_CARD =
  'overflow-hidden rounded-2xl border border-neutral-200/65 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-neutral-800/55 dark:bg-neutral-950'

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
