import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import type { FxsocketClient } from "../fxsocketClient.ts"
import { normalizeBacktestSymbol, resolveBrokerSymbol } from "./fxsocketMarketData.ts"

const FXSOCKET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BacktestBrokerContext {
  brokerAccountId: string
  brokerLabel: string
  fxsocketAccountId: string
  brokerSymbols: string[]
}

export interface BrokerCandidate {
  id: string
  label: string
  fxsocket_account_id: string
  fxsocket_status: string | null
  connection_status: string | null
  is_active: boolean
}

function isFxsocketSessionUuid(id: string | null | undefined): boolean {
  const v = (id ?? "").trim()
  return v.length > 0 && FXSOCKET_UUID_RE.test(v)
}

function brokerConnectionScore(row: BrokerCandidate): number {
  const status = (row.fxsocket_status ?? row.connection_status ?? "").trim().toLowerCase()
  if (status === "connected") return 3
  if (status === "connecting" || status === "pending") return 2
  if (status === "error" || status === "disconnected") return 0
  return row.is_active ? 1 : 0
}

export class BacktestBrokerNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BacktestBrokerNotFoundError"
  }
}

export class BacktestSymbolNotFoundError extends Error {
  symbol: string
  constructor(symbol: string) {
    super(`Symbol ${symbol} is not available on any of your linked brokers.`)
    this.name = "BacktestSymbolNotFoundError"
    this.symbol = symbol
  }
}

/** Load user's FxSocket-linked brokers, newest active first. */
export async function loadBrokerCandidates(
  supabase: SupabaseClient,
  userId: string,
): Promise<BrokerCandidate[]> {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id,label,fxsocket_account_id,fxsocket_status,connection_status,is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .neq("fxsocket_account_id", "")
    .order("created_at", { ascending: false })

  if (error) throw new Error(error.message)

  return (data ?? [])
    .map((row) => ({
      id: String(row.id),
      label: String(row.label ?? ""),
      fxsocket_account_id: String(row.fxsocket_account_id ?? "").trim(),
      fxsocket_status: row.fxsocket_status != null ? String(row.fxsocket_status) : null,
      connection_status: row.connection_status != null ? String(row.connection_status) : null,
      is_active: row.is_active === true,
    }))
    .filter((row) => isFxsocketSessionUuid(row.fxsocket_account_id))
    .sort((a, b) => brokerConnectionScore(b) - brokerConnectionScore(a))
}

/**
 * Pick a linked broker whose /symbols list contains the backtest symbol.
 * Prefers connected brokers; falls back to first linked if symbol matches.
 */
export async function resolveBacktestBroker(
  supabase: SupabaseClient,
  fx: FxsocketClient,
  userId: string,
  symbol: string,
  symbolsCache?: Map<string, string[]>,
): Promise<BacktestBrokerContext> {
  const candidates = await loadBrokerCandidates(supabase, userId)
  if (candidates.length === 0) {
    throw new BacktestBrokerNotFoundError(
      "Connect an MT5 broker in Brokers to run backtests.",
    )
  }

  const normalized = normalizeBacktestSymbol(symbol)
  let fallback: BacktestBrokerContext | null = null

  for (const broker of candidates) {
    let brokerSymbols = symbolsCache?.get(broker.fxsocket_account_id)
    if (!brokerSymbols) {
      try {
        brokerSymbols = await fx.symbols(broker.fxsocket_account_id)
        symbolsCache?.set(broker.fxsocket_account_id, brokerSymbols)
      } catch {
        continue
      }
    }

    const brokerSymbol = resolveBrokerSymbol(normalized, brokerSymbols)
    if (!brokerSymbol) continue

    const ctx: BacktestBrokerContext = {
      brokerAccountId: broker.id,
      brokerLabel: broker.label || "Broker",
      fxsocketAccountId: broker.fxsocket_account_id,
      brokerSymbols,
    }

    if (brokerConnectionScore(broker) >= 2) return ctx
    if (!fallback) fallback = ctx
  }

  if (fallback) return fallback

  throw new BacktestSymbolNotFoundError(symbol)
}
