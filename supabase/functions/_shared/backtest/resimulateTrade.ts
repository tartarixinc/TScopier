import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import type { FxsocketClient } from "../fxsocketClient.ts"
import type { BacktestRunConfig, ParsedSignalForBacktest } from "./types.ts"
import { preloadMarketData } from "./marketData.ts"
import { recalculateRunSummary } from "./recalculateRunSummary.ts"
import { resolveBacktestBroker } from "./resolveBacktestBroker.ts"
import { simulateTradeOnSeries, sliceSeriesForSignal } from "./simulator.ts"
import {
  dbTradeToSimulated,
  parseTpLevels,
  simulatedToTradeRow,
  type DbBacktestTradeRow,
  type TradeOverrides,
} from "./tradeRows.ts"

function runConfigFromStored(raw: Record<string, unknown>): BacktestRunConfig {
  const strategy = raw.strategy as BacktestRunConfig["strategy"] | undefined
  return {
    channelIds: Array.isArray(raw.channelIds) ? raw.channelIds.map(String) : [],
    symbols: Array.isArray(raw.symbols) ? raw.symbols.map(String) : [],
    dateFrom: String(raw.dateFrom ?? ""),
    dateTo: String(raw.dateTo ?? ""),
    timeframe: (raw.timeframe as BacktestRunConfig["timeframe"]) ?? "5m",
    executionMode: (raw.executionMode as BacktestRunConfig["executionMode"]) ?? "minute_bars",
    initialBalance: Number(raw.initialBalance ?? 10_000),
    currency: String(raw.currency ?? "USD"),
    sizingMode: (raw.sizingMode as BacktestRunConfig["sizingMode"]) ?? "fixed_lot",
    fixedLot: Number(raw.fixedLot ?? 0.1),
    riskPercent: Number(raw.riskPercent ?? 1),
    strategy: strategy ?? {
      breakevenAfterTp: 0,
      partialClosePerTp: 0,
      intrabarPriority: "sl_first",
    },
  }
}

function applyOverrides(row: DbBacktestTradeRow, overrides: TradeOverrides) {
  const direction = overrides.direction ?? (row.direction === "sell" ? "sell" : "buy")
  const entryPrice = overrides.entry_price ?? Number(row.entry_price)
  const sl = overrides.sl !== undefined ? overrides.sl : (row.sl != null ? Number(row.sl) : null)
  const tpLevels = overrides.tp_levels ?? parseTpLevels(row.tp_levels)
  return { direction, entryPrice, sl, tpLevels }
}

export async function resimulateBacktestTrade(
  supabase: SupabaseClient,
  fx: FxsocketClient,
  userId: string,
  tradeId: string,
  overrides: TradeOverrides,
): Promise<DbBacktestTradeRow> {
  const { data: trade, error: tradeErr } = await supabase
    .from("backtest_trades")
    .select("*")
    .eq("id", tradeId)
    .maybeSingle()
  if (tradeErr) throw new Error(tradeErr.message)
  if (!trade) throw new Error("Trade not found")

  const row = trade as DbBacktestTradeRow
  const runId = row.run_id

  const { data: runRow, error: runErr } = await supabase
    .from("backtest_runs")
    .select("id, config")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle()
  if (runErr) throw new Error(runErr.message)
  if (!runRow) throw new Error("Run not found")

  const config = runConfigFromStored((runRow.config ?? {}) as Record<string, unknown>)
  const { direction, entryPrice, sl, tpLevels } = applyOverrides(row, overrides)

  const signal: ParsedSignalForBacktest = {
    signalId: String((row.details as Record<string, unknown> | null)?.backtestChannelSignalId ?? row.id),
    copierSignalId: row.signal_id,
    channelId: row.channel_id ?? "",
    channelName: "Channel",
    signalAt: new Date(row.signal_at),
    symbol: row.symbol,
    direction,
    entryPrice,
    sl,
    tpLevels,
    lotSize: Number(row.lot_size) > 0 ? Number(row.lot_size) : 0.01,
    rawAction: direction,
  }

  const fromMs = new Date(config.dateFrom).getTime()
  const toMs = new Date(config.dateTo + "T23:59:59.999Z").getTime()
  const brokerCtx = await resolveBacktestBroker(supabase, fx, userId, signal.symbol)
  const { seriesBySymbol } = await preloadMarketData(
    fx,
    brokerCtx,
    [signal.symbol],
    [signal],
    config,
    fromMs,
    toMs,
  )

  const fullSeries = seriesBySymbol.get(signal.symbol) ?? []
  const series = sliceSeriesForSignal(fullSeries, signal.signalAt)
  const lot = Number(row.lot_size) > 0 ? Number(row.lot_size) : 0.01
  const sim = simulateTradeOnSeries(signal, series, config.strategy, lot)
  const update = simulatedToTradeRow(sim, runId, row)

  const { data: updated, error: upErr } = await supabase
    .from("backtest_trades")
    .update(update)
    .eq("id", tradeId)
    .select("*")
    .single()
  if (upErr) throw new Error(upErr.message)

  await recalculateRunSummary(supabase, runId, userId, config)
  return updated as DbBacktestTradeRow
}

export async function deleteBacktestTrade(
  supabase: SupabaseClient,
  userId: string,
  tradeId: string,
): Promise<{ run_id: string }> {
  const { data: trade, error: tradeErr } = await supabase
    .from("backtest_trades")
    .select("id, run_id")
    .eq("id", tradeId)
    .maybeSingle()
  if (tradeErr) throw new Error(tradeErr.message)
  if (!trade) throw new Error("Trade not found")

  const runId = trade.run_id as string

  const { data: runRow, error: runErr } = await supabase
    .from("backtest_runs")
    .select("config")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle()
  if (runErr) throw new Error(runErr.message)
  if (!runRow) throw new Error("Run not found")

  const config = runConfigFromStored((runRow.config ?? {}) as Record<string, unknown>)

  const { error: delErr } = await supabase.from("backtest_trades").delete().eq("id", tradeId)
  if (delErr) throw new Error(delErr.message)

  await recalculateRunSummary(supabase, runId, userId, config)
  return { run_id: runId }
}
