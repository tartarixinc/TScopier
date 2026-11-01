import {
  BROKER_FULL_HISTORY_FROM_DATE,
  fetchBalanceCashFlowFromOrderHistory,
  type FxsocketBrokerTradeRow,
  type MtHistorySource,
} from "./fxsocketTrades.ts"

/** Re-pull the (heavy) full cash-flow history at most this often per account. */
export const CASHFLOW_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000

export type CashflowTotals = { deposits: number; withdrawals: number; found: boolean }

const round2 = (value: number) => Math.round(value * 100) / 100

/** Deposits = positive balance operations; withdrawals = magnitude of negative ones. */
export function summarizeCashFlow(rows: Pick<FxsocketBrokerTradeRow, "profit">[]): CashflowTotals {
  let deposits = 0
  let withdrawals = 0
  let found = false
  for (const row of rows) {
    const profit = row.profit
    if (typeof profit !== "number" || !Number.isFinite(profit) || profit === 0) continue
    found = true
    if (profit > 0) deposits += profit
    else withdrawals += -profit
  }
  return { deposits: round2(deposits), withdrawals: round2(withdrawals), found }
}

export function cashflowSyncDue(syncedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!syncedAt) return true
  const at = Date.parse(syncedAt)
  return !Number.isFinite(at) || now - at >= CASHFLOW_SYNC_INTERVAL_MS
}

/**
 * Pull every deposit/withdrawal from the broker's full history. Returns null when no
 * balance operations were found, so an empty/unsupported history never overwrites stored totals.
 */
export async function fetchCashflowTotals(
  source: MtHistorySource,
  broker: { id: string; label: string; broker_name: string | null; fxsocket_account_id: string; platform?: string | null },
  historyTo: string,
): Promise<CashflowTotals | null> {
  const rows = await fetchBalanceCashFlowFromOrderHistory(source, broker, {
    historyFrom: BROKER_FULL_HISTORY_FROM_DATE,
    historyTo,
    historyProfile: "trades",
  })
  const totals = summarizeCashFlow(rows)
  return totals.found ? totals : null
}
