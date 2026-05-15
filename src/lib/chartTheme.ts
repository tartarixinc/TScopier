import type { Theme } from '../context/ThemeContext'

export interface ChartThemeColors {
  grid: string
  axis: string
  tick: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
}

export function chartThemeColors(theme: Theme): ChartThemeColors {
  if (theme === 'dark') {
    return {
      grid: '#262626',
      axis: '#404040',
      tick: '#a3a3a3',
      tooltipBg: '#171717',
      tooltipBorder: '#404040',
      tooltipText: '#f5f5f5',
    }
  }
  return {
    grid: '#f5f5f5',
    axis: '#e5e5e5',
    tick: '#737373',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e5e5e5',
    tooltipText: '#171717',
  }
}
