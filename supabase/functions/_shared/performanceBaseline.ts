import type { FxsocketAccountSummary } from "./fxsocketClient.ts"
import type { FxsocketBrokerTradeRow } from "./fxsocketTrades.ts"
import { effectiveAccountSummaryBalance } from "./effectiveBrokerBalance.ts"

/** Match frontend PERFORMANCE_MT_HISTORY_DAYS for cash-flow / deal-profit backfill. */
export const PERFORMANCE_BASELINE_HISTORY_DAYS = 400

const BASELINE_EPSILON = 0.01

type TradeStatsLike = Pick<
  FxsocketBrokerTradeRow,
  | "status"
  | "profit"
  | "swap"
  | "commission"
  | "symbol"
  | "lot_size"
  | "direction"
  | "type"
  | "opened_at"
  | "closed_at"
>

function isBalanceOpType(type: string): boolean {
  const t = type.toLowerCase()
  return (
    t.includes("balance") ||
    t.includes("credit") ||
    t.includes("deposit") ||
    t.includes("withdraw") ||
    t.includes("correction") ||
    t.includes("transfer")
  )
}

function isTradeableMtRow(row: TradeStatsLike): boolean {
  if (!(row.symbol ?? "").trim()) return false
  const type = (row.type ?? "").toLowerCase()
  if (isBalanceOpType(type)) return false
  const dir = (row.direction ?? "").toLowerCase()
  if ((row.lot_size ?? 0) <= 0) return false
  return dir === "buy" || dir === "sell"
}

function isTradeableClosedRow(row: TradeStatsLike): boolean {
  if ((row.status ?? "closed") !== "closed") return false
  return isTradeableMtRow(row)
}

/** Deposit / withdrawal rows only — never infer from empty-symbol trade deals. */
function isBalanceCashFlowRow(row: TradeStatsLike): boolean {
  if ((row.status ?? "closed") !== "closed") return false
  if (isTradeableClosedRow(row)) return false
  const profit = row.profit
  if (typeof profit !== "number" || !Number.isFinite(profit) || profit === 0) return false
  return isBalanceOpType(row.type ?? "")
}

function closedDealProfit(row: TradeStatsLike): number | null {
  const p = row.profit
  if (typeof p !== "number" || !Number.isFinite(p)) return null
  return p
}

function isMtClosedDealForOutcome(row: TradeStatsLike): boolean {
  if ((row.status ?? "closed") !== "closed") return false
  if (!isTradeableClosedRow(row)) return false
  return closedDealProfit(row) != null
}

function netClosedLegProfit(row: Pick<FxsocketBrokerTradeRow, "profit" | "swap" | "commission">): number {
  const p = typeof row.profit === "number" && Number.isFinite(row.profit) ? row.profit : 0
  const s = typeof row.swap === "number" && Number.isFinite(row.swap) ? row.swap : 0
  const c = typeof row.commission === "number" && Number.isFinite(row.commission) ? row.commission : 0
  return p + s + c
}

function rowCloseMs(row: Pick<FxsocketBrokerTradeRow, "closed_at" | "opened_at">): number {
  const iso = row.closed_at ?? row.opened_at
  if (!iso) return Number.POSITIVE_INFINITY
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

export function sumBalanceCashFlow(trades: FxsocketBrokerTradeRow[]): number {
  return trades
    .filter(isBalanceCashFlowRow)
    .reduce((sum, t) => sum + (t.profit ?? 0), 0)
}

/** Deal profit column only (matches MT5 History "Profit" row). */
export function sumRealizedClosedDealProfit(trades: FxsocketBrokerTradeRow[]): number {
  return trades
    .filter(isMtClosedDealForOutcome)
    .reduce((sum, t) => sum + (closedDealProfit(t) ?? 0), 0)
}

/** Profit + swap + commission — what actually moves account balance per closed leg. */
export function sumRealizedClosedNetProfit(trades: FxsocketBrokerTradeRow[]): number {
  return trades
    .filter(isMtClosedDealForOutcome)
    .reduce((sum, t) => sum + netClosedLegProfit(t), 0)
}

/**
 * Split MT balance operations into initial funding (before first trade) vs later deposits/withdrawals.
 */
export function splitBalanceCashFlows(trades: FxsocketBrokerTradeRow[]): {
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

/**
 * Reconstruct deposit / starting balance from current balance and closed history.
 * MT5: Balance = Deposit + Profit + Swap + Commission (+ later cash flows).
 */
export function inferPerformanceBaselineFromHistory(
  currentBalance: number,
  trades: FxsocketBrokerTradeRow[],
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

export function hasPerformanceBaseline(value: number | null | undefined): boolean {
  if (value == null) return false
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

/**
 * Balance at first successful FxSocket connect (balance + credit).
 * Never inferred from MT deposit history — immutable once stored.
 */
export function snapshotLinkTimeBalance(summary: FxsocketAccountSummary): number | null {
  const balance = effectiveAccountSummaryBalance(summary)
  if (balance == null || balance <= 0) return null
  return balance
}

export function computePerformanceBaselineBalance(
  summary: FxsocketAccountSummary,
  trades?: FxsocketBrokerTradeRow[],
): number | null {
  void trades
  return snapshotLinkTimeBalance(summary)
}

/**
 * Returns the baseline balance to persist on first connect, or null when already set.
 */
export function resolvePerformanceBaselineBalance(
  existing: number | null | undefined,
  summary: FxsocketAccountSummary,
  _trades?: FxsocketBrokerTradeRow[],
): number | null {
  void _trades
  if (hasPerformanceBaseline(existing)) return null
  return snapshotLinkTimeBalance(summary)
}
