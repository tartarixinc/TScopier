import {
  Calendar,
  LineChart,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import type { PerformanceInsights } from '../../lib/performanceInsights'
import { PerformanceDistributionChart } from './PerformanceDistributionChart'
import { PerformanceStatCard } from './PerformanceStatCard'

interface PerformanceInsightsLabels {
  sectionTitle: string
  sectionSubtitle: string
  bestDay: string
  worstDay: string
  highestEquity: string
  lowestEquity: string
  bestTrade: string
  worstTrade: string
  profitByChannelTitle: string
  profitByChannelSubtitle: string
  symbolDistributionTitle: string
  symbolDistributionSubtitle: string
  distributionEmpty: string
  realizedPnl: string
  tradesCount: string
  onDate: string
}

interface PerformanceInsightsSectionProps {
  insights: PerformanceInsights
  labels: PerformanceInsightsLabels
  formatSignedMoney: (value: number) => string
  formatMoney: (value: number) => string
  loading?: boolean
  stale?: boolean
}

export function PerformanceInsightsSection({
  insights,
  labels,
  formatSignedMoney,
  formatMoney,
  loading,
  stale,
}: PerformanceInsightsSectionProps) {
  const tradeSub = (row: { symbol: string; pnl: number; broker: string; timeLabel: string }) =>
    `${row.symbol} · ${row.broker} · ${row.timeLabel}`

  const daySub = (row: { label: string; pnl: number }) =>
    `${row.label} · ${formatSignedMoney(row.pnl)}`

  const equitySub = (row: { dateLabel: string; accountName: string }) =>
    `${labels.onDate} ${row.dateLabel} · ${row.accountName}`

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
          {labels.sectionTitle}
        </h2>
        <p className="mt-1 text-sm text-neutral-900 dark:text-neutral-50">{labels.sectionSubtitle}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <PerformanceStatCard
          label={labels.bestDay}
          value={loading || !insights.bestDay ? '—' : formatSignedMoney(insights.bestDay.pnl)}
          sub={insights.bestDay ? daySub(insights.bestDay) : undefined}
          icon={Calendar}
          tone={insights.bestDay && insights.bestDay.pnl > 0 ? 'positive' : 'neutral'}
        />
        <PerformanceStatCard
          label={labels.worstDay}
          value={loading || !insights.worstDay ? '—' : formatSignedMoney(insights.worstDay.pnl)}
          sub={insights.worstDay ? daySub(insights.worstDay) : undefined}
          icon={Calendar}
          tone={insights.worstDay && insights.worstDay.pnl < 0 ? 'negative' : 'neutral'}
        />
        <PerformanceStatCard
          label={labels.highestEquity}
          value={loading || !insights.highestEquity ? '—' : formatMoney(insights.highestEquity.value)}
          sub={insights.highestEquity ? equitySub(insights.highestEquity) : undefined}
          icon={LineChart}
          tone="positive"
        />
        <PerformanceStatCard
          label={labels.lowestEquity}
          value={loading || !insights.lowestEquity ? '—' : formatMoney(insights.lowestEquity.value)}
          sub={insights.lowestEquity ? equitySub(insights.lowestEquity) : undefined}
          icon={LineChart}
          tone="neutral"
        />
        <PerformanceStatCard
          label={labels.bestTrade}
          value={loading || !insights.bestTrade ? '—' : formatSignedMoney(insights.bestTrade.pnl)}
          sub={insights.bestTrade ? tradeSub(insights.bestTrade) : undefined}
          icon={TrendingUp}
          tone="positive"
        />
        <PerformanceStatCard
          label={labels.worstTrade}
          value={loading || !insights.worstTrade ? '—' : formatSignedMoney(insights.worstTrade.pnl)}
          sub={insights.worstTrade ? tradeSub(insights.worstTrade) : undefined}
          icon={TrendingDown}
          tone="negative"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <PerformanceDistributionChart
          data={insights.profitByChannel}
          title={labels.profitByChannelTitle}
          subtitle={labels.profitByChannelSubtitle}
          emptyLabel={labels.distributionEmpty}
          valueLabel={labels.realizedPnl}
          loading={loading}
          stale={stale}
        />
        <PerformanceDistributionChart
          data={insights.symbolDistribution}
          title={labels.symbolDistributionTitle}
          subtitle={labels.symbolDistributionSubtitle}
          emptyLabel={labels.distributionEmpty}
          valueLabel={labels.tradesCount}
          loading={loading}
          stale={stale}
          metric="count"
          colorBySign={false}
        />
      </div>
    </section>
  )
}
