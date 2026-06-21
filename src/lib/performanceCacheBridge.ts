import {
  DASHBOARD_ACTIVE_USER_KEY,
  DASHBOARD_CACHE_LEGACY_KEYS,
  DASHBOARD_CACHE_VERSION,
} from './dashboardSessionCache'
import { normalizeChannelLinkMaps, type PerformanceChannelLinkMaps } from './performanceInsights'
import type { MtTrade } from './fxsocketBroker'
import { performanceCacheKey, type PerformanceCachePayload } from './performanceSessionCache'
import { writeSessionCache } from './sessionDataCache'
import { filterMtTradesSinceConnect } from './tradesSinceConnect'
import type { BrokerAccount } from '../types/database'

type BrokerBalanceSnapshot = {
  balance?: number
  equity?: number
}

type DashboardCacheSlice = {
  linkedAccounts?: BrokerAccount[]
  linkedAccountBalances?: Record<string, BrokerBalanceSnapshot>
  mtTrades?: MtTrade[]
  channelLinkMaps?: PerformanceChannelLinkMaps
}

function readDashboardCacheSlice(userId: string): DashboardCacheSlice | null {
  if (typeof sessionStorage === 'undefined') return null
  const keys = [
    `${DASHBOARD_CACHE_VERSION}:${userId}`,
    ...DASHBOARD_CACHE_LEGACY_KEYS.map(v => `${v}:${userId}`),
  ]
  for (const cacheKey of keys) {
    const raw = sessionStorage.getItem(cacheKey)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as DashboardCacheSlice
      if (!parsed.linkedAccounts?.length) continue
      return parsed
    } catch {
      continue
    }
  }
  return null
}

/** Build a performance payload from the dashboard session cache (instant overlay hydration). */
export function performancePayloadFromDashboardCache(userId: string): PerformanceCachePayload | null {
  if (typeof sessionStorage === 'undefined') return null
  const active = sessionStorage.getItem(DASHBOARD_ACTIVE_USER_KEY)
  if (active && active !== userId) return null

  const dash = readDashboardCacheSlice(userId)
  if (!dash?.linkedAccounts?.length) return null

  const equityByAccountId: Record<string, number> = {}
  const balanceByAccountId: Record<string, number> = {}
  const balances = dash.linkedAccountBalances ?? {}

  for (const account of dash.linkedAccounts) {
    const snap = balances[account.id]
    const eq = snap?.equity ?? snap?.balance ?? account.last_equity ?? account.last_balance
    const bal = snap?.balance ?? snap?.equity ?? account.last_balance ?? account.last_equity
    if (eq != null && Number.isFinite(Number(eq))) equityByAccountId[account.id] = Number(eq)
    if (bal != null && Number.isFinite(Number(bal))) balanceByAccountId[account.id] = Number(bal)
  }

  return {
    accounts: dash.linkedAccounts,
    mtTrades: filterMtTradesSinceConnect(dash.mtTrades ?? [], dash.linkedAccounts),
    equityByAccountId,
    balanceByAccountId,
    channelLinkMaps: normalizeChannelLinkMaps(dash.channelLinkMaps),
  }
}

/** Mirror dashboard cache into the performance cache so overlays can hydrate immediately. */
export function syncPerformanceCacheFromDashboard(userId: string): void {
  const payload = performancePayloadFromDashboardCache(userId)
  if (payload) {
    writeSessionCache(performanceCacheKey(userId), payload)
  }
}
