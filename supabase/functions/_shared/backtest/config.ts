import type { BacktestRunConfig, BacktestTimeframe } from "./types.ts"

export interface SimpleBacktestConfig {
  channelIds: string[]
  dateFrom: string
  dateTo: string
  initialBalance: number
  fixedLot: number
  timeframe?: BacktestTimeframe
}

const DEFAULT_STRATEGY: BacktestRunConfig["strategy"] = {
  breakevenAfterTp: 1,
  partialClosePerTp: 0,
  intrabarPriority: "sl_first",
}

export function toBacktestRunConfig(cfg: SimpleBacktestConfig): BacktestRunConfig {
  return {
    channelIds: cfg.channelIds,
    symbols: [],
    dateFrom: cfg.dateFrom,
    dateTo: cfg.dateTo,
    timeframe: cfg.timeframe ?? "1m",
    executionMode: "minute_bars",
    initialBalance: cfg.initialBalance,
    currency: "USD",
    sizingMode: "fixed_lot",
    fixedLot: cfg.fixedLot,
    riskPercent: 1,
    strategy: DEFAULT_STRATEGY,
  }
}

export function parseSimpleConfig(raw: Partial<SimpleBacktestConfig>): SimpleBacktestConfig {
  const channelIds = Array.isArray(raw.channelIds)
    ? raw.channelIds.map(String).filter(Boolean)
    : []
  return {
    channelIds,
    dateFrom: String(raw.dateFrom ?? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)),
    dateTo: String(raw.dateTo ?? new Date().toISOString().slice(0, 10)),
    initialBalance: Number(raw.initialBalance ?? 10_000),
    fixedLot: Number(raw.fixedLot ?? 0.1),
    timeframe: (raw.timeframe as BacktestTimeframe | undefined) ?? "1m",
  }
}
