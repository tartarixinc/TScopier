/** Local calendar day key YYYY-MM-DD from offset minutes (same as JS getTimezoneOffset). */
export function isoToLocalCalendarDay(iso: string, timezoneOffsetMinutes: number): string {
  const utcMs = new Date(iso).getTime()
  if (!Number.isFinite(utcMs)) return ""
  const localMs = utcMs - timezoneOffsetMinutes * 60_000
  const d = new Date(localMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function normalizeDayKey(value: string | null | undefined): string {
  if (!value) return ""
  return String(value).trim().slice(0, 10)
}

export type DayStartRollInput = {
  calendarDay: string
  currentBalance: number
  storedDay: string | null | undefined
  storedStart: number | null | undefined
  lastBalance: number | null | undefined
  lastSyncedAt: string | null | undefined
  timezoneOffsetMinutes: number
}

export function resolveDayStartBalance(input: DayStartRollInput): {
  dayStartBalance: number
  dayStartOn: string
  rolled: boolean
} {
  const {
    calendarDay,
    currentBalance,
    storedDay,
    storedStart,
    lastBalance,
    lastSyncedAt,
    timezoneOffsetMinutes,
  } = input

  const day = normalizeDayKey(calendarDay)
  const stored = normalizeDayKey(storedDay)
  if (stored === day && storedStart != null && Number.isFinite(storedStart)) {
    return { dayStartBalance: storedStart, dayStartOn: day, rolled: false }
  }

  let start = currentBalance
  if (lastBalance != null && Number.isFinite(lastBalance) && lastSyncedAt) {
    const syncDay = isoToLocalCalendarDay(lastSyncedAt, timezoneOffsetMinutes)
    if (syncDay && syncDay < day) {
      start = lastBalance
    } else if (syncDay === day) {
      start = lastBalance
    }
  }

  return { dayStartBalance: start, dayStartOn: day, rolled: true }
}

export function accountTodaysProfitFromBalance(
  balance: number | null | undefined,
  dayStartBalance: number | null | undefined,
  dayStartOn: string | null | undefined,
  calendarDay: string,
): number | null {
  if (balance == null || !Number.isFinite(balance)) return null
  if (
    normalizeDayKey(dayStartOn) !== normalizeDayKey(calendarDay) ||
    dayStartBalance == null ||
    !Number.isFinite(dayStartBalance)
  ) {
    return null
  }
  return balance - dayStartBalance
}
