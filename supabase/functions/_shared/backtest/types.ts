export type BacktestTimeframe = "1m" | "5m" | "15m" | "1h" | "1d"
export type BacktestSizingMode = "fixed_lot" | "risk_percent"
export type BacktestExecutionMode = "tick_quotes" | "minute_bars"

export interface BacktestStrategyConfig {
  /** Move SL to entry after this TP index (1-based). 0 = disabled. */
  breakevenAfterTp: number
  /** Partial close fraction per TP hit (equal split across TPs). */
  partialClosePerTp: number
  /** When both SL and TP could hit same bar: conservative hits SL first. */
  intrabarPriority: "sl_first" | "tp_first"
}

export interface BacktestRunConfig {
  channelIds: string[]
  /** Empty = all symbols in range; otherwise only these (e.g. XAUUSD). */
  symbols: string[]
  dateFrom: string
  dateTo: string
  timeframe: BacktestTimeframe
  executionMode: BacktestExecutionMode
  initialBalance: number
  currency: string
  sizingMode: BacktestSizingMode
  fixedLot: number
  riskPercent: number
  strategy: BacktestStrategyConfig
}

export interface ParsedSignalForBacktest {
  signalId: string
  channelId: string
  channelName: string
  signalAt: Date
  symbol: string
  direction: "buy" | "sell"
  entryPrice: number
  sl: number | null
  tpLevels: number[]
  lotSize: number | null
  rawAction: string
}

export type TradeOutcome =
  | "sl_before_tp"
  | "tp1_then_sl"
  | "tp_then_be"
  | "all_tp_hit"
  | "breakeven"
  | "no_data"
  | "skipped"
  | "open"

export interface SimulatedTradeResult {
  signalId: string
  channelId: string
  symbol: string
  direction: "buy" | "sell"
  signalAt: Date
  entryPrice: number
  sl: number | null
  tpLevels: number[]
  lotSize: number
  outcome: TradeOutcome
  tpsHit: number
  exitPrice: number | null
  closedAt: Date | null
  pnl: number
  pnlR: number | null
  mfe: number
  mae: number
  details: Record<string, unknown>
}

export interface BacktestSummary {
  totalSignals: number
  tradedSignals: number
  skippedSignals: number
  wins: number
  losses: number
  breakevenExits: number
  tp1BeforeBe: number
  tp1BeforeSl: number
  allTpHits: number
  finalEquity: number
  netPnl: number
  returnPct: number
  maxDrawdownPct: number
  profitFactor: number | null
  winRate: number
  byChannel: Record<string, {
    channelName: string
    trades: number
    netPnl: number
    winRate: number
  }>
  message?: string
  signalSource?: string
  rawParsedCount?: number
  massiveApiCalls?: number
  importWarnings?: string[]
}

export interface EquityPoint {
  ts: Date
  equity: number
  balance: number
  drawdownPct: number
  openTrades: number
}
