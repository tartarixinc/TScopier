export type BacktestTimeframe = '1m' | '5m' | '15m' | '1h' | '1d'

export interface SimpleBacktestConfig {
  channelIds: string[]
  dateFrom: string
  dateTo: string
  initialBalance: number
  fixedLot: number
  timeframe?: BacktestTimeframe
  /** When set, only simulate these symbols (after profiling). */
  symbols?: string[]
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
  totalPips?: number
  byChannel: Record<string, {
    channelName: string
    trades: number
    netPnl: number
    winRate: number
  }>
  message?: string
  signalSource?: string
  rawParsedCount?: number
  marketDataApiCalls?: number
  /** @deprecated use marketDataApiCalls */
  massiveApiCalls?: number
  brokerAccountId?: string
  brokerLabel?: string
  importWarnings?: string[]
}

export interface BacktestRunRow {
  id: string
  name: string
  status: string
  progress_pct: number
  progress_message: string | null
  summary: BacktestSummary | null
  config: SimpleBacktestConfig & Record<string, unknown>
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export type BacktestRunMode = 'tpsl' | 'simulate'

export interface BacktestTpEvent {
  index: number
  price: number
  ts: number
}

export interface BacktestTradeRow {
  id: string
  symbol: string
  direction: string
  signal_at: string
  outcome: string
  tps_hit: number
  pnl: number
  pnl_r: number | null
  entry_price: number
  exit_price: number | null
  closed_at: string | null
  sl: number | null
  tp_levels: number[]
  lot_size: number
  channel_id: string | null
  details?: {
    tpEvents?: BacktestTpEvent[]
    marketEntry?: boolean
    /** Signal-style pip P/L from the simulator (supports partial TP legs). */
    pipPnl?: number
  } | Record<string, unknown>
}

export interface BacktestEquityRow {
  ts: string
  equity: number
  drawdown_pct: number
}

export interface BacktestReplayCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface BacktestTradeReplayResponse {
  ok: true
  source: 'ticks' | 'bars'
  intervalMs: number
  candles: BacktestReplayCandle[]
  markers: {
    entry: { time: number; price: number }
    sl: number | null
    tps: number[]
    tpEvents: BacktestTpEvent[]
    exit: { time: number; price: number } | null
  }
  brokerLabel: string
  tradeDurationMs: number
}

/** Rows in `backtest_channel_signals` for the selected channel(s) and date range. */
export interface StoredBacktestSignal {
  id: string
  channel_id: string
  symbol: string
  direction: string
  entry_price: number
  sl: number | null
  tp_levels: number[]
  signal_at: string
  source: string
}
