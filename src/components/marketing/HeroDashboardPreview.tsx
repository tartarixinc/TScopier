import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Calendar,
  ChartBar as BarChart2,
  ChartNoAxesColumn,
  ChevronRight,
  CircleHelp,
  Clock,
  History,
  Info,
  LayoutDashboard,
  LayoutTemplate,
  Newspaper,
  PanelLeftClose,
  Plus,
  ScrollText,
  Search,
  Send,
  Landmark,
} from 'lucide-react'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { CopierActiveIndicator } from '../layout/CopierActiveIndicator'
import { ThemeToggle } from '../ui/ThemeToggle'
import { TscopierLogo } from '../ui/TscopierLogo'
import { useT } from '../../context/LocaleContext'
import { useTheme } from '../../context/ThemeContext'
import { chartThemeColors } from '../../lib/chartTheme'
import { formatHeroLiveMoney, useLiveMoneyTicker } from './useLiveMoneyTicker'
import type {
  LandingBacktestPipsTone,
  LandingHeroCopierLogRow,
  LandingHeroHeadlineStat,
  LandingHeroOverviewStatKey,
} from '../../i18n/locales/landing/types'

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 820

const COPIER_LOG_GRID =
  'grid grid-cols-[5.75rem_minmax(0,1fr)_minmax(4rem,0.85fr)_minmax(4.75rem,auto)_minmax(6.75rem,auto)] gap-x-3 items-center'

const TRADE_OUTCOME_DAYS = [
  { label: 'Mon', profit: 62, loss: 22 },
  { label: 'Tue', profit: 48, loss: 35 },
  { label: 'Wed', profit: 78, loss: 15 },
  { label: 'Thu', profit: 40, loss: 52 },
  { label: 'Fri', profit: 55, loss: 28 },
  { label: 'Sat', profit: 88, loss: 10 },
  { label: 'Sun', profit: 52, loss: 30 },
] as const

const TRADE_OUTCOME_MAX = Math.max(
  ...TRADE_OUTCOME_DAYS.flatMap(d => [d.profit, d.loss]),
)

const CHANNEL_PROFIT_ROWS = [
  { label: 'Gold Signals Pro', pnl: 842 },
  { label: 'FX Scalper VIP', pnl: 418 },
  { label: 'Forex Daily', pnl: 215 },
  { label: 'Indices Daily', pnl: -126 },
] as const

const CHANNEL_PROFIT_MIN = Math.min(...CHANNEL_PROFIT_ROWS.map(r => r.pnl))
const CHANNEL_PROFIT_MAX = Math.max(...CHANNEL_PROFIT_ROWS.map(r => r.pnl))
const CHANNEL_PROFIT_SPAN = CHANNEL_PROFIT_MAX - CHANNEL_PROFIT_MIN || 1

function formatHeroAxisMoney(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1000) return `$${(value / 1000).toFixed(1)}k`
  return `$${Math.round(value)}`
}

function channelBarGeometry(pnl: number, plotWidth: number): { x: number; width: number } {
  const zeroX = ((0 - CHANNEL_PROFIT_MIN) / CHANNEL_PROFIT_SPAN) * plotWidth
  const width = (Math.abs(pnl) / CHANNEL_PROFIT_SPAN) * plotWidth
  return {
    x: pnl >= 0 ? zeroX : zeroX - width,
    width,
  }
}

function barHeightPx(value: number, maxPx: number): number {
  return Math.max(4, Math.round((value / TRADE_OUTCOME_MAX) * maxPx))
}

function valueToneClass(tone: LandingBacktestPipsTone): string {
  if (tone === 'good') return 'text-teal-600 dark:text-teal-400'
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
      className={clsx('mb-1.5 text-2xl font-semibold tabular-nums', valueToneClass(tone))}
      aria-live="polite"
      aria-atomic="true"
    >
      {formatHeroLiveMoney(amount, live.signed)}
    </p>
  )
}

function HeroStatBlock({ stat, label }: { stat: LandingHeroHeadlineStat; label: string }) {
  return (
    <div className="px-6 py-5">
      <p className="mb-2 inline-flex items-center gap-1 text-sm text-neutral-500 dark:text-neutral-400">
        {label}
        {stat.showHint ? <Info className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden /> : null}
      </p>
      {stat.live ? (
        <HeroLiveMoneyValue live={stat.live} tone={stat.valueTone} />
      ) : (
        <p className={clsx('mb-1.5 text-2xl font-semibold tabular-nums', valueToneClass(stat.valueTone))}>
          {stat.value}
        </p>
      )}
      <p className="text-xs text-neutral-400">{stat.sub}</p>
    </div>
  )
}

function HeroOverviewStat({
  label,
  value,
  showAdd,
}: {
  label: string
  value: string
  showAdd?: boolean
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
        {showAdd ? (
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-teal-200 text-teal-600 dark:border-teal-800 dark:text-teal-400"
            aria-hidden
          >
            <Plus className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
      <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{value}</p>
    </div>
  )
}

function HeroTradeOutcomeChart() {
  const t = useT()
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  return (
    <div className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
          {t.dashboard.tradeOutcomeTitle}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t.dashboard.tradeOutcomeSubtitle}
        </p>
      </div>
      <div className="relative flex h-52 gap-2 pl-10 pr-1">
        <div
          className="absolute inset-0 left-10 grid grid-rows-4 border-b border-l border-neutral-200 pr-1 dark:border-neutral-700"
          aria-hidden
        >
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="border-t border-dashed border-neutral-100 dark:border-neutral-800" />
          ))}
        </div>
        <div className="absolute left-0 top-0 flex h-[calc(100%-1.25rem)] w-9 flex-col justify-between py-1 text-[9px] tabular-nums text-neutral-400">
          {['$900', '$600', '$300', '$0'].map(tick => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
        <div className="relative flex min-h-0 flex-1 items-end justify-between gap-1.5 pb-5">
          {TRADE_OUTCOME_DAYS.map(day => (
            <div key={day.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
              <div className="flex h-[8.5rem] w-full max-w-[26px] items-end justify-center gap-0.5">
                <div
                  className="w-[46%] min-w-[5px] rounded-t"
                  style={{
                    height: barHeightPx(day.loss, 136),
                    backgroundColor: colors.barActive.loss,
                  }}
                />
                <div
                  className="w-[46%] min-w-[5px] rounded-t bg-teal-600"
                  style={{ height: barHeightPx(day.profit, 136) }}
                />
              </div>
              <span className="mt-1 text-[10px] text-neutral-400">{day.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex justify-center gap-6 text-xs text-neutral-500">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-sm"
            style={{ backgroundColor: colors.barActive.loss }}
          />
          {t.dashboard.chartLoss}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-teal-600" />
          {t.dashboard.chartProfit}
        </span>
      </div>
    </div>
  )
}

function HeroChannelProfitChart() {
  const t = useT()
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  const plotH = 168
  const plotW = 256
  const rowCount = CHANNEL_PROFIT_ROWS.length
  const rowGap = plotH / rowCount
  const barHeight = 14
  const labelWidth = 84

  const xTicks = [0, 1, 2, 3, 4].map(
    i => CHANNEL_PROFIT_MIN + (CHANNEL_PROFIT_SPAN * i) / 4,
  )
  const zeroX = ((0 - CHANNEL_PROFIT_MIN) / CHANNEL_PROFIT_SPAN) * plotW

  return (
    <div className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
          {t.dashboard.channelProfitTitle}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t.dashboard.channelProfitSubtitle}
        </p>
      </div>
      <div className="flex h-52 min-h-[13rem] flex-col">
        <div
          className="grid min-h-0 flex-1 gap-x-1"
          style={{ gridTemplateColumns: `${labelWidth}px 1fr`, gridTemplateRows: '1fr auto' }}
        >
          <div className="col-start-1 row-start-1 flex min-h-0 flex-col">
            {CHANNEL_PROFIT_ROWS.map(row => (
              <div
                key={row.label}
                className="flex min-h-0 flex-1 items-center justify-end pr-1"
              >
                <span className="block max-w-full truncate text-right text-[9px] leading-none text-neutral-400 dark:text-neutral-500">
                  {row.label}
                </span>
              </div>
            ))}
          </div>
          <svg
            viewBox={`0 0 ${plotW} ${plotH}`}
            className="col-start-2 row-start-1 min-h-0 h-full w-full"
            preserveAspectRatio="none"
            aria-hidden
          >
            {[0, 1, 2, 3, 4].map(i => {
              const x = (plotW * i) / 4
              return (
                <line
                  key={i}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={plotH}
                  stroke="currentColor"
                  className="text-neutral-100 dark:text-neutral-800"
                  strokeDasharray="4 4"
                />
              )
            })}
            <line
              x1={zeroX}
              x2={zeroX}
              y1={0}
              y2={plotH}
              stroke="currentColor"
              className="text-neutral-200 dark:text-neutral-700"
            />
            {CHANNEL_PROFIT_ROWS.map((row, i) => {
              const { x, width } = channelBarGeometry(row.pnl, plotW)
              const y = rowGap * i + (rowGap - barHeight) / 2
              return (
                <rect
                  key={row.label}
                  x={x}
                  y={y}
                  width={Math.max(width, 2)}
                  height={barHeight}
                  rx={4}
                  fill={row.pnl >= 0 ? colors.signedPnl.profit : colors.signedPnl.loss}
                />
              )
            })}
          </svg>
          <div className="col-start-2 row-start-2 grid grid-cols-5 pt-1.5 text-center text-[10px] tabular-nums text-neutral-400">
            {xTicks.map(tick => (
              <span key={tick}>{formatHeroAxisMoney(tick)}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function copierStatusClass(status: LandingHeroCopierLogRow['status']): string {
  switch (status) {
    case 'executed':
      return 'text-teal-700 bg-teal-50 dark:text-teal-300 dark:bg-teal-950/60'
    case 'parsed':
      return 'text-teal-700 bg-teal-50 dark:text-teal-300 dark:bg-teal-950/60'
    case 'skipped':
      return 'text-warning-800 bg-warning-50 dark:!text-amber-100 dark:!bg-amber-900'
    case 'failed':
      return 'text-neutral-700 bg-neutral-100 dark:text-neutral-300 dark:bg-neutral-800/70'
    default:
      return 'text-neutral-600 bg-neutral-100 dark:text-neutral-300 dark:bg-neutral-800'
  }
}

export function HeroDashboardPreview() {
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

  const navSections = [
    {
      label: t.nav.sections.general,
      items: [
        { icon: LayoutDashboard, label: t.nav.items.dashboard, active: true },
        { icon: Landmark, label: t.nav.items.brokers, active: false },
        { icon: History, label: t.nav.items.trades, active: false },
      ],
    },
    {
      label: t.nav.sections.signals,
      items: [
        { icon: Send, label: t.nav.items.channels, active: false },
        { icon: LayoutTemplate, label: t.nav.items.backtest, active: false },
        { icon: ScrollText, label: t.nav.items.copierLogs, active: false },
        { icon: ChartNoAxesColumn, label: t.nav.items.signalHistory, active: false },
        { icon: BarChart2, label: t.nav.items.performance, active: false },
      ],
    },
    {
      label: t.nav.sections.tradingTools,
      items: [
        { icon: Newspaper, label: t.nav.items.marketNews, active: false },
        { icon: Calendar, label: t.nav.items.economicCalendar, active: false },
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
      className="hero-dashboard-viewport w-full overflow-hidden"
      role="img"
      aria-label={l.hero.imageAlt}
    >
      <div
        className="pointer-events-none select-none text-left"
        style={{
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        <div className="flex h-full w-full overflow-hidden bg-neutral-50 dark:bg-neutral-950">
          <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-100 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex h-16 shrink-0 items-center border-b border-neutral-100 px-4 dark:border-neutral-800">
              <TscopierLogo className="h-6 w-auto" />
            </div>
            <nav className="min-h-0 flex-1 space-y-5 overflow-hidden px-3 py-4" aria-hidden>
              {navSections.map(section => (
                <div key={section.label}>
                  <p className="mb-1.5 px-3 text-[10px] font-semibold tracking-widest text-neutral-400 dark:text-neutral-500">
                    {section.label}
                  </p>
                  <div className="space-y-0.5">
                    {section.items.map(item => (
                      <div
                        key={item.label}
                        className={clsx(
                          'flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium',
                          item.active
                            ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-400'
                            : 'text-neutral-600 dark:text-neutral-400',
                        )}
                      >
                        <item.icon
                          className={clsx(
                            'h-4 w-4 shrink-0',
                            item.active && 'text-teal-600 dark:text-teal-400',
                          )}
                        />
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="z-20 flex h-16 shrink-0 items-center gap-4 border-b border-neutral-100 bg-white px-6 dark:border-neutral-800 dark:bg-neutral-900">
              <PanelLeftClose className="h-5 w-5 text-neutral-400" aria-hidden />
              <div className="flex h-9 max-w-md flex-1 items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-400 dark:border-neutral-700 dark:bg-neutral-800/80">
                <Search className="h-4 w-4 shrink-0" aria-hidden />
                <span className="truncate">{t.globalSearch.placeholder}</span>
                <span className="ml-auto hidden text-xs text-neutral-400 sm:inline">
                  {t.globalSearch.shortcut}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-300 sm:gap-2 sm:px-2.5 sm:text-sm"
                  aria-hidden
                >
                  <CopierActiveIndicator />
                  <span className="whitespace-nowrap">{t.nav.copierPause.statusRunning}</span>
                </span>
                <LanguageSwitcher />
                <ThemeToggle />
                <button
                  type="button"
                  className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  aria-hidden
                >
                  <CircleHelp className="h-5 w-5" />
                </button>
                <div className="flex items-center gap-2 rounded-lg border border-neutral-200 py-1 pl-1 pr-2 dark:border-neutral-700">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-teal-600 text-xs font-semibold text-white">
                    TS
                  </span>
                  <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Trader</span>
                  <ChevronRight className="h-3.5 w-3.5 rotate-90 text-neutral-400" aria-hidden />
                </div>
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-hidden bg-neutral-50 dark:bg-neutral-950">
              <div className="mx-auto h-full w-full max-w-[1600px] space-y-6 overflow-hidden px-8 py-8">
                <header>
                  <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                    {t.dashboard.title}
                  </h1>
                </header>

                <div className="rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                  <div className="grid grid-cols-4 divide-x divide-neutral-100 dark:divide-neutral-800">
                    {d.headlineStats.map(stat => (
                      <HeroStatBlock
                        key={stat.key}
                        stat={stat}
                        label={HEADLINE_LABELS[stat.key](t)}
                      />
                    ))}
                  </div>
                  <div className="grid grid-cols-4 gap-4 border-t border-neutral-100 p-5 dark:border-neutral-800">
                    {d.overviewStats.map(stat => (
                      <HeroOverviewStat
                        key={stat.key}
                        label={OVERVIEW_LABELS[stat.key](t)}
                        value={stat.value}
                        showAdd={stat.showAdd}
                      />
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <HeroTradeOutcomeChart />
                  <HeroChannelProfitChart />
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="min-w-0 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-teal-500" aria-hidden />
                        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                          {t.dashboard.tradeActivities}
                        </span>
                        <Info className="h-3.5 w-3.5 text-neutral-300 dark:text-neutral-400" aria-hidden />
                      </div>
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-teal-500 px-3 py-1.5 text-xs font-medium text-teal-600 dark:border-teal-600 dark:text-teal-400">
                        {t.nav.items.channels}
                        <ChevronRight className="h-3 w-3" aria-hidden />
                      </span>
                    </div>
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {d.channelWorkerLogs.map(log => (
                        <div key={log.message} className="px-5 py-3">
                          <p className="text-sm text-neutral-800 dark:text-neutral-100">{log.message}</p>
                          <p className="mt-1 text-[11px] text-neutral-400">{log.time}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="min-w-0 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                    <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-teal-500" aria-hidden />
                        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                          {t.dashboard.copierLogs}
                        </span>
                        <Info className="h-3.5 w-3.5 text-neutral-300 dark:text-neutral-400" aria-hidden />
                      </div>
                      <span className="inline-flex items-center gap-1.5 rounded-lg border border-teal-500 px-3 py-1.5 text-xs font-medium text-teal-600 dark:border-teal-600 dark:text-teal-400">
                        {t.dashboard.copierLogs}
                        <ChevronRight className="h-3 w-3" aria-hidden />
                      </span>
                    </div>
                    <div
                      className={clsx(
                        COPIER_LOG_GRID,
                        'border-b border-neutral-100 px-5 py-3 text-xs font-medium uppercase tracking-wide text-neutral-400 dark:border-neutral-800',
                      )}
                    >
                      <span>{t.copierLogs.colStatus}</span>
                      <span>{t.copierLogs.colChannel}</span>
                      <span>{t.copierLogs.colSymbol}</span>
                      <span>{t.copierLogs.colType}</span>
                      <span className="text-right">{t.copierLogs.colTime}</span>
                    </div>
                    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {d.copierLogRows.map(row => (
                        <div key={`${row.channel}-${row.time}`} className={clsx(COPIER_LOG_GRID, 'px-5 py-3')}>
                          <span
                            className={clsx(
                              'inline-flex w-fit items-center rounded-md px-2 py-0.5 text-xs font-medium',
                              copierStatusClass(row.status),
                            )}
                          >
                            {statusLabel(row.status)}
                          </span>
                          <span className="min-w-0 truncate text-xs text-neutral-500 dark:text-neutral-400">
                            {row.channel}
                          </span>
                          <span className="min-w-0 truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                            {row.symbol}
                          </span>
                          <span
                            className={clsx(
                              'min-w-0 truncate text-xs font-medium uppercase',
                              row.side === 'buy' ? 'text-primary-600' : 'text-error-600 dark:text-error-400',
                            )}
                          >
                            {row.type}
                          </span>
                          <span className="text-right text-xs tabular-nums text-neutral-400">{row.time}</span>
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
