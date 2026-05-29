import clsx from 'clsx'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useTheme } from '../../context/ThemeContext'
import { useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'
import type { PerformanceDistributionRow } from '../../lib/performanceInsights'

interface ChannelProfitChartProps {
  data: PerformanceDistributionRow[]
  loading?: boolean
  stale?: boolean
}

export function ChannelProfitChart({ data, loading, stale }: ChannelProfitChartProps) {
  const { formatMoney, formatSignedMoney } = useFormatMoney()
  const t = useT()
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  const chartData = data.map(row => ({ ...row, display: row.label }))
  const empty = chartData.length === 0

  return (
    <div className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4 sm:p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
          {t.dashboard.channelProfitTitle}
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t.dashboard.channelProfitSubtitle}
        </p>
      </div>
      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-neutral-50 dark:bg-neutral-800/50" />
      ) : empty ? (
        <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-neutral-400 dark:text-neutral-500">
          {t.dashboard.channelProfitEmpty}
        </div>
      ) : (
        <div className={clsx('h-64 w-full min-w-0', stale && 'opacity-60 transition-opacity duration-300')}>
          <ResponsiveContainer width="100%" height={256}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fill: colors.tick }}
                axisLine={{ stroke: colors.axis }}
                tickLine={false}
                tickFormatter={v => formatMoney(Number(v))}
              />
              <YAxis
                type="category"
                dataKey="display"
                width={84}
                tick={{ fontSize: 10, fill: colors.tick }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                {...chartTooltipProps(colors)}
                formatter={(value, _name, item) => {
                  const payload = item?.payload as PerformanceDistributionRow | undefined
                  const count = payload?.count ?? 0
                  return [`${formatSignedMoney(Number(value ?? 0))} · ${count} trades`, t.dashboard.chartProfit]
                }}
              />
              <Bar dataKey="pnl" name={t.dashboard.chartProfit} radius={[0, 4, 4, 0]} maxBarSize={20}>
                {chartData.map(entry => (
                  <Cell
                    key={entry.key}
                    fill={entry.pnl >= 0 ? colors.signedPnl.profit : colors.signedPnl.loss}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
