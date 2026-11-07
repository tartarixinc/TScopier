export type SocialCopyNewsImpact = 'high' | 'medium' | 'low'

/** Symbols + Filters subset stored on social_copy_subscriptions.manual_settings. */
export type SocialCopyFilterSettings = {
  symbol_to_trade: string | null
  symbols_exclude: string[]
  time_filter_enabled: boolean
  trade_start_time: string
  trade_end_time: string
  days_filter_enabled: boolean
  trade_days: number[]
  news_trading_enabled: boolean
  allow_high_impact_news: boolean
  news_avoid_impacts: SocialCopyNewsImpact[]
  close_before_news_minutes: number
  resume_after_news_minutes: number
}

export const DEFAULT_SOCIAL_COPY_FILTER_SETTINGS: SocialCopyFilterSettings = {
  symbol_to_trade: null,
  symbols_exclude: [],
  time_filter_enabled: false,
  trade_start_time: '00:00',
  trade_end_time: '23:59',
  days_filter_enabled: false,
  trade_days: [1, 2, 3, 4, 5],
  news_trading_enabled: true,
  allow_high_impact_news: true,
  news_avoid_impacts: ['high'],
  close_before_news_minutes: 30,
  resume_after_news_minutes: 15,
}

function parseSymbolList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item ?? '').trim().toUpperCase())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,;\s]+/)
      .map(item => item.trim().toUpperCase())
      .filter(Boolean)
  }
  return []
}

function parseDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.trade_days]
  const days = value
    .map(item => Number(item))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
  return days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : [...DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.trade_days]
}

function parseImpacts(value: unknown): SocialCopyNewsImpact[] {
  if (!Array.isArray(value)) return [...DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.news_avoid_impacts]
  const impacts = value.filter((item): item is SocialCopyNewsImpact => item === 'high' || item === 'medium' || item === 'low')
  return impacts.length > 0 ? [...new Set(impacts)] : [...DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.news_avoid_impacts]
}

function clampMinutes(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(24 * 60, Math.floor(n))
}

function normalizeTime(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim()
  return /^\d{1,2}:\d{2}$/.test(raw) ? raw.padStart(5, '0') : fallback
}

export function normalizeSocialCopyFilterSettings(value: unknown): SocialCopyFilterSettings {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const newsEnabled = row.news_trading_enabled === false ? false : true
  const symbolToTrade = typeof row.symbol_to_trade === 'string' && row.symbol_to_trade.trim()
    ? row.symbol_to_trade.trim()
    : null
  return {
    symbol_to_trade: symbolToTrade,
    symbols_exclude: parseSymbolList(row.symbols_exclude),
    time_filter_enabled: row.time_filter_enabled === true,
    trade_start_time: normalizeTime(row.trade_start_time, DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.trade_start_time),
    trade_end_time: normalizeTime(row.trade_end_time, DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.trade_end_time),
    days_filter_enabled: row.days_filter_enabled === true,
    trade_days: parseDays(row.trade_days),
    news_trading_enabled: newsEnabled,
    allow_high_impact_news: newsEnabled,
    news_avoid_impacts: parseImpacts(row.news_avoid_impacts),
    close_before_news_minutes: clampMinutes(row.close_before_news_minutes, DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.close_before_news_minutes),
    resume_after_news_minutes: clampMinutes(row.resume_after_news_minutes, DEFAULT_SOCIAL_COPY_FILTER_SETTINGS.resume_after_news_minutes),
  }
}

export function symbolListToText(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value.join(', ')
  return value?.trim() ?? ''
}

export function parseSymbolText(value: string): string[] {
  return parseSymbolList(value)
}
