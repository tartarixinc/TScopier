import clsx from 'clsx'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { AccountGrowthSeries } from '../../lib/dashboardCharts'
import { useTheme } from '../../context/ThemeContext'
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'

interface AccountGrowthChartProps {
  data: Array<Record<string, string | number>>
  series: AccountGrowthSeries[]
  loading?: boolean
  stale?: boolean
}

function formatMoney(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Shorter labels for the Y-axis so values are not clipped on narrow charts. */
function formatAxisMoney(v: number): string {
  const sign = v < 0 ? '-' : ''
  const n = Math.abs(v)
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${sign}$${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return `${sign}$${k >= 10 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return `${sign}$${Math.round(n)}`
}

export function AccountGrowthChart({ data, series, loading, stale }: AccountGrowthChartProps) {
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  const dataKeyFor = (s: AccountGrowthSeries) => `acc_${s.id.replace(/-/g, '')}`

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 p-4 sm:p-5 min-w-0">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Account growth</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Equity from link date; multiple accounts shown as separate lines
        </p>
      </div>
      {loading ? (
        <div className="h-64 bg-neutral-50 dark:bg-neutral-800/50 rounded-xl animate-pulse" />
      ) : series.length === 0 || data.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-sm text-neutral-400 dark:text-neutral-500 text-center px-6">
          Connect a broker account with a performance baseline to see growth over time
        </div>
      ) : (
        <div className={clsx('h-64 w-full', stale && 'opacity-60 transition-opacity duration-300')}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: 2, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: colors.tick }}
                axisLine={{ stroke: colors.axis }}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 9, fill: colors.tick }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => formatAxisMoney(Number(v))}
                width={44}
                tickMargin={2}
              />
              <Tooltip
                {...chartTooltipProps(colors)}
                cursor={{ stroke: colors.axis, strokeWidth: 1 }}
                formatter={value => formatMoney(Number(value ?? 0))}
                labelFormatter={label => String(label)}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: colors.tick }} />
              {series.map(s => {
                const key = dataKeyFor(s)
                return (
                  <Line
                    key={s.id}
                    type="monotone"
                    dataKey={key}
                    name={s.name}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls
                  />
                )
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
