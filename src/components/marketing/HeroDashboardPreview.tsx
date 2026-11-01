import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  Info,
  PanelLeftClose,
  Search,
  Sparkles,
} from 'lucide-react'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { CopierActiveIndicator } from '../layout/CopierActiveIndicator'
import { SignalSourceLogo } from '../dashboard/SignalSourceLogo'
import { ThemeToggle } from '../ui/ThemeToggle'
import { TscopierLogo } from '../ui/TscopierLogo'
import { DirectionalIcon } from '../ui/DirectionalIcon'
import { useLocale, useT } from '../../context/LocaleContext'
import { getAppRouteIcon } from '../../lib/appNavIcons'
import { interpolate } from '../../i18n/interpolate'
import { formatHeroLiveMoney, useLiveMoneyTicker } from './useLiveMoneyTicker'
import type {
  LandingBacktestPipsTone,
  LandingHeroCopierLogRow,
  LandingHeroHeadlineStat,
  LandingHeroOverviewStatKey,
} from '../../i18n/locales/landing/types'

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 820
const PREVIEW_NAME = 'Alex'

const COPIER_LOG_GRID_LTR =
  'grid grid-cols-[5.75rem_minmax(0,1fr)_minmax(4rem,0.85fr)_minmax(4.75rem,auto)_minmax(6.75rem,auto)] gap-x-3 items-center'

const COPIER_LOG_GRID_RTL =
  'grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(3.5rem,0.85fr)_minmax(4.25rem,auto)_minmax(6rem,auto)] gap-x-2 items-center'

const DASHBOARD_CARD =
  'rounded-2xl border border-neutral-200/65 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-neutral-800/55 dark:bg-neutral-950 dark:shadow-none'

const SECTION_LINK =
  'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-neutral-900 dark:text-neutral-50'

function valueToneClass(tone: LandingBacktestPipsTone): string {
  if (tone === 'good') return 'text-green-500 dark:text-green-400'
  if (tone === 'bad') return 'text-error-600 dark:text-error-400'
  return 'text-neutral-900 dark:text-neutral-50'
}

const HEADLINE_LABELS: Record<
  LandingHeroHeadlineStat['key'],
  (t: ReturnType<typeof useT>) => string
> = {
  totalBalance: t => t.dashboard.totalBalance,
  todaysProfit: t => t.dashboard.todaysProfit,
  tradesTakenToday: t => t.dashboard.tradesTakenToday,
  openPnl: t => t.dashboard.openPnl,
}

const OVERVIEW_LABELS: Record<LandingHeroOverviewStatKey, (t: ReturnType<typeof useT>) => string> = {
  activeSignalChannels: t => t.dashboard.activeSignalChannels,
  openTrades: t => t.dashboard.openTrades,
  tradingAccountsConnected: t => t.dashboard.tradingAccountsConnected,
  tradesCopiedToday: t => t.dashboard.tradesCopiedToday,
}

function overviewActionLabel(
  key: LandingHeroOverviewStatKey,
  t: ReturnType<typeof useT>,
): string | null {
  if (key === 'activeSignalChannels') return t.dashboard.manageChannels
  if (key === 'tradingAccountsConnected') return t.dashboard.addOrManageAccounts
  return null
}

function HeroLiveMoneyValue({
  live,
  tone,
}: {
  live: NonNullable<LandingHeroHeadlineStat['live']>
  tone: LandingHeroHeadlineStat['valueTone']
}) {
  const amount = useLiveMoneyTicker(live)

  return (
    <p
      className={clsx('mt-2 text-3xl font-semibold tracking-tight', valueToneClass(tone))}
      aria-live="polite"
      aria-atomic="true"
    >
      {formatHeroLiveMoney(amount, live.signed)}
    </p>
  )
}

function HeroStatBlock({ stat, label }: { stat: LandingHeroHeadlineStat; label: string }) {
  return (
    <div className="rounded-2xl bg-[#F7F8FA] px-5 py-4 dark:bg-white/3 dark:ring-1 dark:ring-inset dark:ring-white/6">
      <p className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-900 dark:text-neutral-50">
        <span className="min-w-0">{label}</span>
        {stat.showHint ? <Info className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      </p>
      {stat.live ? (
        <HeroLiveMoneyValue live={stat.live} tone={stat.valueTone} />
      ) : (
        <p className={clsx('mt-2 text-3xl font-semibold tracking-tight', valueToneClass(stat.valueTone))}>
          {stat.value}
        </p>
      )}
      <p className="mt-1.5 text-xs leading-5 text-neutral-900 dark:text-neutral-50">{stat.sub}</p>
    </div>
  )
}

function HeroOverviewStat({
  label,
  value,
  action,
}: {
  label: string
  value: string
  action?: string | null
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-900 dark:text-neutral-50">
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">{value}</p>
      {action ? (
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-neutral-900 dark:text-neutral-50">
          {action}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      ) : (
        <span className="mt-2 block h-5" aria-hidden />
      )}
    </div>
  )
}

function ProcessRouteMark() {
  return (
    <span className="inline-flex items-center rounded-full bg-neutral-50 py-0.5 ps-0.5 pe-1 ring-1 ring-neutral-200/80 dark:bg-neutral-900 dark:ring-neutral-800">
      <SignalSourceLogo kind="telegram" className="h-5 w-5 shrink-0 rounded-full" />
      <img
        src="/MT5.png"
        alt=""
        aria-hidden
        className="relative z-10 -ms-1.5 h-5 w-5 shrink-0 rounded-full object-contain ring-2 ring-white dark:ring-neutral-950"
      />
    </span>
  )
}

function copierStatusClass(status: LandingHeroCopierLogRow['status']): string {
  switch (status) {
    case 'executed':
      return 'bg-green-100 text-neutral-950 dark:bg-green-100 dark:text-neutral-950'
    case 'parsed':
      return 'text-green-500 bg-teal-50 dark:text-teal-300 dark:bg-teal-950/60'
    case 'skipped':
      return 'text-warning-800 bg-warning-50 dark:text-amber-100! dark:bg-amber-900!'
    case 'failed':
      return 'text-error-800 bg-error-50 dark:text-error-300 dark:bg-error-950/70'
    default:
      return 'text-neutral-900 bg-neutral-100 dark:text-neutral-50 dark:bg-neutral-800'
  }
}

function heroGreeting(t: ReturnType<typeof useT>) {
  const hour = new Date().getHours()
  const greeting =
    hour >= 5 && hour < 12
      ? t.dashboard.greetingMorning
      : hour >= 12 && hour < 17
        ? t.dashboard.greetingAfternoon
        : t.dashboard.greetingEvening
  const parts = t.dashboard.greetingNamed.replace('{greeting}', greeting).split('{name}')
  return (
    <>
      {parts[0]}
      <span className="text-green-500 dark:text-green-400">{PREVIEW_NAME}</span>
      {parts[1] ?? ''}
    </>
  )
}

export function HeroDashboardPreview() {
  const { dir } = useLocale()
  const isRtl = dir === 'rtl'
  const t = useT()
  const l = t.landing
  const d = l.hero.dashboard
  const hostRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)

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

  const openTradeCount = Number(d.overviewStats.find(stat => stat.key === 'openTrades')?.value ?? 0)
  const openTradesTag = interpolate(t.nav.openTradesCount, { count: openTradeCount })

  const navSections = [
    {
      label: t.nav.sections.general,
      items: [
        { to: '/dashboard', label: t.nav.items.dashboard, active: true },
        { to: '/brokers', label: t.nav.items.brokers, active: false },
        { to: '/mirror-trading', label: t.nav.items.mirrorTrading, active: false },
        { to: '/social-trading', label: t.nav.items.socialTrading, active: false },
        { to: '/account-trades', label: t.nav.items.trades, active: false, openTag: openTradeCount > 0 },
      ],
    },
    {
      label: t.nav.sections.signals,
      items: [
        { to: '/channels', label: t.nav.items.channels, active: false },
        { to: '/backtest', label: t.nav.items.backtest, active: false },
        { to: '/activities', label: t.nav.items.management, active: false },
        { to: '/copier-logs', label: t.nav.items.copierLogs, active: false },
        { to: '/manage-signals', label: t.nav.items.signalHistory, active: false },
        { to: '/performance', label: t.nav.items.performance, active: false },
      ],
    },
    {
      label: t.nav.sections.tradingTools,
      items: [
        { to: '/market-news', label: t.nav.items.marketNews, active: false },
        { to: '/economic-calendar', label: t.nav.items.economicCalendar, active: false },
      ],
    },
    {
      label: t.nav.sections.membership,
      items: [
        { to: '/billing', label: t.nav.userMenu.subscriptionBilling, active: false },
        { to: '/affiliate-program', label: t.nav.userMenu.affiliateProgram, active: false },
        { to: '/wallet', label: t.nav.userMenu.wallet, active: false },
      ],
    },
  ]

  const statusLabel = (status: LandingHeroCopierLogRow['status']) => {
    switch (status) {
      case 'executed':
        return t.copierLogs.statusExecuted
      case 'parsed':
        return t.copierLogs.statusParsed
      case 'skipped':
        return t.copierLogs.statusSkipped
      case 'failed':
        return t.copierLogs.statusFailed
      default:
        return t.copierLogs.statusPending
    }
  }

  const copierLogGrid = isRtl ? COPIER_LOG_GRID_RTL : COPIER_LOG_GRID_LTR

  return (
    <div
      ref={hostRef}
      dir="ltr"
      className="hero-dashboard-viewport relative w-full overflow-hidden"
      role="img"
      aria-label={l.hero.imageAlt}
    >
      <div
        className="pointer-events-none absolute top-0 select-none"
        style={{
          left: isRtl ? undefined : 0,
          right: isRtl ? 0 : undefined,
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: isRtl ? 'top right' : 'top left',
        }}
      >
        <div className="flex h-full w-full overflow-hidden bg-white dark:bg-neutral-950" dir={dir}>
          <aside className="flex w-64 shrink-0 flex-col border-e border-neutral-100 bg-[#F7F8FA] dark:border-neutral-800 dark:bg-neutral-950">
            <div className="flex h-16 shrink-0 items-center border-b border-neutral-100 px-4 dark:border-neutral-800">
              <TscopierLogo className="h-12 w-auto" />
            </div>
            <nav className="min-h-0 flex-1 space-y-5 overflow-hidden px-3 py-4" aria-hidden>
              {navSections.map(section => (
                <div key={section.label}>
                  <p className="mb-1.5 px-3 text-[10px] font-semibold tracking-widest text-neutral-900 dark:text-neutral-50">
                    {section.label}
                  </p>
                  <div className="space-y-0.5">
                    {section.items.map(item => {
                      const Icon = getAppRouteIcon(item.to)
                      return (
                        <div
                          key={item.to}
                          className={clsx(
                            'flex min-h-[20px] items-center gap-2 rounded-xl px-3 py-2.5 text-sm',
                            item.active
                              ? 'bg-green-400 font-semibold text-neutral-950 dark:bg-green-400 dark:text-neutral-950'
                              : 'font-medium text-neutral-900 dark:text-neutral-50',
                          )}
                        >
                          <Icon
                            className={clsx('h-4 w-4 shrink-0', item.active && 'text-neutral-950')}
                          />
                          <span className="min-w-0 truncate">{item.label}</span>
                          {item.openTag ? (
                            <span className="ms-auto inline-flex shrink-0 items-center rounded-md border border-green-200 bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-neutral-950 dark:border-green-200 dark:bg-green-100 dark:text-neutral-950">
                              {openTradesTag}
                            </span>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="z-20 flex h-16 shrink-0 items-center gap-3 border-b border-neutral-100 bg-white px-4 dark:border-neutral-800 dark:bg-neutral-950 sm:px-6">
              <DirectionalIcon icon={PanelLeftClose} className="h-5 w-5 shrink-0 text-neutral-900 dark:text-neutral-50" />
              <div className="flex h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-50">
                <Search className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{t.globalSearch.placeholder}</span>
                <span className="ms-auto hidden text-xs sm:ltr:inline">{t.globalSearch.shortcut}</span>
              </div>
              <div className="ms-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
                <span className="flex items-center gap-1.5 px-2 py-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-50">
                  <CopierActiveIndicator />
                  <span className="whitespace-nowrap">{t.nav.copierPause.statusRunning}</span>
                </span>
                <span className="inline-flex h-10 w-10 items-center justify-center text-green-500 dark:text-green-400">
                  <Sparkles className="h-5 w-5" aria-hidden />
                </span>
                <LanguageSwitcher />
                <ThemeToggle />
                <span className="inline-flex h-10 w-10 items-center justify-center text-neutral-900 dark:text-neutral-50">
                  <Bell className="h-5 w-5" aria-hidden />
                </span>
                <div className="flex min-h-10 items-center gap-2 rounded-lg ps-1 pe-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-950">
                    {PREVIEW_NAME.slice(0, 1)}
                  </span>
                  <span className="hidden text-start md:block">
                    <span className="block text-sm font-medium leading-tight text-neutral-900 dark:text-neutral-100">
                      {PREVIEW_NAME}
                    </span>
                    <span className="block text-xs leading-tight text-neutral-900 dark:text-neutral-50">
                      {t.pricing.advanced.name}
                    </span>
                  </span>
                  <ChevronDown className="hidden h-3.5 w-3.5 text-neutral-900 dark:text-neutral-50 md:block" />
                </div>
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-hidden bg-white dark:bg-neutral-950">
              <div className="mx-auto h-full w-full max-w-[1600px] space-y-5 overflow-hidden px-8 py-6">
                <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                  {heroGreeting(t)}
                </h1>

                <div className="grid grid-cols-4 gap-3">
                  {d.headlineStats.map(stat => (
                    <HeroStatBlock
                      key={stat.key}
                      stat={stat}
                      label={HEADLINE_LABELS[stat.key](t)}
                    />
                  ))}
                </div>

                <div className={clsx(DASHBOARD_CARD, 'grid grid-cols-4 divide-x divide-neutral-100 dark:divide-neutral-800/70 rtl:divide-x-reverse')}>
                  {d.overviewStats.map(stat => (
                    <HeroOverviewStat
                      key={stat.key}
                      label={OVERVIEW_LABELS[stat.key](t)}
                      value={stat.value}
                      action={stat.showAdd ? overviewActionLabel(stat.key, t) : null}
                    />
                  ))}
                </div>

                <div className={clsx(DASHBOARD_CARD, 'flex items-center gap-2 px-5 py-4')}>
                  <Activity className="h-4 w-4 shrink-0 text-neutral-900 dark:text-neutral-50" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                      {t.dashboard.copierStatus.title}:{' '}
                    </span>
                    <span className="font-medium text-green-500 dark:text-green-400">
                      {t.dashboard.copierStatus.allChecksPassed}
                    </span>
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-neutral-900 dark:text-neutral-50" />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className={clsx(DASHBOARD_CARD, 'min-w-0 overflow-hidden')}>
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800/80">
                      <div className="flex items-center gap-2">
                        <h2 className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                          {t.dashboard.tradeActivities}
                        </h2>
                        <Info className="h-3.5 w-3.5 text-neutral-900 dark:text-neutral-50" aria-hidden />
                      </div>
                      <span className={SECTION_LINK}>
                        {t.dashboard.management}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {d.channelWorkerLogs.map(log => (
                        <div key={log.message} className="px-5 py-3.5">
                          <p className="text-base leading-6 text-neutral-900 dark:text-neutral-100">{log.message}</p>
                          <div className="mt-1 flex items-center gap-2">
                            <p className="text-xs text-neutral-900 dark:text-neutral-50">{log.time}</p>
                            <ProcessRouteMark />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={clsx(DASHBOARD_CARD, 'min-w-0 overflow-hidden')}>
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800/80">
                      <div className="flex items-center gap-2">
                        <h2 className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                          {t.dashboard.copierLogs}
                        </h2>
                        <Info className="h-3.5 w-3.5 text-neutral-900 dark:text-neutral-50" aria-hidden />
                      </div>
                      <span className={SECTION_LINK}>
                        {t.dashboard.viewAll}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                    <div
                      className={clsx(
                        copierLogGrid,
                        'border-b border-neutral-100 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.06em] text-neutral-900 dark:border-neutral-800/80 dark:text-neutral-50',
                      )}
                    >
                      <span>{t.copierLogs.colStatus}</span>
                      <span>{t.copierLogs.colChannel}</span>
                      <span>{t.copierLogs.colSymbol}</span>
                      <span>{t.copierLogs.colType}</span>
                      <span className="text-end">{t.copierLogs.colTime}</span>
                    </div>
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {d.copierLogRows.map(row => (
                        <div key={`${row.channel}-${row.time}`} className={clsx(copierLogGrid, 'px-5 py-3')}>
                          <span
                            className={clsx(
                              'inline-flex w-fit items-center rounded-full px-2.5 py-1 text-sm',
                              copierStatusClass(row.status),
                            )}
                          >
                            {statusLabel(row.status)}
                          </span>
                          <span className="flex min-w-0 items-center gap-2 text-sm text-neutral-900 dark:text-neutral-50">
                            <SignalSourceLogo kind="telegram" />
                            <span className="truncate">{row.channel}</span>
                          </span>
                          <span className="min-w-0 truncate text-base text-neutral-900 dark:text-neutral-50">
                            {row.symbol}
                          </span>
                          <span
                            className={clsx(
                              'min-w-0 truncate text-sm uppercase',
                              row.side === 'buy' ? 'text-green-500 dark:text-green-400' : 'text-error-600 dark:text-error-400',
                            )}
                          >
                            {row.type}
                          </span>
                          <span className="text-end text-sm font-medium text-neutral-900 dark:text-neutral-50">
                            {row.time}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  )
}
