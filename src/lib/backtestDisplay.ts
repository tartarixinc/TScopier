import type { BacktestTradeRow } from './backtestTypes'

/** Hide raw Massive/Polygon trace rate-limit blobs in the UI. */
export function sanitizeBacktestUserError(raw: string): string {
  const t = String(raw ?? '').trim()
  if (!t) return ''
  if (/rate limit exceeded for trace/i.test(t)) {
    return 'Market data rate limit — wait about a minute and run again, or set MASSIVE_CALLS_PER_MINUTE to 2–3 in Supabase edge secrets.'
  }
  return t.replace(/\s*·\s*Rate limit exceeded for trace [a-f0-9]+\.?\s*Retry after \d+ms\.?/gi, '').trim() || t
}

/** Omit noisy API errors from import preview (rate limits are handled during the run). */
export function filterImportPreviewErrors(errors: string[]): string[] {
  return errors.filter((e) => !/rate limit exceeded for trace/i.test(e))
}

/** Matches simulator `pipValuePerLot` in backtest engine. */
const PIP_VALUE_PER_LOT = 10

export const BACKTEST_OUTCOME_SHORT: Record<string, string> = {
  all_tp_hit: 'All TPs',
  tp_then_be: 'TP → BE',
  tp1_then_sl: 'Partial',
  sl_before_tp: 'SL Hit',
  breakeven: 'BE',
  no_data: 'No data',
  skipped: 'Skipped',
  open: 'Open',
}

export function displayOutcomeLabel(
  outcome: string,
  tpsHit: number,
  tpCount: number,
): string {
  if (
    (outcome === 'tp1_then_sl' || outcome === 'tp_then_be')
    && tpsHit > 0
    && tpCount > 0
    && tpsHit < tpCount
  ) {
    return 'Partial'
  }
  if (outcome === 'tp1_then_sl' && tpsHit >= 1) return 'TP1 → SL'
  return BACKTEST_OUTCOME_SHORT[outcome] ?? outcome
}

export function formatDurationMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

export function tradeDurationMs(
  signalAt: string,
  closedAt: string | null | undefined,
): number | null {
  if (!closedAt) return null
  const start = new Date(signalAt).getTime()
  const end = new Date(closedAt).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return end - start
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
