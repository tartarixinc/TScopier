import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Info,
  PanelLeftClose,
  Plus,
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
import {
  APP_CANVAS,
  APP_CARD,
  APP_MAIN_SHELL,
  APP_PILL,
  APP_RAIL,
  APP_RAIL_ACTIVE,
  APP_RAIL_HOVER,
  APP_SECTION_LABEL,
} from '../../lib/appSurface'
import { interpolate } from '../../i18n/interpolate'
import { formatHeroLiveMoney, useLiveMoneyTicker } from './useLiveMoneyTicker'
import type {
  LandingBacktestPipsTone,
  LandingHeroCopierLogRow,
  LandingHeroHeadlineStat,
  LandingHeroLinkedAccount,
  LandingHeroOverviewStatKey,
} from '../../i18n/locales/landing/types'

const CANVAS_WIDTH = 1320
const CANVAS_HEIGHT = 900
const PREVIEW_NAME = 'Alex'

const COPIER_LOG_GRID =
  'grid grid-cols-[6.5rem_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.85fr)_minmax(4.5rem,0.7fr)_minmax(0,1.1fr)_minmax(4.25rem,0.65fr)_6.5rem] gap-x-3 items-center'

const LINKED_ACCOUNTS_GRID =
  'grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_5.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_4.5rem_4rem_6.5rem] gap-x-3 items-center'

const SECTION_LINK =
  'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-neutral-600 dark:text-neutral-300'

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
  if (key === 'openTrades') return t.dashboard.manageTrades
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
      className={clsx('mt-2 text-2xl font-semibold tracking-tight', valueToneClass(tone))}
      aria-live="polite"
      aria-atomic="true"
    >
      {formatHeroLiveMoney(amount, live.signed)}
    </p>
  )
}

function HeroStatBlock({ stat, label }: { stat: LandingHeroHeadlineStat; label: string }) {
  return (
    <div className={clsx(APP_CARD, 'px-5 py-4')}>
      <p className={clsx('inline-flex items-center gap-1', APP_SECTION_LABEL)}>
        <span className="min-w-0">{label}</span>
        {stat.showHint ? <Info className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      </p>
      {stat.live ? (
        <HeroLiveMoneyValue live={stat.live} tone={stat.valueTone} />
      ) : (
        <p className={clsx('mt-2 text-2xl font-semibold tracking-tight', valueToneClass(stat.valueTone))}>
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
      <p className={APP_SECTION_LABEL}>{label}</p>
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

function linkedStatusLabel(
  status: LandingHeroLinkedAccount['status'],
  t: ReturnType<typeof useT>,
): string {
  const la = t.dashboard.linkedAccounts
  if (status === 'connected') return la.statusConnected
  if (status === 'connecting') return la.statusConnecting
  return la.statusDisconnected
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
      <span className="text-neutral-900 dark:text-neutral-50">{PREVIEW_NAME}</span>
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
  const la = t.dashboard.linkedAccounts
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
        { to: '/account-trades', label: t.nav.items.trades, active: false, openTag: openTradeCount > 0 },
        { to: '/manage-signals', label: t.nav.items.signalHistory, active: false },
        { to: '/activities', label: t.nav.items.management, active: false },
        { to: '/copier-logs', label: t.nav.items.copierLogs, active: false },
        { to: '/reported-trades', label: t.nav.items.reportedTrades, active: false },
      ],
    },
    {
      label: t.nav.sections.copy,
      items: [
        { to: '/mirror-trading', label: t.nav.items.mirrorTrading, active: false },
        { to: '/social-trading', label: t.nav.items.socialTrading, active: false },
        { to: '/channels', label: t.nav.items.channels, active: false },
        { to: '/backtest', label: t.nav.items.backtest, active: false },
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
        <div className={clsx('flex h-full w-full flex-col overflow-hidden', APP_CANVAS)} dir={dir}>
          <div className="flex min-h-0 flex-1 gap-2.5 overflow-hidden p-3">
            <aside className={clsx('flex w-60 shrink-0 flex-col overflow-hidden', APP_RAIL)}>
              <div className="flex h-14 shrink-0 items-center px-4">
                <TscopierLogo brand="unicopier" className="h-8 w-auto" />
              </div>
              <nav className="min-h-0 flex-1 space-y-4 overflow-hidden px-2.5 pb-3" aria-hidden>
                {navSections.map(section => (
                  <div key={section.label}>
                    <p className={clsx('mb-1.5 px-3', APP_SECTION_LABEL)}>{section.label}</p>
                    <div className="space-y-0.5">
                      {section.items.map(item => {
                        const Icon = getAppRouteIcon(item.to)
                        return (
                          <div
                            key={item.to}
                            className={clsx(
                              'flex min-h-8 items-center gap-2.5 rounded-full px-3 py-1.5 text-sm',
                              item.active
                                ? clsx(APP_RAIL_ACTIVE, 'font-semibold')
                                : clsx('font-medium text-neutral-600 dark:text-neutral-300', APP_RAIL_HOVER),
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="min-w-0 truncate">{item.label}</span>
                            {item.openTag ? (
                              <span className="ms-auto inline-flex shrink-0 items-center rounded-md bg-green-400 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-neutral-950">
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

            <div className={clsx('flex min-w-0 flex-1 flex-col overflow-hidden', APP_MAIN_SHELL)}>
              <header className="z-20 flex h-14 shrink-0 items-center gap-2 px-4">
                <span className={clsx('inline-flex h-9 w-9 items-center justify-center text-neutral-600 dark:text-neutral-300', APP_PILL)}>
                  <DirectionalIcon icon={PanelLeftClose} className="h-4.5 w-4.5" />
                </span>
                <div className={clsx('flex h-9 min-w-0 max-w-sm flex-1 items-center gap-2 px-3 text-sm text-neutral-500 dark:text-neutral-400', APP_PILL)}>
                  <Search className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{t.globalSearch.placeholder}</span>
                  <span className="ms-auto hidden text-xs sm:ltr:inline">{t.globalSearch.shortcut}</span>
                </div>
                <div className="ms-auto flex shrink-0 items-center gap-1.5">
                  <span className={clsx('flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-50', APP_PILL)}>
                    <CopierActiveIndicator />
                    <span className="whitespace-nowrap">{t.nav.copierPause.statusRunning}</span>
                  </span>
                  <span className={clsx('inline-flex h-9 w-9 items-center justify-center text-green-500 dark:text-green-400', APP_PILL)}>
                    <Sparkles className="h-4.5 w-4.5" aria-hidden />
                  </span>
                  <LanguageSwitcher />
                  <ThemeToggle />
                  <span className={clsx('inline-flex h-9 w-9 items-center justify-center text-neutral-700 dark:text-neutral-200', APP_PILL)}>
                    <Bell className="h-4.5 w-4.5" aria-hidden />
                  </span>
                  <div className={clsx('flex min-h-9 items-center gap-2 ps-1 pe-2', APP_PILL)}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-950 dark:bg-neutral-700 dark:text-neutral-50">
                      {PREVIEW_NAME.slice(0, 1)}
                    </span>
                    <span className="hidden text-start md:block">
                      <span className="block text-sm font-medium leading-tight text-neutral-900 dark:text-neutral-100">
                        {PREVIEW_NAME}
                      </span>
                      <span className="block text-xs leading-tight text-neutral-500 dark:text-neutral-400">
                        {t.pricing.advanced.name}
                      </span>
                    </span>
                    <ChevronDown className="hidden h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400 md:block" />
                  </div>
                </div>
              </header>

              <main className="min-h-0 flex-1 overflow-hidden">
                <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4 overflow-hidden px-6 pb-5 pt-1">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                      {heroGreeting(t)}
                    </h1>
                    <div className={clsx(APP_CARD, 'inline-flex items-center gap-2 px-3.5 py-2')}>
                      <span className="h-2 w-2 shrink-0 rounded-full bg-green-400" aria-hidden />
                      <span className="text-sm">
                        <span className="font-semibold text-neutral-900 dark:text-neutral-50">
                          {t.dashboard.copierStatus.title}:{' '}
                        </span>
                        <span className="font-medium text-green-500 dark:text-green-400">
                          {t.dashboard.copierStatus.allChecksPassed}
                        </span>
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" />
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-3">
                    {d.headlineStats.map(stat => (
                      <HeroStatBlock
                        key={stat.key}
                        stat={stat}
                        label={HEADLINE_LABELS[stat.key](t)}
                      />
                    ))}
                  </div>

                  <div className={clsx(APP_CARD, 'grid grid-cols-4 divide-x divide-neutral-100/90 dark:divide-white/8 rtl:divide-x-reverse')}>
                    {d.overviewStats.map(stat => (
                      <HeroOverviewStat
                        key={stat.key}
                        label={OVERVIEW_LABELS[stat.key](t)}
                        value={stat.value}
                        action={stat.showAdd || stat.key === 'openTrades' ? overviewActionLabel(stat.key, t) : null}
                      />
                    ))}
                  </div>

                  <div className={clsx(APP_CARD, 'min-w-0 overflow-hidden')}>
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100/90 px-5 py-3.5 dark:border-white/8">
                      <div className="flex items-center gap-2">
                        <h2 className="text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                          {t.dashboard.copierLogs}
                        </h2>
                        <Info className="h-3.5 w-3.5 text-neutral-400 dark:text-neutral-500" aria-hidden />
                      </div>
                      <span className={SECTION_LINK}>
                        {t.dashboard.viewAll}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                    <div
                      className={clsx(
                        COPIER_LOG_GRID,
                        'border-b border-neutral-100/90 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.06em] text-neutral-500 dark:border-white/8 dark:text-neutral-400',
                      )}
                    >
                      <span>{t.copierLogs.colStatus}</span>
                      <span>{t.copierLogs.colReason}</span>
                      <span>{t.copierLogs.colChannel}</span>
                      <span>{t.copierLogs.colDestination}</span>
                      <span>{t.copierLogs.colSymbol}</span>
                      <span>{t.copierLogs.colMessage}</span>
                      <span>{t.copierLogs.colType}</span>
                      <span className="text-end">{t.copierLogs.colTime}</span>
                    </div>
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {d.copierLogRows.slice(0, 1).map(row => (
                        <div key={`${row.channel}-${row.time}`} className={clsx(COPIER_LOG_GRID, 'px-5 py-3')}>
                          <span
                            className={clsx(
                              'inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium',
                              copierStatusClass(row.status),
                            )}
                          >
                            {statusLabel(row.status)}
                          </span>
                          <span className="min-w-0 truncate text-sm text-neutral-900 underline decoration-dotted underline-offset-2 dark:text-neutral-50">
                            {row.reason}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-sm text-neutral-900 dark:text-neutral-50">
                            <SignalSourceLogo kind="telegram" className="h-4 w-4 shrink-0" />
                            <span className="truncate">{row.channel}</span>
                          </span>
                          <span className="min-w-0 truncate text-sm text-neutral-900 dark:text-neutral-50">
                            {row.destination}
                          </span>
                          <span className="min-w-0 truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                            {row.symbol}
                          </span>
                          <span className="min-w-0 truncate text-sm text-neutral-600 dark:text-neutral-300">
                            {row.message}
                          </span>
                          <span
                            className={clsx(
                              'min-w-0 truncate text-sm font-medium',
                              row.side === 'buy' ? 'text-green-500 dark:text-green-400' : 'text-error-600 dark:text-error-400',
                            )}
                          >
                            {row.type}
                          </span>
                          <span className="text-end text-sm tabular-nums text-neutral-900 dark:text-neutral-50">
                            {row.time}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={clsx(APP_CARD, 'min-w-0 overflow-hidden')}>
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100/90 px-5 py-3.5 dark:border-white/8">
                      <h2 className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                        {la.title}
                        <span className="text-xs font-medium tabular-nums text-neutral-500 dark:text-neutral-400">
                          {d.linkedAccounts.length}
                        </span>
                      </h2>
                      <span className={SECTION_LINK}>
                        <Plus className="h-3.5 w-3.5" />
                        {t.common.add}
                      </span>
                    </div>
                    <div
                      className={clsx(
                        LINKED_ACCOUNTS_GRID,
                        'border-b border-neutral-100/90 px-5 py-2.5 text-xs font-medium uppercase tracking-[0.06em] text-neutral-500 dark:border-white/8 dark:text-neutral-400',
                      )}
                    >
                      <span>{la.colAccount}</span>
                      <span>{la.colBroker}</span>
                      <span>{la.colAccountType}</span>
                      <span>{la.colBalance}</span>
                      <span>{la.colPnl}</span>
                      <span>{la.colOpenPnl}</span>
                      <span>{la.colWinRate}</span>
                      <span>{la.colDd}</span>
                      <span className="text-end">{la.colStatus}</span>
                    </div>
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {d.linkedAccounts.map(account => (
                        <div key={`${account.name}-${account.broker}`} className={clsx(LINKED_ACCOUNTS_GRID, 'px-5 py-3')}>
                          <span className="min-w-0 truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                            {account.name}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-sm text-neutral-900 dark:text-neutral-50">
                            <img src="/MT5.png" alt="" className="h-4 w-4 shrink-0 object-contain" aria-hidden />
                            <span className="truncate">{account.broker}</span>
                          </span>
                          <span className="text-sm text-neutral-600 dark:text-neutral-300">{account.accountType}</span>
                          <span className="text-sm tabular-nums text-neutral-900 dark:text-neutral-50">{account.balance}</span>
                          <span className={clsx('text-sm font-medium tabular-nums', valueToneClass(account.pnlTone))}>
                            {account.pnl}
                          </span>
                          <span className="text-sm tabular-nums text-neutral-900 dark:text-neutral-50">{account.openPnl}</span>
                          <span className="text-sm tabular-nums text-neutral-900 dark:text-neutral-50">{account.winRate}</span>
                          <span className="text-sm tabular-nums text-neutral-900 dark:text-neutral-50">{account.dd}</span>
                          <span className="flex items-center justify-end gap-2">
                            <span
                              className={clsx(
                                'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
                                account.status === 'connected' ? 'bg-green-400' : 'bg-neutral-300 dark:bg-neutral-700',
                              )}
                              aria-hidden
                            >
                              <span
                                className={clsx(
                                  'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-[left,right]',
                                  account.status === 'connected' ? 'end-0.5' : 'start-0.5',
                                )}
                              />
                            </span>
                            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                              {linkedStatusLabel(account.status, t)}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
