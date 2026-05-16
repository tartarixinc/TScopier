import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useTheme } from '../../context/ThemeContext'
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'
import type { BacktestEquityRow } from '../../lib/backtestTypes'

const CHART_HEIGHT = 224

interface BacktestEquityChartProps {
  equity: BacktestEquityRow[]
}

export function BacktestEquityChart({ equity }: BacktestEquityChartProps) {
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)

  const data = equity.map(p => ({
    label: new Date(p.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    equity: p.equity,
  }))

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-neutral-400 dark:text-neutral-500"
        style={{ height: CHART_HEIGHT }}
      >
        No equity curve yet
      </div>
    )
  }

  return (
    <div className="w-full min-w-0" style={{ width: '100%', height: CHART_HEIGHT }}>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 2, bottom: 0 }}>
          <defs>
            <linearGradient id="backtestEqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0d9488" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#0d9488" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: colors.tick }} tickLine={false} />
          <YAxis
            tick={{ fontSize: 9, fill: colors.tick }}
            tickFormatter={v => `$${Number(v).toLocaleString()}`}
            width={52}
          />
          <Tooltip
            {...chartTooltipProps(colors)}
            formatter={(v, name) => [`$${Number(v ?? 0).toFixed(2)}`, String(name ?? 'Equity')]}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#0d9488"
            fill="url(#backtestEqGrad)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
