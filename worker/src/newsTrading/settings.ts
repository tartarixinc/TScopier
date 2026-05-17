import type { EconomicImpact } from './types'

/** Manual settings fields used by news / schedule filters (subset of broker manual_settings JSON). */
export interface ScheduleFilterSettings {
  time_filter_enabled?: boolean
  trade_start_time?: string
  trade_end_time?: string
  days_filter_enabled?: boolean
  trade_days?: number[]
  /** When true, copy through news windows (no calendar blackout). */
  news_trading_enabled?: boolean
  /** @deprecated Use `news_trading_enabled`. Kept for stored JSON compatibility. */
  allow_high_impact_news?: boolean
  news_avoid_impacts?: EconomicImpact[]
  close_before_news_minutes?: number
  resume_after_news_minutes?: number
}

export function isNewsTradingEnabled(manual: ScheduleFilterSettings): boolean {
  if (manual.news_trading_enabled === true) return true
  if (manual.news_trading_enabled === false) return false
  return manual.allow_high_impact_news === true
}

export function getNewsAvoidImpacts(manual: ScheduleFilterSettings): EconomicImpact[] {
  const raw = manual.news_avoid_impacts
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.filter((i): i is EconomicImpact => i === 'high' || i === 'medium' || i === 'low')
  }
  return ['high']
}

export function getCloseBeforeNewsMinutes(manual: ScheduleFilterSettings): number {
  const n = Number(manual.close_before_news_minutes ?? 10)
  return Number.isFinite(n) && n >= 0 ? Math.min(24 * 60, Math.floor(n)) : 10
}

export function getResumeAfterNewsMinutes(manual: ScheduleFilterSettings): number {
  const n = Number(manual.resume_after_news_minutes ?? 10)
  return Number.isFinite(n) && n >= 0 ? Math.min(24 * 60, Math.floor(n)) : 10
}
