import type { CopyLimitPeriod } from './copyLimitTypes'

export type PeriodWindow = {
  period: CopyLimitPeriod
  periodKey: string
  startIso: string
  endIso: string
}

function zonedParts(timeZone: string, at: Date): { year: number; month: number; day: number } {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const parts = dtf.formatToParts(at)
    const filled: Record<string, string> = {}
    for (const p of parts) {
      if (p.type !== 'literal') filled[p.type] = p.value
    }
    return {
      year: Number(filled.year),
      month: Number(filled.month),
      day: Number(filled.day),
    }
  } catch {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
    }
  }
}

/** ISO week number (Monday week start) for a calendar date. */
export function isoWeekKey(year: number, month: number, day: number): { weekYear: number; week: number } {
  const d = new Date(Date.UTC(year, month - 1, day))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const weekYear = d.getUTCFullYear()
  const yearStart = new Date(Date.UTC(weekYear, 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return { weekYear, week }
}

export function periodKeyFor(
  period: CopyLimitPeriod,
  timeZone: string,
  at = new Date(),
): string {
  if (period === 'overall') return 'all'
  const { year, month, day } = zonedParts(timeZone, at)
  if (period === 'daily') {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  if (period === 'monthly') {
    return `${year}-${String(month).padStart(2, '0')}`
  }
  const { weekYear, week } = isoWeekKey(year, month, day)
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

export function periodStorageKey(period: CopyLimitPeriod, periodKey: string): string {
  return `${period}:${periodKey}`
}

/** UTC instant range for SQL filters (inclusive start, exclusive end). */
export function periodWindowUtc(
  period: CopyLimitPeriod,
  timeZone: string,
  at = new Date(),
): PeriodWindow {
  const periodKey = periodKeyFor(period, timeZone, at)
  if (period === 'overall') {
    return {
      period,
      periodKey,
      startIso: new Date(0).toISOString(),
      endIso: new Date('2099-12-31T23:59:59.999Z').toISOString(),
    }
  }

  const { year, month, day } = zonedParts(timeZone, at)
  let startUtc: Date
  let endUtc: Date

  if (period === 'daily') {
    startUtc = zonedMidnightUtc(year, month, day, timeZone)
    endUtc = zonedMidnightUtc(year, month, day + 1, timeZone)
  } else if (period === 'monthly') {
    startUtc = zonedMidnightUtc(year, month, 1, timeZone)
    const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
    endUtc = zonedMidnightUtc(nextMonth.y, nextMonth.m, 1, timeZone)
  } else {
    const { weekYear, week } = isoWeekKey(year, month, day)
    const monday = isoWeekMonday(weekYear, week)
    startUtc = zonedMidnightUtc(monday.year, monday.month, monday.day, timeZone)
    endUtc = zonedMidnightUtc(monday.year, monday.month, monday.day + 7, timeZone)
  }

  return { period, periodKey, startIso: startUtc.toISOString(), endIso: endUtc.toISOString() }
}

function isoWeekMonday(weekYear: number, week: number): { year: number; month: number; day: number } {
  const simple = new Date(Date.UTC(weekYear, 0, 1 + (week - 1) * 7))
  const dow = simple.getUTCDay()
  const diff = dow <= 4 ? dow - 1 : dow - 8
  simple.setUTCDate(simple.getUTCDate() - diff)
  return {
    year: simple.getUTCFullYear(),
    month: simple.getUTCMonth() + 1,
    day: simple.getUTCDate(),
  }
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
  const offsetMin = getTimezoneOffsetMinutesSafe(timeZone, guess)
  return new Date(guess.getTime() - offsetMin * 60_000)
}

function getTimezoneOffsetMinutesSafe(timeZone: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const parts = dtf.formatToParts(at)
    const filled: Record<string, string> = {}
    for (const p of parts) {
      if (p.type !== 'literal') filled[p.type] = p.value
    }
    const asUtc = Date.UTC(
      Number(filled.year),
      Number(filled.month) - 1,
      Number(filled.day),
      Number(filled.hour),
      Number(filled.minute),
      Number(filled.second),
    )
    return Math.round((asUtc - at.getTime()) / 60_000)
  } catch {
    return 0
  }
}

export function pruneExpiredPauseKeys(
  pausedKeys: string[],
  timeZone: string,
  at = new Date(),
): string[] {
  return pausedKeys.filter(key => {
    const parts = key.split(':')
    if (parts.length < 2) return false
    const period = parts[1] as CopyLimitPeriod
    if (period === 'overall') return true
    const keyPeriod = parts[2]
    if (!keyPeriod) return false
    return keyPeriod === periodKeyFor(period, timeZone, at)
  })
}
