import type { BrokerAccount } from '../types/database'
import { inferBrokerLabelFromServer } from './brokerFromServer'
import { coerceMtTimestamp, parseMtHistoryTimestamp } from './mtApiDateTime'
import type { MtTrade } from './metatraderapi'

/** Normalized trade row for dashboard charts (MT or DB). */
export interface DashboardChartTrade {
  brokerAccountId: string
  lotSize: number
  profit: number | null
  status: 'open' | 'closed'
  closedAt: string | null
  openedAt: string | null
}

export interface TradeVolumeDay {
  key: string
  label: string
  volume: number
  profit: number
  /** Absolute loss magnitude (positive number for chart height). */
  loss: number
}

export interface AccountGrowthSeries {
  id: string
  name: string
  color: string
}

/** How far back to pull MT closed history for charts and linked-account total P/L. */
export const DASHBOARD_MT_HISTORY_DAYS = 365 * 10

export const ACCOUNT_CHART_COLORS = [
  '#0d9488',
  '#6366f1',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
  '#f97316',
  '#3b82f6',
] as const

function startOfLocalDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shortDayLabel(d: Date): string {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Local calendar day of an MT close/open timestamp. */
export function closedTradeLocalDay(
  iso: string | number | null | undefined,
): Date | null {
  const ts = parseMtHistoryTimestamp(iso)
  if (ts != null) return startOfLocalDay(new Date(ts))
  if (iso == null || iso === '') return null
  const direct = new Date(typeof iso === 'number' ? iso : String(iso))
  return Number.isFinite(direct.getTime()) ? startOfLocalDay(direct) : null
}

export function closedTradeDayKey(
  iso: string | number | null | undefined,
): string | null {
  const d = closedTradeLocalDay(iso)
  return d ? dayKey(d) : null
}

/** Calendar day key for a closed chart row (close time, else open time). */
export function chartTradeDayKey(t: DashboardChartTrade): string | null {
  if (t.status !== 'closed') return null
  return closedTradeDayKey(t.closedAt) ?? closedTradeDayKey(t.openedAt)
}

export function mtTradeToChartRow(t: MtTrade): DashboardChartTrade | null {
  const brokerAccountId = String(t.broker_id ?? '').trim()
  if (!brokerAccountId) return null
  if (t.direction !== 'buy' && t.direction !== 'sell') return null
  return {
    brokerAccountId,
    lotSize: Number(t.lot_size) || 0,
    profit: typeof t.profit === 'number' && Number.isFinite(t.profit) ? t.profit : null,
    status: t.status,
    closedAt: coerceMtTimestamp(t.closed_at),
    openedAt: coerceMtTimestamp(t.opened_at),
  }
}

export function resolveDashboardChartTrades(
  mtTrades: MtTrade[] | null | undefined,
  dbTrades: Parameters<typeof dbTradeToChartRow>[0][],
): DashboardChartTrade[] {
  if (mtTrades && mtTrades.length > 0) {
    return mtTrades
      .map(mtTradeToChartRow)
      .filter((r): r is DashboardChartTrade => r != null)
  }
  return dbTrades
    .map(dbTradeToChartRow)
    .filter((r): r is DashboardChartTrade => r != null)
}

export function dbTradeToChartRow(t: {
  broker_account_id: string | null
  lot_size: number
  profit: number | null
  status: string
  closed_at: string | null
  opened_at: string
}): DashboardChartTrade | null {
  const brokerAccountId = String(t.broker_account_id ?? '').trim()
  if (!brokerAccountId) return null
  return {
    brokerAccountId,
    lotSize: Number(t.lot_size) || 0,
    profit: typeof t.profit === 'number' && Number.isFinite(t.profit) ? t.profit : null,
    status: t.status === 'closed' ? 'closed' : 'open',
    closedAt: t.closed_at,
    openedAt: t.opened_at,
  }
}

/** Last N calendar days (including today), closed-trade P/L per day. */
export function buildTradeVolumeByDays(
  trades: DashboardChartTrade[],
  dayCount: number,
  now = new Date(),
): TradeVolumeDay[] {
  const count = Math.max(1, Math.floor(dayCount))
  const today = startOfLocalDay(now)
  const days: Date[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    days.push(d)
  }

  const buckets = new Map<string, TradeVolumeDay>()
  for (const d of days) {
    const key = dayKey(d)
    buckets.set(key, { key, label: shortDayLabel(d), volume: 0, profit: 0, loss: 0 })
  }

  for (const t of trades) {
    if (t.status !== 'closed') continue
    const key = chartTradeDayKey(t)
    if (!key) continue
    const bucket = buckets.get(key)
    if (!bucket) continue
    bucket.volume += t.lotSize
    const p = t.profit ?? 0
    if (p > 0) bucket.profit += p
    else if (p < 0) bucket.loss += Math.abs(p)
  }

  return days.map(d => buckets.get(dayKey(d))!).filter(Boolean)
}

/** Last 7 calendar days (including today), closed-trade P/L and lot volume per day. */
export function buildTradeVolume7Day(trades: DashboardChartTrade[], now = new Date()): TradeVolumeDay[] {
  return buildTradeVolumeByDays(trades, 7, now)
}

/** Net closed P/L for a day bucket — same figure as the Trade Outcome chart (profit bar − loss bar). */
export function netPnlFromTradeOutcomeDay(day: TradeVolumeDay | undefined): number {
  if (!day) return 0
  return day.profit - day.loss
}

/** Sum of daily net P/L across Trade Outcome buckets (profit − loss per day). */
export function sumNetPnlFromTradeVolumeDays(days: TradeVolumeDay[]): number {
  return days.reduce((sum, d) => sum + d.profit - d.loss, 0)
}

export function findTodayTradeOutcomeDay(
  trades: DashboardChartTrade[],
  now = new Date(),
): TradeVolumeDay | undefined {
  const todayKey = dayKey(startOfLocalDay(now))
  return buildTradeVolume7Day(trades, now).find(b => b.key === todayKey)
}

/** Sum deal `profit` on every closed leg per broker (same rules as Trade Outcome chart). */
export function sumClosedDealProfitByBroker(
  trades: DashboardChartTrade[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of trades) {
    if (t.status !== 'closed') continue
    const p = t.profit
    if (p == null || !Number.isFinite(p)) continue
    const id = t.brokerAccountId
    if (!id) continue
    out[id] = (out[id] ?? 0) + p
  }
  return out
}

const OUTCOME_EPSILON = 0.01

/** Today’s closed-deal stats using the same rules as {@link buildTradeVolume7Day}. */
export function summarizeTodayFromChartTrades(
  trades: DashboardChartTrade[],
  now = new Date(),
): {
  hasData: boolean
  taken: number
  won: number
  lost: number
  breakeven: number
  /** Sum of deal profit for closes today (net P/L, matches the chart). */
  netPnl: number
} {
  const todayKey = dayKey(startOfLocalDay(now))
  let taken = 0
  let won = 0
  let lost = 0
  let breakeven = 0
  let netPnl = 0

  for (const t of trades) {
    if (t.status !== 'closed') continue
    const key = chartTradeDayKey(t)
    if (key !== todayKey) continue
    const p = t.profit
    if (p == null || !Number.isFinite(p)) continue
    taken++
    netPnl += p
    if (p > OUTCOME_EPSILON) won++
    else if (p < -OUTCOME_EPSILON) lost++
    else breakeven++
  }

  return {
    hasData: taken > 0,
    taken,
    won,
    lost,
    breakeven,
    netPnl,
  }
}

export interface AccountGrowthResult {
  data: Array<Record<string, string | number>>
  series: AccountGrowthSeries[]
}

function accountDisplayName(account: BrokerAccount): string {
  const label = account.broker_name?.trim()
    || inferBrokerLabelFromServer(account.broker_server ?? '')
    || account.label?.trim()
  return label || `Account ${account.id.slice(0, 6)}`
}

/** Daily net closed P/L per account (deal profit), keyed like {@link buildTradeVolumeByDays}. */
function dailyNetPnlByAccount(
  trades: DashboardChartTrade[],
  dayKeys: ReadonlySet<string>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const t of trades) {
    if (t.status !== 'closed') continue
    const key = chartTradeDayKey(t)
    if (!key || !dayKeys.has(key)) continue
    const p = t.profit
    if (p == null || !Number.isFinite(p)) continue
    const byDay = out.get(t.brokerAccountId) ?? new Map<string, number>()
    byDay.set(key, (byDay.get(key) ?? 0) + p)
    out.set(t.brokerAccountId, byDay)
  }
  return out
}

function resolveAccountAnchorBalance(
  account: BrokerAccount,
  balanceByAccountId: Record<string, number | undefined>,
): number | null {
  const live = balanceByAccountId[account.id]
  if (live != null && Number.isFinite(live) && live > 0) return live
  const fallback =
    account.performance_baseline_balance ?? account.last_equity ?? account.last_balance
  const n = Number(fallback)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Account balance over the same calendar-day window as Trade Outcome (default 7 days):
 * opening balance (back-calculated from current balance − period P/L) plus cumulative
 * closed-trade net P/L per day. Last point uses live balance when provided.
 */
export function buildAccountGrowthSeries(
  accounts: BrokerAccount[],
  trades: DashboardChartTrade[],
  balanceByAccountId: Record<string, number | undefined>,
  dayCount = 7,
  now = new Date(),
): AccountGrowthResult {
  const buckets = buildTradeVolumeByDays(trades, dayCount, now)
  if (buckets.length === 0) {
    return { data: [], series: [] }
  }

  const dayKeys = new Set(buckets.map(b => b.key))
  const dailyByAccount = dailyNetPnlByAccount(trades, dayKeys)
  const active = accounts.filter(a => a.is_active)

  type AccState = {
    id: string
    dataKey: string
    opening: number
    anchor: number
  }

  const states: AccState[] = []
  const series: AccountGrowthSeries[] = []

  active.forEach((account, idx) => {
    const anchor = resolveAccountAnchorBalance(account, balanceByAccountId)
    if (anchor == null) return

    let periodPnl = 0
    const daily = dailyByAccount.get(account.id)
    if (daily) {
      for (const v of daily.values()) periodPnl += v
    }

    const dataKey = `acc_${account.id.replace(/-/g, '')}`
    states.push({
      id: account.id,
      dataKey,
      opening: anchor - periodPnl,
      anchor,
    })
    series.push({
      id: account.id,
      name: accountDisplayName(account),
      color: ACCOUNT_CHART_COLORS[idx % ACCOUNT_CHART_COLORS.length]!,
    })
  })

  if (states.length === 0) {
    return { data: [], series: [] }
  }

  const lastKey = buckets[buckets.length - 1]!.key
  const running = new Map<string, number>()

  const data = buckets.map(bucket => {
    const row: Record<string, string | number> = {
      key: bucket.key,
      label: bucket.label,
    }
    const isLast = bucket.key === lastKey
    for (const st of states) {
      const daily = dailyByAccount.get(st.id)?.get(bucket.key) ?? 0
      const cum = (running.get(st.id) ?? 0) + daily
      running.set(st.id, cum)
      const value = isLast ? st.anchor : st.opening + cum
      row[st.dataKey] = Number(value.toFixed(2))
    }
    return row
  })

  return { data, series }
}
