import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { normalizeBacktestSymbol, resolveBrokerSymbol } from "./fxsocketMarketData.ts"
import type {
  BacktestBrokerProvider,
  HistoricalMarketDataSources,
} from "./historicalMarketData.ts"

const FXSOCKET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BacktestBrokerContext {
  brokerAccountId: string
  brokerLabel: string
  provider: BacktestBrokerProvider
  /** Provider session identifier. Never include this value in logs or responses. */
  sessionId: string
  platform: string | null
  brokerSymbols: string[]
}

export interface BrokerCandidate {
  id: string
  label: string
  provider: string
  fxsocket_account_id: string
  mtapi_session_id: string
  platform: string | null
  fxsocket_status: string | null
  mtapi_status: string | null
  connection_status: string | null
  provider_transition_state: string | null
  is_active: boolean
}

function isFxsocketSessionUuid(id: string | null | undefined): boolean {
  const v = (id ?? "").trim()
  return v.length > 0 && FXSOCKET_UUID_RE.test(v)
}

function brokerConnectionScore(row: BrokerCandidate): number {
  const providerStatus = row.provider === "mtapi" ? row.mtapi_status : row.fxsocket_status
  const status = (providerStatus ?? row.connection_status ?? "").trim().toLowerCase()
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

export class BacktestProviderAuthorityError extends Error {
  readonly code: string
  constructor(message: string, code = "BACKTEST_PROVIDER_UNAVAILABLE") {
    super(message)
    this.name = "BacktestProviderAuthorityError"
    this.code = code
  }
}

/** Load active brokers without preselecting a provider or prepared session. */
export async function loadBrokerCandidates(
  supabase: SupabaseClient,
  userId: string,
): Promise<BrokerCandidate[]> {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id,label,provider,platform,fxsocket_account_id,mtapi_session_id,fxsocket_status,mtapi_status,connection_status,provider_transition_state,is_active")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  if (error) throw new Error(error.message)

  return (data ?? [])
    .map((row) => ({
      id: String(row.id ?? "").trim(),
      label: String(row.label ?? ""),
      provider: String(row.provider ?? "").trim().toLowerCase(),
      platform: row.platform != null ? String(row.platform) : null,
      fxsocket_account_id: String(row.fxsocket_account_id ?? "").trim(),
      mtapi_session_id: String(row.mtapi_session_id ?? "").trim(),
      fxsocket_status: row.fxsocket_status != null ? String(row.fxsocket_status) : null,
      mtapi_status: row.mtapi_status != null ? String(row.mtapi_status) : null,
      connection_status: row.connection_status != null ? String(row.connection_status) : null,
      provider_transition_state: row.provider_transition_state != null
        ? String(row.provider_transition_state)
        : null,
      is_active: row.is_active === true,
    }))
    .sort((a, b) => brokerConnectionScore(b) - brokerConnectionScore(a))
}

/**
 * Pick a stable linked broker whose authoritative provider's symbol list contains
 * the backtest symbol. Prepared sessions for the non-authoritative provider are ignored.
 */
export async function resolveBacktestBroker(
  supabase: SupabaseClient,
  sources: HistoricalMarketDataSources,
  userId: string,
  symbol: string,
  symbolsCache?: Map<string, string[]>,
): Promise<BacktestBrokerContext> {
  const candidates = await loadBrokerCandidates(supabase, userId)
  if (candidates.length === 0) {
    throw new BacktestBrokerNotFoundError(
      "Connect an MT4/MT5 broker in Brokers to run backtests.",
    )
  }

  const normalized = normalizeBacktestSymbol(symbol)
  let fallback: BacktestBrokerContext | null = null
  let symbolsFetchFailures = 0
  let eligibleCandidates = 0
  let lastSymbolsError: string | null = null
  let authorityError: BacktestProviderAuthorityError | null = null

  for (const broker of candidates) {
    if (!broker.id) {
      authorityError = new BacktestProviderAuthorityError(
        "The active broker account identity is unavailable. Reconnect the account and try again.",
        "BROKER_ACCOUNT_ID_UNAVAILABLE",
      )
      continue
    }
    if (broker.provider_transition_state !== "stable") {
      authorityError = new BacktestProviderAuthorityError(
        "Broker provider transition is in progress; backtesting is temporarily unavailable.",
        "PROVIDER_TRANSITION_ACTIVE",
      )
      continue
    }
    if (broker.provider !== "fxsocket" && broker.provider !== "mtapi") {
      authorityError = new BacktestProviderAuthorityError(
        "Broker has an unsupported active provider.",
        "UNKNOWN_BROKER_PROVIDER",
      )
      continue
    }

    const provider = broker.provider as BacktestBrokerProvider
    const platform = String(broker.platform ?? "").trim().toUpperCase()
    if (provider === "mtapi" && platform !== "MT4" && platform !== "MT5") {
      authorityError = new BacktestProviderAuthorityError(
        "The active MTAPI broker platform is unavailable. Reconnect the account and try again.",
        "MTAPI_PLATFORM_UNAVAILABLE",
      )
      continue
    }
    const sessionId = provider === "mtapi"
      ? broker.mtapi_session_id
      : broker.fxsocket_account_id
    if (!sessionId || (provider === "fxsocket" && !isFxsocketSessionUuid(sessionId))) {
      authorityError = new BacktestProviderAuthorityError(
        `The active ${provider === "mtapi" ? "MTAPI" : "FXSocket"} broker session is unavailable. Reconnect the account and try again.`,
      )
      continue
    }
    const source = sources[provider]
    if (!source) {
      authorityError = new BacktestProviderAuthorityError(
        provider === "mtapi"
          ? "MTAPI market data is not configured for backtesting."
          : "FXSocket market data is not configured for backtesting.",
        provider === "mtapi" ? "MTAPI_NOT_CONFIGURED" : "FXSOCKET_NOT_CONFIGURED",
      )
      continue
    }

    eligibleCandidates += 1
    const cacheKey = `${provider}:${broker.id}:${broker.platform ?? ""}`
    let brokerSymbols = symbolsCache?.get(cacheKey)
    if (!brokerSymbols) {
      try {
        brokerSymbols = await source.symbols(sessionId, broker.platform)
        symbolsCache?.set(cacheKey, brokerSymbols)
      } catch (err) {
        symbolsFetchFailures += 1
        lastSymbolsError = err instanceof Error ? err.message : String(err)
        continue
      }
    }

    const brokerSymbol = resolveBrokerSymbol(normalized, brokerSymbols)
    if (!brokerSymbol) continue

    const ctx: BacktestBrokerContext = {
      brokerAccountId: broker.id,
      brokerLabel: broker.label || "Broker",
      provider,
      sessionId,
      platform: broker.platform,
      brokerSymbols,
    }

    if (brokerConnectionScore(broker) >= 2) return ctx
    if (!fallback) fallback = ctx
  }

  if (fallback) return fallback

  if (eligibleCandidates === 0 && authorityError) throw authorityError

  if (eligibleCandidates > 0 && symbolsFetchFailures >= eligibleCandidates) {
    const detail = lastSymbolsError?.trim()
    throw new BacktestBrokerNotFoundError(
      detail
        ? `Could not load Market Watch symbols from your linked broker (${detail}). Reconnect the account and try again.`
        : "Could not load Market Watch symbols from your linked broker. Reconnect the account and try again.",
    )
  }

  if (authorityError && eligibleCandidates === 0) throw authorityError

  throw new BacktestSymbolNotFoundError(symbol)
}
