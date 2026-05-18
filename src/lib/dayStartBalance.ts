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
      // Already synced today before day_start was stored — don't snap open to now (zeros P/L).
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

/**
 * Stable headline today P/L: prefer closed-deal chart net when balance delta was zeroed
 * (common after intraday day-start reset or open-position summary polls).
 */
export function resolveDisplayedTodayProfit(opts: {
  balanceDelta: number | null
  balanceDayReady: boolean
  chartNetPnl: number | null
  chartHasData: boolean
}): number {
  const chart =
    opts.chartHasData && opts.chartNetPnl != null && Number.isFinite(opts.chartNetPnl)
      ? opts.chartNetPnl
      : null
  const balance =
    opts.balanceDayReady && opts.balanceDelta != null && Number.isFinite(opts.balanceDelta)
      ? opts.balanceDelta
      : null

  if (chart != null) {
    if (balance != null && Math.abs(balance) < 0.01 && Math.abs(chart) >= 0.01) return chart
    if (balance == null) return chart
    if (Math.abs(balance) >= 0.01) return balance
    return chart
  }
  return balance ?? 0
}

function normalizeDayKey(value: string | null | undefined): string {
  if (!value) return ''
  return String(value).trim().slice(0, 10)
}

export function hasBalanceDayStartForToday(
  accounts: Array<{ day_start_balance?: number | null; day_start_balance_on?: string | null }>,
  calendarDay: string,
): boolean {
  const day = normalizeDayKey(calendarDay)
  return accounts.some(
    a =>
      normalizeDayKey(a.day_start_balance_on) === day &&
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
