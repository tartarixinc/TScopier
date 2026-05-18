/** Local calendar day as YYYY-MM-DD (browser / dashboard timezone). */
export function formatLocalCalendarDay(ref = new Date()): string {
  const y = ref.getFullYear()
  const m = String(ref.getMonth() + 1).padStart(2, '0')
  const d = String(ref.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Map an ISO timestamp to a local calendar day using `Date.getTimezoneOffset()`. */
export function isoToLocalCalendarDay(iso: string, timezoneOffsetMinutes: number): string {
  const utcMs = new Date(iso).getTime()
  if (!Number.isFinite(utcMs)) return ''
  const localMs = utcMs - timezoneOffsetMinutes * 60_000
  const d = new Date(localMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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

/**
 * Decide the balance snapshot for today's P/L.
 * On a new day, prefer the last synced balance from a prior local day as the open.
 */
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

  if (storedDay === calendarDay && storedStart != null && Number.isFinite(storedStart)) {
    return { dayStartBalance: storedStart, dayStartOn: calendarDay, rolled: false }
  }

  let start = currentBalance
  if (lastBalance != null && Number.isFinite(lastBalance) && lastSyncedAt) {
    const syncDay = isoToLocalCalendarDay(lastSyncedAt, timezoneOffsetMinutes)
    if (syncDay && syncDay < calendarDay) {
      start = lastBalance
    }
  }

  return { dayStartBalance: start, dayStartOn: calendarDay, rolled: true }
}

export function accountTodaysProfitFromBalance(
  balance: number | null | undefined,
  dayStartBalance: number | null | undefined,
  dayStartOn: string | null | undefined,
  calendarDay: string,
): number | null {
  if (balance == null || !Number.isFinite(balance)) return null
  if (dayStartOn !== calendarDay || dayStartBalance == null || !Number.isFinite(dayStartBalance)) {
    return null
  }
  return balance - dayStartBalance
}

export function hasBalanceDayStartForToday(
  accounts: Array<{ day_start_balance?: number | null; day_start_balance_on?: string | null }>,
  calendarDay: string,
): boolean {
  return accounts.some(
    a =>
      a.day_start_balance_on === calendarDay &&
      a.day_start_balance != null &&
      Number.isFinite(Number(a.day_start_balance)),
  )
}

export function aggregateTodaysProfitFromDayStart(
  accounts: Array<{
    id: string
    is_active?: boolean
    connection_status?: string | null
    day_start_balance?: number | null
    day_start_balance_on?: string | null
  }>,
  balanceByAccountId: Record<string, { balance?: number } | undefined>,
  calendarDay: string,
  opts?: { connectedOnly?: boolean },
): number | null {
  let sum = 0
  let count = 0
  for (const account of accounts) {
    if (account.is_active === false) continue
    if (opts?.connectedOnly && account.connection_status !== 'connected') continue
    const balance = balanceByAccountId[account.id]?.balance
    const profit = accountTodaysProfitFromBalance(
      balance,
      account.day_start_balance,
      account.day_start_balance_on,
      calendarDay,
    )
    if (profit == null || !Number.isFinite(profit)) continue
    sum += profit
    count++
  }
  return count > 0 ? sum : null
}
