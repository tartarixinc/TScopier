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
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'

interface TradeVolumeChartProps {
  data: TradeVolumeDay[]
  loading?: boolean
  /** Dim cached chart while a background refresh is in flight. */
  stale?: boolean
}

function formatMoney(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

export function TradeVolumeChart({ data, loading, stale }: TradeVolumeChartProps) {
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 p-4 sm:p-5 min-w-0">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Trade Outcome (7 days)</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Closed-trade profit and loss per day
        </p>
      </div>
      {loading ? (
        <div className="h-64 bg-neutral-50 dark:bg-neutral-800/50 rounded-xl animate-pulse" />
      ) : data.every(d => d.profit === 0 && d.loss === 0) ? (
        <div className="h-64 flex items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
          No closed trades in the last 7 days
        </div>
      ) : (
        <div className={clsx('h-64 w-full', stale && 'opacity-60 transition-opacity duration-300')}>
          <ResponsiveContainer width="100%" height="100%">
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
                tickFormatter={v => formatMoney(Number(v))}
                width={56}
              />
              <Tooltip
                {...chartTooltipProps(colors)}
                formatter={(value, name) => [formatMoney(Number(value ?? 0)), String(name ?? '')]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: colors.tick }} />
              <Bar
                dataKey="profit"
                name="Profit"
                fill="#0d9488"
                activeBar={{ fill: colors.barActive.profit, stroke: colors.barActive.profit }}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
              <Bar
                dataKey="loss"
                name="Loss"
                fill="#ef4444"
                activeBar={{ fill: colors.barActive.loss, stroke: colors.barActive.loss }}
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
