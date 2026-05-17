import type { EconomicCalendarEvent, EconomicImpact } from './types'
import {
  getCloseBeforeNewsMinutes,
  getNewsAvoidImpacts,
  getResumeAfterNewsMinutes,
  isNewsTradingEnabled,
  type ScheduleFilterSettings,
} from './settings'
import { eventMatchesSymbol } from './symbolCurrencies'

export type NewsBlackoutPhase = 'pre' | 'post'

export interface ActiveNewsBlackout {
  event: EconomicCalendarEvent
  phase: NewsBlackoutPhase
  windowStartMs: number
  windowEndMs: number
}

function eventTimeMs(event: EconomicCalendarEvent): number | null {
  const t = Date.parse(event.datetime)
  return Number.isFinite(t) ? t : null
}

/** True when `now` is inside a news blackout for this symbol and manual filter settings. */
export function findActiveNewsBlackout(
  events: EconomicCalendarEvent[],
  manual: ScheduleFilterSettings,
  symbol: string,
  now: Date = new Date(),
): ActiveNewsBlackout | null {
  if (isNewsTradingEnabled(manual)) return null

  const avoid = new Set<EconomicImpact>(getNewsAvoidImpacts(manual))
  const beforeMs = getCloseBeforeNewsMinutes(manual) * 60_000
  const afterMs = getResumeAfterNewsMinutes(manual) * 60_000
  const nowMs = now.getTime()

  let best: ActiveNewsBlackout | null = null

  for (const event of events) {
    if (!avoid.has(event.impact)) continue
    if (!eventMatchesSymbol(event, symbol)) continue
    const eventMs = eventTimeMs(event)
    if (eventMs == null) continue

    const windowStartMs = eventMs - beforeMs
    const windowEndMs = eventMs + afterMs
    if (nowMs < windowStartMs || nowMs > windowEndMs) continue

    const phase: NewsBlackoutPhase = nowMs < eventMs ? 'pre' : 'post'
    const candidate: ActiveNewsBlackout = { event, phase, windowStartMs, windowEndMs }
    if (!best || eventMs < eventTimeMs(best.event)!) {
      best = candidate
    }
  }

  return best
}

/** Events entering the pre-news close window (for the monitor to flatten positions). */
export function findPreNewsCloseTriggers(
  events: EconomicCalendarEvent[],
  manual: ScheduleFilterSettings,
  now: Date = new Date(),
): EconomicCalendarEvent[] {
  if (isNewsTradingEnabled(manual)) return []

  const avoid = new Set(getNewsAvoidImpacts(manual))
  const beforeMs = getCloseBeforeNewsMinutes(manual) * 60_000
  const nowMs = now.getTime()
  const out: EconomicCalendarEvent[] = []

  for (const event of events) {
    if (!avoid.has(event.impact)) continue
    const eventMs = eventTimeMs(event)
    if (eventMs == null) continue
    const windowStartMs = eventMs - beforeMs
    if (nowMs >= windowStartMs && nowMs < eventMs) out.push(event)
  }

  return out
}
