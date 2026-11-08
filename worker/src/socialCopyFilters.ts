import { parseSymbolToTradeList } from './tradeExecutor/helpers'
import { findActiveNewsBlackout } from './newsTrading/blackout'
import type { EconomicCalendarEvent } from './newsTrading/types'
import type { ScheduleFilterSettings } from './newsTrading/settings'

export type SocialCopyManualSettings = ScheduleFilterSettings & {
  symbol_to_trade?: string | null
  symbols_exclude?: string[]
}

export type SocialCopyFilterSkipReason =
  | 'symbol_not_allowed'
  | 'symbol_excluded'
  | 'filtered_day'
  | 'filtered_time'
  | 'news_blackout'

function withinTimeWindow(start: string, end: string, now: Date): boolean {
  const toMinutes = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const h = Number(m[1])
    const mm = Number(m[2])
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
    return h * 60 + mm
  }
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s == null || e == null) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  if (s <= e) return cur >= s && cur <= e
  return cur >= s || cur <= e
}

export function evaluateSocialCopyOpenFilters(args: {
  symbol: string
  manualSettings: SocialCopyManualSettings | null | undefined
  newsEvents?: EconomicCalendarEvent[]
  now?: Date
}): SocialCopyFilterSkipReason | null {
  const manual = args.manualSettings ?? {}
  const now = args.now ?? new Date()
  const symbol = String(args.symbol ?? '').trim().toUpperCase()
  if (!symbol) return 'symbol_not_allowed'

  const allowed = parseSymbolToTradeList(manual.symbol_to_trade)
  if (allowed.length > 0 && !allowed.includes(symbol)) return 'symbol_not_allowed'

  const excluded = (manual.symbols_exclude ?? []).map(item => String(item).trim().toUpperCase()).filter(Boolean)
  if (excluded.includes(symbol)) return 'symbol_excluded'

  if (manual.days_filter_enabled) {
    const days = (manual.trade_days ?? [0, 1, 2, 3, 4, 5, 6]).map(Number)
    if (!days.includes(now.getDay())) return 'filtered_day'
  }

  if (manual.time_filter_enabled && manual.trade_start_time && manual.trade_end_time) {
    if (!withinTimeWindow(manual.trade_start_time, manual.trade_end_time, now)) return 'filtered_time'
  }

  if (findActiveNewsBlackout(args.newsEvents ?? [], manual, symbol, now)) return 'news_blackout'
  return null
}
