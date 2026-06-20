import type { CSSProperties } from 'react'
import type { Theme } from '../context/ThemeContext'

export interface ChartThemeColors {
  grid: string
  axis: string
  tick: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
  /** Band behind hovered bars (Recharts default cursor is light gray). */
  cursorFill: string
  tooltipShadow: string
  barActive: {
    profit: string
    loss: string
    volume: string
  }
  /** Horizontal / signed P/L bars (e.g. profit by channel). */
  signedPnl: {
    profit: string
    loss: string
  }
}

import { LOSS_COLOR } from './pnlDisplay'

export const LOSS_CHART_COLOR = LOSS_COLOR

export function chartThemeColors(theme: Theme): ChartThemeColors {
  if (theme === 'dark') {
    return {
      grid: '#262626',
      axis: '#404040',
      tick: '#a3a3a3',
      tooltipBg: '#0f172a',
      tooltipBorder: '#334155',
      tooltipText: '#f1f5f9',
      cursorFill: 'rgba(51, 65, 85, 0.55)',
      tooltipShadow: '0 4px 12px rgba(0, 0, 0, 0.45)',
      barActive: {
        profit: '#2dd4bf',
        loss: LOSS_CHART_COLOR,
        volume: '#94a3b8',
      },
      signedPnl: {
        profit: '#0d9488',
        loss: LOSS_CHART_COLOR,
      },
    }
  }
  return {
    grid: '#f5f5f5',
    axis: '#e5e5e5',
    tick: '#737373',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e5e5e5',
    tooltipText: '#171717',
    cursorFill: 'rgba(241, 245, 249, 0.85)',
    tooltipShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
    barActive: {
      profit: '#14b8a6',
      loss: LOSS_CHART_COLOR,
      volume: '#737373',
    },
    signedPnl: {
      profit: '#0d9488',
      loss: LOSS_CHART_COLOR,
    },
  }
}

/** Shared Recharts tooltip props so hover popover + cursor match light/dark theme. */
export function chartTooltipProps(colors: ChartThemeColors) {
  return {
    cursor: { fill: colors.cursorFill },
    contentStyle: {
      borderRadius: 8,
      border: `1px solid ${colors.tooltipBorder}`,
      backgroundColor: colors.tooltipBg,
      color: colors.tooltipText,
      fontSize: 12,
      boxShadow: colors.tooltipShadow,
    } satisfies CSSProperties,
    labelStyle: { color: colors.tooltipText, fontWeight: 600 } satisfies CSSProperties,
    itemStyle: { color: colors.tooltipText } satisfies CSSProperties,
  }
}
