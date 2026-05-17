import type { BrokerAccount } from '../types/database'
import { inferBrokerLabelFromServer } from './brokerFromServer'
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

function parseDay(iso: string | null): Date | null {
  if (!iso) return null
  const t = new Date(iso)
  return Number.isFinite(t.getTime()) ? startOfLocalDay(t) : null
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
    closedAt: t.closed_at,
    openedAt: t.opened_at,
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
    const closed = parseDay(t.closedAt)
    if (!closed) continue
    const key = dayKey(closed)
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

/** Equity curve per linked account from baseline + cumulative closed P/L; ends at live equity. */
export function buildAccountGrowthSeries(
  accounts: BrokerAccount[],
  trades: DashboardChartTrade[],
  equityByAccountId: Record<string, number | undefined>,
  now = new Date(),
): AccountGrowthResult {
  const active = accounts.filter(a => a.is_active)
  const series: AccountGrowthSeries[] = []
  const today = startOfLocalDay(now)

  type AccState = {
    id: string
    dataKey: string
    baseline: number
    start: Date
    cumByDay: Map<string, number>
  }

  const states: AccState[] = []

  active.forEach((account, idx) => {
    const baselineRaw = account.performance_baseline_balance ?? account.last_balance
    const baseline = Number(baselineRaw)
    if (!Number.isFinite(baseline) || baseline <= 0) return

    const created = parseDay(account.created_at) ?? today
    const dataKey = `acc_${account.id.replace(/-/g, '')}`
    const closedForAccount = trades
      .filter(t => t.brokerAccountId === account.id && t.status === 'closed')
      .map(t => ({ closed: parseDay(t.closedAt), profit: t.profit ?? 0 }))
      .filter((t): t is { closed: Date; profit: number } => t.closed != null)
      .sort((a, b) => a.closed.getTime() - b.closed.getTime())

    const cumByDay = new Map<string, number>()
    let running = 0
    for (const row of closedForAccount) {
      if (row.closed < created) continue
      running += row.profit
      cumByDay.set(dayKey(row.closed), running)
    }

    states.push({ id: account.id, dataKey, baseline, start: created, cumByDay })
    series.push({
      id: account.id,
      name: accountDisplayName(account),
      color: ACCOUNT_CHART_COLORS[idx % ACCOUNT_CHART_COLORS.length]!,
    })
  })

  if (states.length === 0) {
    return { data: [], series: [] }
  }

  const rangeStart = startOfLocalDay(
    new Date(Math.min(...states.map(s => s.start.getTime()))),
  )
  const allDays: Date[] = []
  const cur = new Date(rangeStart)
  while (cur <= today) {
    allDays.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)
  }

  const maxPoints = 120
  const step = allDays.length > maxPoints ? Math.ceil(allDays.length / maxPoints) : 1
  const sampledDays = allDays.filter((_, i) => i % step === 0 || i === allDays.length - 1)

  const data = sampledDays.map(day => {
    const key = dayKey(day)
    const row: Record<string, string | number> = {
      key,
      label: shortDayLabel(day),
    }
    for (const st of states) {
      if (day < st.start) {
        row[st.dataKey] = st.baseline
        continue
      }
      let cum = 0
      for (const [dk, v] of st.cumByDay) {
        if (dk <= key) cum = v
      }
      const isLast = dayKey(day) === dayKey(today)
      const live = equityByAccountId[st.id]
      if (isLast && live != null && Number.isFinite(live)) {
        row[st.dataKey] = Number(live.toFixed(2))
      } else {
        row[st.dataKey] = Number((st.baseline + cum).toFixed(2))
      }
    }
    return row
  })

  return { data, series }
}
