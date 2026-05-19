import { interpolate } from '../i18n/interpolate'
import type {
  BacktestOutcomeLabels,
  BacktestTranslations,
} from '../i18n/locales/types'
import type { BacktestSummary, BacktestTradeRow } from './backtestTypes'
import { computePipsFromSignalOutcome } from './signalPip'

export type BacktestDisplayLabels = Pick<
  BacktestTranslations,
  'outcomes' | 'banners' | 'events' | 'priceLevels'
>

const DEFAULT_DISPLAY_LABELS: BacktestDisplayLabels = {
  outcomes: {
    allTpHit: 'All TPs',
    tpThenBe: 'TP → BE',
    partial: 'Partial',
    tp1ThenSl: 'TP1 → SL',
    slHit: 'SL Hit',
    breakeven: 'BE',
    noData: 'No data',
    skipped: 'Skipped',
    open: 'Open',
  },
  banners: {
    allTpHit: 'All TPs Hit',
    slHit: 'SL Hit',
    breakeven: 'Breakeven',
    tpThenBe: 'TP → Breakeven',
    partialHit: 'Partial Hit',
    noMarketData: 'No Market Data',
    skipped: 'Skipped',
    open: 'Open',
  },
  events: {
    tpHit: 'TP{n} Hit',
    slHit: 'SL Hit',
    breakeven: 'Breakeven',
  },
  priceLevels: {
    entry: 'Entry',
    sl: 'SL',
    be: 'BE',
    tp: 'TP{n}',
  },
}

export function backtestDisplayLabels(bt: BacktestTranslations): BacktestDisplayLabels {
  return {
    outcomes: bt.outcomes,
    banners: bt.banners,
    events: bt.events,
    priceLevels: bt.priceLevels,
  }
}

export function parseSummary(raw: unknown): BacktestSummary | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as BacktestSummary
    } catch {
      return null
    }
  }
  if (typeof raw === 'object') return raw as BacktestSummary
  return null
}

/** Hide raw Massive/Polygon trace rate-limit blobs in the UI. */
export function sanitizeBacktestUserError(raw: string, rateLimitMessage?: string): string {
  const t = String(raw ?? '').trim()
  if (!t) return ''
  if (/rate limit exceeded for trace/i.test(t)) {
    return (
      rateLimitMessage
      ?? 'Market data rate limit — wait about a minute and run again, or set MASSIVE_CALLS_PER_MINUTE to 2–3 in Supabase edge secrets.'
    )
  }
  return t.replace(/\s*·\s*Rate limit exceeded for trace [a-f0-9]+\.?\s*Retry after \d+ms\.?/gi, '').trim() || t
}

/** Omit noisy API errors from import preview (rate limits are handled during the run). */
export function filterImportPreviewErrors(errors: string[]): string[] {
  return errors.filter((e) => !/rate limit exceeded for trace/i.test(e))
}

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
  labels: BacktestOutcomeLabels = DEFAULT_DISPLAY_LABELS.outcomes,
): string {
  if (
    (outcome === 'tp1_then_sl' || outcome === 'tp_then_be')
    && tpsHit > 0
    && tpCount > 0
    && tpsHit < tpCount
  ) {
    return labels.partial
  }
  if (outcome === 'tp1_then_sl' && tpsHit >= 1) return labels.tp1ThenSl
  const map: Record<string, string> = {
    all_tp_hit: labels.allTpHit,
    tp_then_be: labels.tpThenBe,
    tp1_then_sl: labels.tp1ThenSl,
    sl_before_tp: labels.slHit,
    breakeven: labels.breakeven,
    no_data: labels.noData,
    skipped: labels.skipped,
    open: labels.open,
  }
  return map[outcome] ?? BACKTEST_OUTCOME_SHORT[outcome] ?? outcome
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

/** Pip P/L from signal TP/SL levels (TelegramBacktester convention). */
export function tradePipPnl(
  trade: Pick<
    BacktestTradeRow,
    'pnl' | 'lot_size' | 'outcome' | 'symbol' | 'direction' | 'entry_price' | 'exit_price' | 'tp_levels' | 'sl' | 'tps_hit' | 'details'
  >,
): number | null {
  const details = trade.details as { pipPnl?: number } | undefined
  const fromDetails = details?.pipPnl
  if (fromDetails != null && Number.isFinite(fromDetails)) {
    return fromDetails
  }

  return computePipsFromSignalOutcome({
    symbol: trade.symbol,
    direction: trade.direction,
    entry: trade.entry_price,
    sl: trade.sl,
    tpLevels: trade.tp_levels ?? [],
    outcome: trade.outcome,
    tpsHit: trade.tps_hit,
  })
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

export interface BacktestTradeEvent {
  type: 'tp' | 'sl' | 'be'
  level?: number
  price: number
  at: string
  label: string
}

export function outcomeBannerLabel(
  outcome: string,
  tpsHit: number,
  tpCount: number,
  labels: BacktestDisplayLabels = DEFAULT_DISPLAY_LABELS,
): string {
  const { banners, outcomes } = labels
  if (outcome === 'all_tp_hit') return banners.allTpHit
  if (outcome === 'sl_before_tp') return banners.slHit
  if (outcome === 'breakeven') return banners.breakeven
  if (outcome === 'tp_then_be') return banners.tpThenBe
  if (outcome === 'tp1_then_sl' || (tpsHit > 0 && tpsHit < tpCount)) return banners.partialHit
  if (outcome === 'no_data') return banners.noMarketData
  if (outcome === 'skipped') return banners.skipped
  if (outcome === 'open') return banners.open
  return displayOutcomeLabel(outcome, tpsHit, tpCount, outcomes)
}

export function outcomeBannerTone(
  outcome: string,
  pips: number | null,
): 'success' | 'danger' | 'warning' | 'neutral' {
  if (outcome === 'no_data' || outcome === 'skipped' || outcome === 'open') return 'neutral'
  if (outcome === 'sl_before_tp') return 'danger'
  if (outcome === 'tp1_then_sl' || outcome === 'tp_then_be') return 'warning'
  if (outcome === 'all_tp_hit' || outcome === 'breakeven') return 'success'
  if (pips != null && pips > 0) return 'success'
  if (pips != null && pips < 0) return 'danger'
  return 'neutral'
}

export function formatEventTimestamp(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  })
}

export function computeRiskRewardRatio(
  entry: number,
  sl: number | null,
  tpLevels: number[],
  direction: string,
): string {
  if (!(entry > 0) || sl == null || !Number.isFinite(sl) || !tpLevels.length) return '—'
  const slDist = Math.abs(entry - sl)
  if (slDist <= 0) return '—'
  const sorted = [...tpLevels].sort((a, b) =>
    direction === 'buy' ? a - b : b - a,
  )
  const furthest = sorted[sorted.length - 1]!
  const tpDist = Math.abs(furthest - entry)
  const ratio = tpDist / slDist
  if (!Number.isFinite(ratio) || ratio <= 0) return '—'
  const rounded = Math.round(ratio * 10) / 10
  return `1:${rounded % 1 === 0 ? Math.round(rounded) : rounded}`
}

export function buildTradeEvents(
  trade: BacktestTradeRow,
  labels: BacktestDisplayLabels = DEFAULT_DISPLAY_LABELS,
): BacktestTradeEvent[] {
  const events: BacktestTradeEvent[] = []
  const details = trade.details as { tpEvents?: Array<{ index: number; price: number; ts: number }> } | undefined
  const tpEvents = details?.tpEvents
  const { events: ev } = labels

  if (tpEvents?.length) {
    for (const e of tpEvents) {
      events.push({
        type: 'tp',
        level: e.index,
        price: e.price,
        at: new Date(e.ts).toISOString(),
        label: interpolate(ev.tpHit, { n: String(e.index) }),
      })
    }
  } else if (trade.tps_hit > 0 && trade.tp_levels.length > 0) {
    const sorted = [...trade.tp_levels].sort((a, b) =>
      trade.direction === 'buy' ? a - b : b - a,
    )
    for (let i = 0; i < Math.min(trade.tps_hit, sorted.length); i++) {
      events.push({
        type: 'tp',
        level: i + 1,
        price: sorted[i]!,
        at: trade.closed_at ?? trade.signal_at,
        label: interpolate(ev.tpHit, { n: String(i + 1) }),
      })
    }
  }

  if (
    (trade.outcome === 'sl_before_tp' || trade.outcome === 'tp1_then_sl' || trade.outcome === 'tp_then_be')
    && trade.sl != null
    && Number.isFinite(trade.sl)
  ) {
    const isBe = trade.outcome === 'tp_then_be'
    events.push({
      type: isBe ? 'be' : 'sl',
      price: trade.sl,
      at: trade.closed_at ?? trade.signal_at,
      label: isBe ? ev.breakeven : ev.slHit,
    })
  }

  if (trade.outcome === 'breakeven') {
    events.push({
      type: 'be',
      price: trade.entry_price,
      at: trade.closed_at ?? trade.signal_at,
      label: ev.breakeven,
    })
  }

  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
}

export interface PriceLevelLine {
  kind: 'entry' | 'sl' | 'tp' | 'be'
  label: string
  price: number
  level?: number
}

export function buildPriceLevels(
  trade: BacktestTradeRow,
  labels: BacktestDisplayLabels = DEFAULT_DISPLAY_LABELS,
): PriceLevelLine[] {
  const lines: PriceLevelLine[] = []
  const isBuy = trade.direction === 'buy'
  const pl = labels.priceLevels

  lines.push({
    kind: 'entry',
    label: pl.entry,
    price: trade.entry_price,
  })

  if (trade.sl != null && Number.isFinite(trade.sl)) {
    lines.push({
      kind: trade.outcome === 'breakeven' || trade.outcome === 'tp_then_be' ? 'be' : 'sl',
      label: trade.outcome === 'tp_then_be' ? pl.be : pl.sl,
      price: trade.sl,
    })
  }

  const sortedTps = [...trade.tp_levels].sort((a, b) => (isBuy ? a - b : b - a))
  sortedTps.forEach((price, i) => {
    lines.push({
      kind: 'tp',
      label: interpolate(pl.tp, { n: String(i + 1) }),
      price,
      level: i + 1,
    })
  })

  return lines
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
