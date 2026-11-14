import type { BrokerAccount } from '../types/database'
import { fetchTradesAcrossProviders, type MtTrade } from './fxsocketBroker'
import { isMtTradePendingEntry } from './fxsocketStreamParse'
import { liveOpenPnlFromMtTrades } from './liveOpenPnl'
import { filterMtTradesSinceConnect } from './tradesSinceConnect'

export type BrokerOpenBookEntry = {
  marketOpenCount: number
  pendingOpenCount: number
  /** Sum of floating P/L on market legs; null when none are priced. */
  openPnl: number | null
  marketOpenRows: MtTrade[]
  allOpenRows: MtTrade[]
}

export type BrokerOpenBook = {
  byBroker: Record<string, BrokerOpenBookEntry>
  marketOpenCount: number
  pendingOpenCount: number
  trades: MtTrade[]
}

function emptyEntry(): BrokerOpenBookEntry {
  return {
    marketOpenCount: 0,
    pendingOpenCount: 0,
    openPnl: null,
    marketOpenRows: [],
    allOpenRows: [],
  }
}

/** Split broker-open rows into market positions vs pending limit/stop. */
export function splitOpenBookRows(trades: ReadonlyArray<MtTrade>): {
  market: MtTrade[]
  pending: MtTrade[]
} {
  const market: MtTrade[] = []
  const pending: MtTrade[] = []
  for (const trade of trades) {
    if (trade.status !== 'open') continue
    if (isMtTradePendingEntry(trade)) pending.push(trade)
    else market.push(trade)
  }
  return { market, pending }
}

/**
 * Build per-broker market/pending open counts + market PnL from already-fetched
 * open trades (after since-connect filtering).
 */
export function buildBrokerOpenBookFromTrades(
  trades: ReadonlyArray<MtTrade>,
  accountIds?: ReadonlyArray<string>,
): BrokerOpenBook {
  const byBroker: Record<string, BrokerOpenBookEntry> = {}
  const allowed = accountIds ? new Set(accountIds) : null

  for (const trade of trades) {
    if (trade.status !== 'open') continue
    if (allowed && !allowed.has(trade.broker_id)) continue
    const entry = byBroker[trade.broker_id] ?? (byBroker[trade.broker_id] = emptyEntry())
    entry.allOpenRows.push(trade)
    if (isMtTradePendingEntry(trade)) {
      entry.pendingOpenCount += 1
    } else {
      entry.marketOpenCount += 1
      entry.marketOpenRows.push(trade)
    }
  }

  let marketOpenCount = 0
  let pendingOpenCount = 0
  for (const entry of Object.values(byBroker)) {
    entry.openPnl = liveOpenPnlFromMtTrades(entry.marketOpenRows)
    marketOpenCount += entry.marketOpenCount
    pendingOpenCount += entry.pendingOpenCount
  }

  return {
    byBroker,
    marketOpenCount,
    pendingOpenCount,
    trades: trades.filter(t => t.status === 'open'),
  }
}

/**
 * Broker truth for dashboard Open Trades / Open PnL and the sidebar badge:
 * market positions only (pending limits excluded), paired with floating PnL.
 */
export async function fetchBrokerMarketOpenBook(args: {
  accounts: ReadonlyArray<BrokerAccount>
  historyProfile?: 'dashboard' | 'trades'
}): Promise<BrokerOpenBook> {
  const accounts = args.accounts
  if (accounts.length === 0) {
    return { byBroker: {}, marketOpenCount: 0, pendingOpenCount: 0, trades: [] }
  }

  const res = await fetchTradesAcrossProviders({
    scope: 'open',
    historyProfile: args.historyProfile ?? 'dashboard',
    accounts,
  })
  const trades = filterMtTradesSinceConnect(res.trades ?? [], accounts)
  return buildBrokerOpenBookFromTrades(
    trades,
    accounts.map(account => account.id),
  )
}
