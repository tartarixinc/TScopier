import { MtapiApiError, type MtapiClient } from "../mtapiClient.ts"
import type { BacktestTimeframe } from "./types.ts"
import { type HistoricalBar, type HistoricalBarsRequest, type HistoricalFetchResult, type HistoricalMarketDataSource, mergeHistoricalBars } from "./historicalMarketData.ts"

const MINUTE_MS = 60_000
export const MTAPI_MAX_BARS_PER_REQUEST = 4_000
const MT4_TARGET_BARS_PER_REQUEST = MTAPI_MAX_BARS_PER_REQUEST - 2
const MAX_HISTORY_REQUESTS = 500

export interface MtapiClockNormalization {
  timestampMode: "utc" | "server"
  /** server local time minus UTC, in seconds. Zero when timestamps are verified UTC. */
  utcOffsetSeconds: number
}

export type MtapiClockResolver = (
  sessionId: string,
  platform: string | null,
) => Promise<MtapiClockNormalization>

interface EnvGetter {
  get(name: string): string | undefined
}

function envValue(env: EnvGetter, name: string): string {
  return String(env.get(name) ?? "").trim()
}

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function timezoneNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const direct = Number(value)
  if (Number.isFinite(direct)) return direct
  const row = object(value)
  for (
    const key of [
      "serverTimeZone",
      "ServerTimeZone",
      "timezone",
      "Timezone",
      "result",
      "Result",
    ]
  ) {
    const parsed = Number(row[key])
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function createMtapiClockResolver(
  client: MtapiClient,
  env: EnvGetter,
): MtapiClockResolver {
  return async (sessionId, platform) => {
    if (
      envValue(env, "MTAPI_HISTORY_TIMEZONE_VERIFIED").toLowerCase() !== "true"
    ) {
      throw new MtapiApiError(
        "MTAPI historical timestamp timezone is not verified for backtesting",
        503,
        "MTAPI_HISTORY_TIMEZONE_UNVERIFIED",
      )
    }

    const mode = envValue(env, "MTAPI_HISTORY_TIMESTAMP_MODE").toLowerCase()
    if (mode === "utc") return { timestampMode: "utc", utcOffsetSeconds: 0 }
    if (mode !== "server") {
      throw new MtapiApiError(
        "MTAPI_HISTORY_TIMESTAMP_MODE must be explicitly verified as utc or server",
        503,
        "MTAPI_HISTORY_TIMEZONE_UNVERIFIED",
      )
    }

    let raw: number | null = null
    try {
      raw = timezoneNumber(await client.serverTimezone(sessionId, platform))
    } catch {
      // Some bridge builds expose the offset only through AccountDetails.
    }
    if (raw == null) {
      const details = await client.accountDetails(sessionId, platform)
      raw = timezoneNumber(details.serverTimeZone ?? details.ServerTimeZone)
    }
    if (raw == null) {
      throw new MtapiApiError(
        "MTAPI server timezone response is invalid",
        502,
        "INVALID_RESPONSE",
      )
    }

    const unit = envValue(env, "MTAPI_SERVER_TIMEZONE_UNIT").toLowerCase()
    const multiplier = unit === "hours" ? 3_600 : unit === "minutes" ? 60 : unit === "seconds" ? 1 : 0
    const sign = envValue(env, "MTAPI_SERVER_TIMEZONE_SIGN").toLowerCase()
    const dst = envValue(env, "MTAPI_SERVER_TIMEZONE_DST").toLowerCase()
    if (
      !multiplier ||
      (sign !== "server_minus_utc" && sign !== "utc_minus_server") ||
      dst !== "none"
    ) {
      throw new MtapiApiError(
        "MTAPI server timezone unit/sign/DST policy has not been explicitly verified",
        503,
        "MTAPI_HISTORY_TIMEZONE_UNVERIFIED",
      )
    }
    const utcOffsetSeconds = raw * multiplier *
      (sign === "server_minus_utc" ? 1 : -1)
    if (
      !Number.isFinite(utcOffsetSeconds) ||
      Math.abs(utcOffsetSeconds) > 18 * 3_600
    ) {
      throw new MtapiApiError(
        "MTAPI server timezone offset is invalid",
        502,
        "INVALID_RESPONSE",
      )
    }
    return { timestampMode: "server", utcOffsetSeconds }
  }
}

export function mtapiTimeframeMinutes(timeframe: BacktestTimeframe): number {
  switch (timeframe) {
    case "1m":
      return 1
    case "5m":
      return 5
    case "15m":
      return 15
    case "1h":
      return 60
    case "1d":
      return 1_440
  }
}

export function mt4HistoryTimeframe(timeframe: BacktestTimeframe): string {
  switch (timeframe) {
    case "1m":
      return "M1"
    case "5m":
      return "M5"
    case "15m":
      return "M15"
    case "1h":
      return "H1"
    case "1d":
      return "D1"
  }
}

export function requestedMt4BarCount(
  fromMs: number,
  toMs: number,
  timeframeMinutes: number,
): number {
  if (!(toMs >= fromMs) || timeframeMinutes <= 0) return 0
  return Math.ceil((toMs - fromMs) / (timeframeMinutes * MINUTE_MS)) + 1
}

function bridgeClockMs(ms: number, clock: MtapiClockNormalization): number {
  return ms +
    (clock.timestampMode === "server" ? clock.utcOffsetSeconds * 1000 : 0)
}

function formatMt5HistoryTime(
  ms: number,
  clock: MtapiClockNormalization,
): string {
  if (clock.timestampMode === "utc") return new Date(ms).toISOString()
  return new Date(bridgeClockMs(ms, clock)).toISOString().slice(0, 19)
}

function formatMt4HistoryTime(
  ms: number,
  clock: MtapiClockNormalization,
): string {
  return new Date(bridgeClockMs(ms, clock)).toISOString().slice(0, 19)
}

function parseNumericTimestamp(value: number): number {
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value
}

export function parseMtapiTimestamp(
  value: unknown,
  clock: MtapiClockNormalization,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = parseNumericTimestamp(value)
    return parsed > 0 ? parsed : null
  }
  const text = String(value ?? "").trim()
  if (!text) return null
  const numeric = Number(text)
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(text)) {
    const parsed = parseNumericTimestamp(numeric)
    return parsed > 0 ? parsed : null
  }
  const hasExplicitOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text)
  const asUtc = hasExplicitOffset ? text : `${text.replace(/\s+/, "T")}Z`
  const parsed = Date.parse(asUtc)
  if (!Number.isFinite(parsed)) return null
  return parsed -
    (!hasExplicitOffset && clock.timestampMode === "server" ? clock.utcOffsetSeconds * 1000 : 0)
}

function consistentNumber(
  row: Record<string, unknown>,
  keys: string[],
): number | null {
  const found = keys.filter((key) => row[key] !== undefined && row[key] !== null && row[key] !== "")
  if (found.length === 0) return null
  const values = found.map((key) => Number(row[key]))
  if (values.some((value) => !Number.isFinite(value))) return null
  const first = values[0]!
  return values.every((value) => value === first) ? first : null
}

function consistentTimestamp(
  row: Record<string, unknown>,
  clock: MtapiClockNormalization,
): number | null {
  const keys = [
    "time",
    "Time",
    "dateTime",
    "DateTime",
    "timestamp",
    "Timestamp",
  ]
  const found = keys.filter((key) => row[key] !== undefined && row[key] !== null && row[key] !== "")
  if (found.length === 0) return null
  const values = found.map((key) => parseMtapiTimestamp(row[key], clock))
  if (values.some((value) => value == null)) return null
  const first = values[0]!
  return values.every((value) => value === first) ? first : null
}

/** MT5 exact names plus documented MT4/common casing variants; conflicting variants fail. */
export function normalizeMtapiBar(
  raw: unknown,
  clock: MtapiClockNormalization,
): HistoricalBar | null {
  const row = object(raw)
  const ts = consistentTimestamp(row, clock)
  const open = consistentNumber(row, [
    "openPrice",
    "OpenPrice",
    "open",
    "Open",
  ])
  const high = consistentNumber(row, [
    "highPrice",
    "HighPrice",
    "high",
    "High",
  ])
  const low = consistentNumber(row, ["lowPrice", "LowPrice", "low", "Low"])
  const close = consistentNumber(row, [
    "closePrice",
    "ClosePrice",
    "close",
    "Close",
  ])
  if (
    ts == null || open == null || high == null || low == null || close == null
  ) return null
  if (
    ts <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low
  ) return null
  if (open < low || open > high || close < low || close > high) return null
  const spread = consistentNumber(row, ["spread", "Spread"])
  if (spread != null && spread < 0) return null
  return { ts, open, high, low, close, ...(spread == null ? {} : { spread }) }
}

function normalizeChunk(
  raw: unknown[],
  clock: MtapiClockNormalization,
  endpoint: string,
  strict: boolean,
): HistoricalBar[] {
  const bars = raw.map((row) => normalizeMtapiBar(row, clock))
    .filter((bar): bar is HistoricalBar => bar != null)
  if (strict && raw.length > 0 && bars.length === 0) {
    throw new MtapiApiError(
      `${endpoint} response could not be normalized unambiguously`,
      502,
      "INVALID_RESPONSE",
    )
  }
  return bars
}

export class MtapiHistoricalMarketData implements HistoricalMarketDataSource {
  readonly provider = "mtapi" as const
  private readonly clockCache = new Map<
    string,
    Promise<MtapiClockNormalization>
  >()

  constructor(
    private readonly client: MtapiClient,
    private readonly resolveClock: MtapiClockResolver,
  ) {}

  async symbols(sessionId: string, platform: string | null): Promise<string[]> {
    return await this.client.symbols(sessionId, platform)
  }

  private clock(
    sessionId: string,
    platform: string | null,
  ): Promise<MtapiClockNormalization> {
    const key = `${sessionId}:${platform ?? ""}`
    let pending = this.clockCache.get(key)
    if (!pending) {
      pending = this.resolveClock(sessionId, platform)
      this.clockCache.set(key, pending)
    }
    return pending
  }

  async historicalBars(
    request: HistoricalBarsRequest,
  ): Promise<HistoricalFetchResult<HistoricalBar>> {
    if (!(request.fromMs < request.toMs)) return { data: [], requestCount: 0 }
    const clock = await this.clock(request.sessionId, request.platform)
    return String(request.platform ?? "MT5").toUpperCase() === "MT4" ? await this.mt4Bars(request, clock) : await this.mt5Bars(request, clock)
  }

  private async mt5Bars(
    request: HistoricalBarsRequest,
    clock: MtapiClockNormalization,
  ): Promise<HistoricalFetchResult<HistoricalBar>> {
    const timeframe = mtapiTimeframeMinutes(request.timeframe)
    const windowMs = timeframe * MINUTE_MS * MTAPI_MAX_BARS_PER_REQUEST
    const chunks: HistoricalBar[][] = []
    let requestCount = 0
    for (let cursor = request.fromMs; cursor < request.toMs;) {
      if (requestCount >= MAX_HISTORY_REQUESTS) {
        throw new MtapiApiError(
          "MTAPI PriceHistory request limit exceeded",
          400,
          "HISTORY_RANGE_TOO_LARGE",
        )
      }
      const end = Math.min(request.toMs, cursor + windowMs)
      const raw = await this.client.priceHistory(request.sessionId, {
        symbol: request.symbol,
        from: formatMt5HistoryTime(cursor, clock),
        to: formatMt5HistoryTime(end, clock),
        timeFrame: timeframe,
        timeoutSeconds: 30,
      }, request.platform)
      requestCount += 1
      chunks.push(normalizeChunk(raw, clock, "PriceHistory", false))
      cursor = end
    }
    return {
      data: mergeHistoricalBars(chunks, request.fromMs, request.toMs),
      requestCount,
    }
  }

  private async mt4Bars(
    request: HistoricalBarsRequest,
    clock: MtapiClockNormalization,
  ): Promise<HistoricalFetchResult<HistoricalBar>> {
    const timeframeMinutes = mtapiTimeframeMinutes(request.timeframe)
    const timeframeMs = timeframeMinutes * MINUTE_MS
    const chunks: HistoricalBar[][] = []
    let requestCount = 0
    let end = request.toMs
    while (end >= request.fromMs) {
      if (requestCount >= MAX_HISTORY_REQUESTS) {
        throw new MtapiApiError(
          "MTAPI QuoteHistory request limit exceeded",
          400,
          "HISTORY_RANGE_TOO_LARGE",
        )
      }
      const start = Math.max(
        request.fromMs,
        end - MT4_TARGET_BARS_PER_REQUEST * timeframeMs,
      )
      const count = Math.min(
        MTAPI_MAX_BARS_PER_REQUEST,
        requestedMt4BarCount(start, end, timeframeMinutes) + 1,
      )
      const raw = await this.client.quoteHistory(request.sessionId, {
        symbol: request.symbol,
        timeframe: mt4HistoryTimeframe(request.timeframe),
        from: formatMt4HistoryTime(end, clock),
        count,
      }, request.platform)
      requestCount += 1
      chunks.push(normalizeChunk(raw, clock, "QuoteHistory", true))
      if (start === request.fromMs) break
      end = start
    }
    return {
      data: mergeHistoricalBars(chunks, request.fromMs, request.toMs),
      requestCount,
    }
  }
}
