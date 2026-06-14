import type { MtTrade } from './fxsocketBroker'

const BASELINE_EPSILON = 0.01

type TradeStatsLike = Pick<
  MtTrade,
  | 'status'
  | 'profit'
  | 'swap'
  | 'commission'
  | 'symbol'
  | 'lot_size'
  | 'direction'
  | 'type'
  | 'opened_at'
  | 'closed_at'
>

function isBalanceOpType(type: string): boolean {
  const t = type.toLowerCase()
  return (
    t.includes('balance') ||
    t.includes('credit') ||
    t.includes('deposit') ||
    t.includes('withdraw') ||
    t.includes('correction') ||
    t.includes('transfer')
  )
}

function isTradeableMtRow(row: TradeStatsLike): boolean {
  if (!(row.symbol ?? '').trim()) return false
  if (isBalanceOpType(row.type ?? '')) return false
  const dir = (row.direction ?? '').toLowerCase()
  if ((row.lot_size ?? 0) <= 0) return false
  return dir === 'buy' || dir === 'sell'
}

function isTradeableClosedRow(row: TradeStatsLike): boolean {
  if ((row.status ?? 'closed') !== 'closed') return false
  return isTradeableMtRow(row)
}

function isBalanceCashFlowRow(row: TradeStatsLike): boolean {
  if ((row.status ?? 'closed') !== 'closed') return false
  if (isTradeableClosedRow(row)) return false
  const profit = row.profit
  if (typeof profit !== 'number' || !Number.isFinite(profit) || profit === 0) return false
  if (isBalanceOpType(row.type ?? '')) return true
  return !(row.symbol ?? '').trim()
    && (row.lot_size ?? 0) <= 0
    && !(row.direction ?? '').trim()
}

function closedDealProfit(row: TradeStatsLike): number | null {
  const p = row.profit
  if (typeof p !== 'number' || !Number.isFinite(p)) return null
  return p
}

function isMtClosedDealForOutcome(row: TradeStatsLike): boolean {
  if ((row.status ?? 'closed') !== 'closed') return false
  if (!isTradeableClosedRow(row)) return false
  return closedDealProfit(row) != null
}

function netClosedLegProfit(row: Pick<MtTrade, 'profit' | 'swap' | 'commission'>): number {
  const p = typeof row.profit === 'number' && Number.isFinite(row.profit) ? row.profit : 0
  const s = typeof row.swap === 'number' && Number.isFinite(row.swap) ? row.swap : 0
  const c = typeof row.commission === 'number' && Number.isFinite(row.commission) ? row.commission : 0
  return p + s + c
}

function rowCloseMs(row: Pick<MtTrade, 'closed_at' | 'opened_at'>): number {
  const iso = row.closed_at ?? row.opened_at
  if (!iso) return Number.POSITIVE_INFINITY
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

export function sumRealizedClosedNetProfit(trades: MtTrade[]): number {
  return trades
    .filter(isMtClosedDealForOutcome)
    .reduce((sum, t) => sum + netClosedLegProfit(t), 0)
}

export function splitBalanceCashFlows(trades: MtTrade[]): {
  initialDeposit: number
  subsequentCashFlow: number
} {
  const cashRows = trades
    .filter(isBalanceCashFlowRow)
    .sort((a, b) => rowCloseMs(a) - rowCloseMs(b))

  if (cashRows.length === 0) {
    return { initialDeposit: 0, subsequentCashFlow: 0 }
  }

  const firstTradeMs = trades
    .filter(isMtClosedDealForOutcome)
    .reduce((min, row) => Math.min(min, rowCloseMs(row)), Number.POSITIVE_INFINITY)

  let initialDeposit = 0
  let subsequentCashFlow = 0

  for (const row of cashRows) {
    const profit = row.profit ?? 0
    const at = rowCloseMs(row)
    if (profit > 0 && at <= firstTradeMs) {
      initialDeposit += profit
      continue
    }
    subsequentCashFlow += profit
  }

  return { initialDeposit, subsequentCashFlow }
}

/** Sum of all positive deposit/credit balance operations in MT history. */
export function sumTotalDeposits(trades: MtTrade[]): number | null {
  let total = 0
  let found = false
  for (const row of trades) {
    if (!isBalanceCashFlowRow(row)) continue
    const profit = row.profit ?? 0
    if (profit > 0) {
      total += profit
      found = true
    }
  }
  return found ? Math.round(total * 100) / 100 : null
}

/** Net withdrawals/corrections (negative cash-flow rows only). */
export function sumSignedWithdrawals(trades: MtTrade[]): number {
  return trades
    .filter(isBalanceCashFlowRow)
    .reduce((sum, row) => {
      const profit = row.profit ?? 0
      return profit < 0 ? sum + profit : sum
    }, 0)
}

/** Lifetime trading P/L: current balance minus deposits and signed withdrawals. */
export function computeTradingPnlFromBalanceAndCashFlows(
  currentBalance: number | null | undefined,
  trades: MtTrade[],
): number | null {
  const balance =
    currentBalance != null && Number.isFinite(Number(currentBalance))
      ? Number(currentBalance)
      : null
  if (balance == null) return null
  const deposits = sumTotalDeposits(trades)
  if (deposits == null) return null
  const withdrawals = sumSignedWithdrawals(trades)
  return Math.round((balance - deposits - withdrawals) * 100) / 100
}

export function inferPerformanceBaselineFromHistory(
  currentBalance: number,
  trades: MtTrade[],
): number {
  const netPnl = sumRealizedClosedNetProfit(trades)
  const { initialDeposit, subsequentCashFlow } = splitBalanceCashFlows(trades)
  const inferred = currentBalance - netPnl - subsequentCashFlow

  if (initialDeposit > 0) {
    const depositResidual = Math.abs(currentBalance - initialDeposit - netPnl)
    if (depositResidual <= BASELINE_EPSILON) {
      return Math.round(initialDeposit * 100) / 100
    }
    if (inferred < initialDeposit - BASELINE_EPSILON) {
      return Math.round(initialDeposit * 100) / 100
    }
  }

  return Math.round(inferred * 100) / 100
}

export function computePerformanceBaselineBalance(
  balance: number | null | undefined,
  trades: MtTrade[],
): number | null {
  if (balance == null || !Number.isFinite(balance) || balance <= 0) return null
  if (!trades.length || !trades.some(isMtClosedDealForOutcome)) return balance
  return inferPerformanceBaselineFromHistory(balance, trades)
}

/**
 * Best initial balance for display.
 * Prefer the link-time stored baseline; only override when MT deposit history reconciles.
 */
export function resolveDisplayInitialBalance(
  storedBaseline: number | null | undefined,
  currentBalance: number | null | undefined,
  trades: MtTrade[],
  brokerId: string,
): number | null {
  const balance =
    currentBalance != null && Number.isFinite(Number(currentBalance))
      ? Number(currentBalance)
      : null
  const stored =
    storedBaseline != null && Number.isFinite(Number(storedBaseline)) && Number(storedBaseline) > 0
      ? Number(storedBaseline)
      : null

  const brokerTrades = trades.filter(t => t.broker_id === brokerId)

  if (balance != null && brokerTrades.some(isMtClosedDealForOutcome)) {
    const netPnl = sumRealizedClosedNetProfit(brokerTrades)
    const { initialDeposit, subsequentCashFlow } = splitBalanceCashFlows(brokerTrades)

    if (initialDeposit > 0) {
      const depositResidual = Math.abs(balance - initialDeposit - netPnl - subsequentCashFlow)
      if (depositResidual <= BASELINE_EPSILON) {
        return Math.round(initialDeposit * 100) / 100
      }
      // Recorded MT5 deposit deal overrides a stale stored baseline.
      if (stored == null || initialDeposit > stored + BASELINE_EPSILON) {
        return Math.round(initialDeposit * 100) / 100
      }
    }
  }

  // Link-time baseline is authoritative — do not replace with balance − P/L inference.
  if (stored != null) return stored

  return computePerformanceBaselineBalance(balance, brokerTrades)
}
