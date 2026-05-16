import type { BacktestTradeRow } from './backtestTypes'

/** Matches simulator `pipValuePerLot` in backtest engine. */
const PIP_VALUE_PER_LOT = 10

export const BACKTEST_OUTCOME_SHORT: Record<string, string> = {
  all_tp_hit: 'All TPs',
  tp_then_be: 'TP → BE',
  tp1_then_sl: 'TP1 → SL',
  sl_before_tp: 'SL',
  breakeven: 'BE',
  no_data: 'No data',
  skipped: 'Skipped',
  open: 'Open',
}

/** Price-distance pips implied by simulated dollar P/L (same units as engine). */
export function tradePipPnl(trade: Pick<BacktestTradeRow, 'pnl' | 'lot_size' | 'outcome'>): number | null {
  if (trade.outcome === 'skipped' || trade.outcome === 'no_data') return null
  const lot = trade.lot_size > 0 ? trade.lot_size : 0.01
  const denom = lot * PIP_VALUE_PER_LOT * 100
  if (denom <= 0) return null
  return trade.pnl / denom
}

export function formatPipValue(pips: number | null): string {
  if (pips == null || !Number.isFinite(pips)) return '—'
  const sign = pips >= 0 ? '+' : ''
  return `${sign}${pips.toFixed(1)}p`
}

export function formatEntryPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '—'
  if (price >= 100) return price.toFixed(price >= 1000 ? 1 : 0)
  if (price >= 1) return price.toFixed(2)
  return price.toFixed(4)
}

export function formatSignalTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day} ${h}:${min}`
}

export function monthGroupKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function monthGroupLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  if (!y || !m) return key
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' })
}

export function outcomeTone(
  outcome: string,
  pips: number | null,
): 'good' | 'bad' | 'neutral' {
  if (outcome === 'skipped' || outcome === 'no_data' || outcome === 'open') return 'neutral'
  if (pips != null) {
    if (pips > 0) return 'good'
    if (pips < 0) return 'bad'
  }
  if (outcome === 'sl_before_tp') return 'bad'
  if (outcome === 'all_tp_hit' || outcome === 'tp_then_be') return 'good'
  return 'neutral'
}
