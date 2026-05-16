export type BacktestTimeframe = '1m' | '5m' | '15m' | '1h' | '1d'
export type BacktestSizingMode = 'fixed_lot' | 'risk_percent'
export type BacktestExecutionMode = 'tick_quotes' | 'minute_bars'

export interface BacktestStrategyConfig {
  breakevenAfterTp: number
  partialClosePerTp: number
  intrabarPriority: 'sl_first' | 'tp_first'
}

export interface BacktestRunConfig {
  channelIds: string[]
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
}

export interface BacktestRunRow {
  id: string
  name: string
  status: string
  progress_pct: number
  progress_message: string | null
  summary: BacktestSummary | null
  config: BacktestRunConfig
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export interface BacktestTradeRow {
  id: string
  symbol: string
  direction: string
  signal_at: string
  outcome: string
  tps_hit: number
  pnl: number
  entry_price: number
  exit_price: number | null
  channel_id: string | null
}

export interface BacktestEquityRow {
  ts: string
  equity: number
  drawdown_pct: number
}
