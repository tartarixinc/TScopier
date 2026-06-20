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
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'
import type { PerformanceDistributionRow } from '../../lib/performanceInsights'

interface PerformanceDistributionChartProps {
  data: PerformanceDistributionRow[]
  title: string
  subtitle: string
  emptyLabel: string
  valueLabel: string
  loading?: boolean
  stale?: boolean
  /** Bar value: realized P/L or trade count. */
  metric?: 'pnl' | 'count'
  /** When metric is pnl, bars are colored by sign (positive teal, negative red). */
  colorBySign?: boolean
}

export function PerformanceDistributionChart({
  data,
  title,
  subtitle,
  emptyLabel,
  valueLabel,
  loading,
  stale,
  metric = 'pnl',
  colorBySign = true,
}: PerformanceDistributionChartProps) {
  const { formatMoney, formatSignedMoney } = useFormatMoney()
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  const chartData = data.map(row => ({
    ...row,
    display: row.label,
  }))
  const empty = chartData.length === 0

  const dataKey = metric
  const formatMetric = (value: number) =>
    metric === 'count' ? String(Math.round(value)) : formatMoney(value)

  return (
    <div className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4 sm:p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{subtitle}</p>
      </div>
      {loading ? (
        <div className="h-72 animate-pulse rounded-xl bg-neutral-50 dark:bg-neutral-800/50" />
      ) : empty ? (
        <div className="flex h-72 items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
          {emptyLabel}
        </div>
      ) : (
        <div className={clsx('h-72 w-full min-w-0', stale && 'opacity-60 transition-opacity duration-300')}>
          <ResponsiveContainer width="100%" height={288}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: colors.tick }}
                axisLine={{ stroke: colors.axis }}
                tickLine={false}
                tickFormatter={v => formatMetric(Number(v))}
              />
              <YAxis
                type="category"
                dataKey="display"
                width={88}
                tick={{ fontSize: 11, fill: colors.tick }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                {...chartTooltipProps(colors)}
                formatter={(value, _name, item) => {
                  const payload = item?.payload as PerformanceDistributionRow | undefined
                  if (metric === 'count') {
                    const pnl = payload?.pnl ?? 0
                    return [`${Math.round(Number(value ?? 0))} trades · ${formatSignedMoney(pnl)}`, valueLabel]
                  }
                  const count = payload?.count ?? 0
                  return [`${formatSignedMoney(Number(value ?? 0))} · ${count} trades`, valueLabel]
                }}
              />
              <Bar dataKey={dataKey} name={valueLabel} radius={[0, 4, 4, 0]} maxBarSize={22}>
                {chartData.map(entry => (
                  <Cell
                    key={entry.key}
                    fill={
                      metric === 'count'
                        ? '#6366f1'
                        : colorBySign
                          ? entry.pnl >= 0
                            ? colors.signedPnl.profit
                            : colors.signedPnl.loss
                          : '#6366f1'
                    }
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
