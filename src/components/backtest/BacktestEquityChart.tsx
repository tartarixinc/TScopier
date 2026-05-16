import { useEffect, useRef, useState } from 'react'
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
  const wrapRef = useRef<HTMLDivElement>(null)
  const [canRender, setCanRender] = useState(false)

  const data = equity.map(p => ({
    label: new Date(p.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    equity: p.equity,
    dd: p.drawdown_pct,
  }))

  useEffect(() => {
    const el = wrapRef.current
    if (!el || data.length === 0) {
      setCanRender(false)
      return
    }
    const check = () => {
      const { width, height } = el.getBoundingClientRect()
      setCanRender(width > 0 && height > 0)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [data.length])

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
    <div
      ref={wrapRef}
      className="w-full min-w-0"
      style={{ height: CHART_HEIGHT, minHeight: CHART_HEIGHT }}
    >
      {canRender ? (
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
              formatter={(v, name) => {
                const n = Number(v ?? 0)
                return [
                  name === 'equity' ? `$${n.toFixed(2)}` : `${n.toFixed(2)}%`,
                  name === 'equity' ? 'Equity' : 'Drawdown',
                ]
              }}
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
      ) : (
        <div className="h-full w-full bg-neutral-50 dark:bg-neutral-800/40 rounded-xl animate-pulse" />
      )}
    </div>
  )
}
