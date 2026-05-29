import clsx from 'clsx'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TradeVolumeDay } from '../../lib/dashboardCharts'
import { useTheme } from '../../context/ThemeContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'

interface PerformanceTradeOutcomeChartProps {
  data: TradeVolumeDay[]
  title: string
  subtitle: string
  emptyLabel: string
  profitLabel: string
  lossLabel: string
  loading?: boolean
  stale?: boolean
}

export function PerformanceTradeOutcomeChart({
  data,
  title,
  subtitle,
  emptyLabel,
  profitLabel,
  lossLabel,
  loading,
  stale,
}: PerformanceTradeOutcomeChartProps) {
  const { formatMoney } = useFormatMoney()
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  const empty = data.every((d) => d.profit === 0 && d.loss === 0)

  return (
    <div className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4 sm:p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{subtitle}</p>
      </div>
      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-neutral-50 dark:bg-neutral-800/50" />
      ) : empty ? (
        <div className="flex h-64 items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
          {emptyLabel}
        </div>
      ) : (
        <div className={clsx('h-64 w-full min-w-0', stale && 'opacity-60 transition-opacity duration-300')}>
          <ResponsiveContainer width="100%" height={256}>
            <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: colors.tick }}
                axisLine={{ stroke: colors.axis }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: colors.tick }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => formatMoney(Number(v))}
                width={56}
              />
              <Tooltip
                {...chartTooltipProps(colors)}
                formatter={(value, name) => [formatMoney(Number(value ?? 0)), String(name ?? '')]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: colors.tick }} />
              <Bar
                dataKey="loss"
                name={lossLabel}
                fill={colors.barActive.loss}
                activeBar={{ fill: colors.barActive.loss, stroke: colors.barActive.loss }}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
              <Bar
                dataKey="profit"
                name={profitLabel}
                fill="#0d9488"
                activeBar={{ fill: colors.barActive.profit, stroke: colors.barActive.profit }}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
