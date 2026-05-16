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

interface BacktestEquityChartProps {
  equity: BacktestEquityRow[]
}

export function BacktestEquityChart({ equity }: BacktestEquityChartProps) {
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  const data = equity.map(p => ({
    label: new Date(p.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    equity: p.equity,
    dd: p.drawdown_pct,
  }))

  if (data.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
        No equity curve yet
      </div>
    )
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 2, bottom: 0 }}>
          <defs>
            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
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
            formatter={(v, name) => {
              const n = Number(v ?? 0)
              return [
                name === 'equity' ? `$${n.toFixed(2)}` : `${n.toFixed(2)}%`,
                name === 'equity' ? 'Equity' : 'Drawdown',
              ]
            }}
          />
          <Area type="monotone" dataKey="equity" stroke="#0d9488" fill="url(#eqGrad)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
