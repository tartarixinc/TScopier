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
}

function formatMoney(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

export function TradeVolumeChart({ data, loading }: TradeVolumeChartProps) {
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 p-4 sm:p-5 min-w-0">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Trade Outcome (7 days)</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Closed-trade lots, profit, and loss per day
        </p>
      </div>
      {loading ? (
        <div className="h-64 bg-neutral-50 dark:bg-neutral-800/50 rounded-xl animate-pulse" />
      ) : data.every(d => d.volume === 0 && d.profit === 0 && d.loss === 0) ? (
        <div className="h-64 flex items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
          No closed trades in the last 7 days
        </div>
      ) : (
        <div className="h-64 w-full">
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
                yAxisId="money"
                tick={{ fontSize: 11, fill: colors.tick }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => formatMoney(Number(v))}
                width={56}
              />
              <YAxis
                yAxisId="lots"
                orientation="right"
                tick={{ fontSize: 11, fill: colors.tick }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                {...chartTooltipProps(colors)}
                formatter={(value, name) => {
                  const n = Number(value ?? 0)
                  const label = String(name ?? '')
                  if (label === 'Volume (lots)') return [n.toFixed(2), label]
                  return [formatMoney(n), label]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: colors.tick }} />
              <Bar
                yAxisId="money"
                dataKey="profit"
                name="Profit"
                fill="#0d9488"
                activeBar={{ fill: colors.barActive.profit, stroke: colors.barActive.profit }}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
              <Bar
                yAxisId="money"
                dataKey="loss"
                name="Loss"
                fill="#ef4444"
                activeBar={{ fill: colors.barActive.loss, stroke: colors.barActive.loss }}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
              <Bar
                yAxisId="lots"
                dataKey="volume"
                name="Volume (lots)"
                fill="#737373"
                activeBar={{ fill: colors.barActive.volume, stroke: colors.barActive.volume }}
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
