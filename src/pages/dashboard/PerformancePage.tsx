import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Percent,
  RefreshCw,
  Scale,
  Target,
  TrendingUp,
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { buildTradeVolumeByDays } from '../../lib/dashboardCharts'
import { periodToDays, type PerformancePeriod } from '../../lib/performanceAnalytics'
import { usePerformanceData } from '../../hooks/usePerformanceData'
import { AccountGrowthChart } from '../../components/dashboard/AccountGrowthChart'
import { AccountPerformanceTable } from '../../components/performance/AccountPerformanceTable'
import { PerformancePeriodTabs } from '../../components/performance/PerformancePeriodTabs'
import { PerformanceStatCard } from '../../components/performance/PerformanceStatCard'
import { PerformanceTradeOutcomeChart } from '../../components/performance/PerformanceTradeOutcomeChart'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'

function formatMoney(v: number): string {
  const sign = v < 0 ? '-' : ''
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPct(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

function formatRoi(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

export function PerformancePage() {
  const t = useT()
  const p = t.performance
  const { user } = useAuth()
  const [period, setPeriod] = useState<PerformancePeriod>('30d')

  const {
    accounts,
    chartTrades,
    perAccountPerformance,
    aggregate,
    accountGrowth,
    periodStats,
    equityByAccountId,
    loading,
    refreshing,
    error,
    lastUpdated,
    refresh,
  } = usePerformanceData(user?.id)

  const stats = useMemo(() => periodStats(period), [periodStats, period])

  const volumeData = useMemo(
    () => buildTradeVolumeByDays(chartTrades, periodToDays(period)),
    [chartTrades, period],
  )

  const periodLabels: Record<PerformancePeriod, string> = {
    '7d': p.period7d,
    '30d': p.period30d,
    '90d': p.period90d,
    all: p.periodAll,
  }

  const outcomeTitle =
    period === 'all'
      ? p.outcomeTitleAll
      : interpolate(p.outcomeTitle, { days: String(periodToDays(period)) })

  const lastUpdatedLabel = lastUpdated
    ? interpolate(p.lastUpdated, {
        time: lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      })
    : null

  const pfLabel =
    stats.profitFactor != null
      ? stats.profitFactor.toFixed(2)
      : stats.realizedPnl > 0
        ? '∞'
        : '—'

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 lg:p-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">{p.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">{p.subtitle}</p>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:items-end">
          <PerformancePeriodTabs value={period} labels={periodLabels} onChange={setPeriod} />
          <div className="flex items-center justify-end gap-2">
            {lastUpdatedLabel && !loading ? (
              <span className="text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                {lastUpdatedLabel}
              </span>
            ) : null}
            <Button variant="secondary" size="sm" loading={refreshing} disabled={loading} onClick={refresh}>
              <RefreshCw className="h-4 w-4" />
              {t.common.refresh}
            </Button>
          </div>
        </div>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <PerformanceStatCard
          label={p.realizedPnl}
          value={loading ? '—' : formatMoney(stats.realizedPnl)}
          sub={interpolate(p.closedTrades, { count: String(stats.tradesTaken) })}
          icon={stats.realizedPnl >= 0 ? ArrowUpRight : ArrowDownRight}
          tone={stats.realizedPnl > 0 ? 'positive' : stats.realizedPnl < 0 ? 'negative' : 'neutral'}
        />
        <PerformanceStatCard
          label={p.winRate}
          value={loading ? '—' : formatPct(stats.winRate, 0)}
          sub={interpolate(p.winLoss, { won: String(stats.tradesWon), lost: String(stats.tradesLost) })}
          icon={Target}
          tone={
            stats.winRate != null && stats.winRate >= 50
              ? 'positive'
              : stats.winRate != null
                ? 'negative'
                : 'neutral'
          }
        />
        <PerformanceStatCard
          label={p.profitFactor}
          value={loading ? '—' : pfLabel}
          icon={Scale}
        />
        <PerformanceStatCard
          label={p.avgRoi}
          value={loading ? '—' : formatRoi(aggregate.avgRoi)}
          sub={
            aggregate.accountsWithBaseline > 0
              ? interpolate(p.accountsTracked, { count: String(aggregate.accountsWithBaseline) })
              : p.noBaseline
          }
          icon={TrendingUp}
          tone={
            aggregate.avgRoi != null && aggregate.avgRoi > 0
              ? 'positive'
              : aggregate.avgRoi != null && aggregate.avgRoi < 0
                ? 'negative'
                : 'neutral'
          }
        />
        <PerformanceStatCard
          label={p.maxDrawdown}
          value={loading ? '—' : formatPct(aggregate.maxDrawdownPct)}
          icon={Percent}
          tone={aggregate.maxDrawdownPct != null && aggregate.maxDrawdownPct > 0 ? 'negative' : 'neutral'}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <AccountGrowthChart
          data={accountGrowth.data}
          series={accountGrowth.series}
          loading={loading}
          stale={refreshing}
        />
        <PerformanceTradeOutcomeChart
          data={volumeData}
          title={outcomeTitle}
          subtitle={p.outcomeSubtitle}
          emptyLabel={p.outcomeEmpty}
          profitLabel={t.dashboard.chartProfit}
          lossLabel={t.dashboard.chartLoss}
          loading={loading}
          stale={refreshing}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-neutral-200/80 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{p.accountsTitle}</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{p.accountsSubtitle}</p>
          </div>
          <Link
            to="/account-trades"
            className="inline-flex items-center gap-1 text-xs font-semibold text-teal-600 hover:text-teal-700 dark:text-teal-400"
          >
            <Activity className="h-3.5 w-3.5" />
            {p.viewTrades}
          </Link>
        </div>
        {loading ? (
          <div className="space-y-3 p-4 animate-pulse">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 rounded-lg bg-neutral-100 dark:bg-neutral-800" />
            ))}
          </div>
        ) : (
          <AccountPerformanceTable
            accounts={accounts}
            performance={perAccountPerformance}
            equityByAccountId={equityByAccountId}
            labels={{
              account: p.colAccount,
              broker: p.colBroker,
              equity: p.colEquity,
              roi: p.colRoi,
              winRate: p.colWinRate,
              maxDrawdown: p.colMaxDrawdown,
              configure: p.configure,
              empty: p.accountsEmpty,
            }}
          />
        )}
      </section>

      <p className="text-xs text-neutral-400 dark:text-neutral-500">{p.baselineNote}</p>
    </div>
  )
}
