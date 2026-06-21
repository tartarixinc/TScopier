import { effectiveTimeframeForRange } from "./effectiveTimeframe.ts"
import { normalizeSymbolFilter } from "./symbols.ts"
import type { BacktestRunConfig, BacktestTimeframe } from "./types.ts"

function normalizeSymbols(symbols: string[] | undefined): string[] {
  return normalizeSymbolFilter(symbols ?? [])
}

export interface SimpleBacktestConfig {
  channelIds: string[]
  dateFrom: string
  dateTo: string
  initialBalance: number
  fixedLot: number
  timeframe?: BacktestTimeframe
  /** When set, only these symbols are simulated (profile first, then backtest). */
  symbols?: string[]
}

export type BacktestRunMode = "tpsl" | "simulate"

const TPSL_STRATEGY: BacktestRunConfig["strategy"] = {
  breakevenAfterTp: 0,
  partialClosePerTp: 0,
  intrabarPriority: "sl_first",
}

const SIMULATE_STRATEGY: BacktestRunConfig["strategy"] = {
  breakevenAfterTp: 1,
  partialClosePerTp: 0,
  intrabarPriority: "sl_first",
}

export function toBacktestRunConfig(
  cfg: SimpleBacktestConfig,
  mode: BacktestRunMode = "tpsl",
): BacktestRunConfig {
  return {
    channelIds: cfg.channelIds,
    symbols: normalizeSymbols(cfg.symbols),
    dateFrom: cfg.dateFrom,
    dateTo: cfg.dateTo,
    timeframe: effectiveTimeframeForRange(cfg.dateFrom, cfg.dateTo, cfg.timeframe),
    executionMode: "tick_quotes",
    initialBalance: cfg.initialBalance,
    currency: "USD",
    sizingMode: "fixed_lot",
    fixedLot: cfg.fixedLot,
    riskPercent: 1,
    strategy: mode === "tpsl" ? TPSL_STRATEGY : SIMULATE_STRATEGY,
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
    timeframe: (raw.timeframe as BacktestTimeframe | undefined) ?? "5m",
    symbols: normalizeSymbols(
      Array.isArray(raw.symbols) ? raw.symbols.map(String) : [],
    ),
  }
}
