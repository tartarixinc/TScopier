/**
 * mtapi-clock-probe — kept staging diagnostic for broker clock onboarding.
 *
 * Read-only. Answers: are MTAPI bar timestamps UTC or server-local, what is the
 * declared server timezone, and does the clock shift with daylight saving?
 * Run it whenever a new broker server family appears, before trusting backtest
 * history on it (see docs/scratchpad-backtest-mtapi-timezone-2026-10-31.md).
 *
 * Actions:
 *   POST {action:"clock"}   — ServerTimezone / AccountDetails / symbols flags /
 *                             recent H1 bars vs now / D1 bars across a DST switch.
 *   POST {action:"live"}    — weekend-crypto anchor vs real UTC + DST window.
 *   POST {action:"deep"}    — non-zero-offset servers: quote tick epoch check.
 *   POST {action:"xtalk"}   — gold cross-feed between two servers (offline).
 *   POST {action:"map"}     — per-server H1 series (optional from/to/accounts).
 *   POST {action:"history"} — run the real MtapiHistoricalMarketData path
 *                             (clock resolver + bars) to verify the gate state.
 *
 * Auth: bearer must equal ALERT_EVALUATOR_SERVICE_KEY or
 * SUPABASE_SERVICE_ROLE_KEY (never the public anon key). Session ids are used
 * server-side only and never echoed; the map action additionally scrubs them
 * from bridge error text. No credentials are returned.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2"
import { MtapiClient } from "../_shared/mtapiClient.ts"
import {
  createMtapiClockResolver,
  MtapiHistoricalMarketData,
  parseMtapiTimestamp,
} from "../_shared/backtest/mtapiMarketData.ts"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function envString(name: string): string {
  return String(Deno.env.get(name) ?? "").trim()
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function timezoneish(value: unknown, depth = 0): Record<string, number> {
  const out: Record<string, number> = {}
  if (value == null || typeof value !== "object" || Array.isArray(value)) return out
  if (depth > 1) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
      Object.assign(out, timezoneish(raw, depth + 1))
      continue
    }
    if (!/(timezone|time_zone|dst)/i.test(key)) continue
    const num = Number(raw)
    if (Number.isFinite(num)) out[key] = num
    else if (typeof raw === "string") out[key] = Number(raw) || 0
  }
  return out
}

function timezonePrimitive(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === "number" || typeof value === "string") return value
  if (typeof value === "object") {
    const row = value as Record<string, unknown>
    for (
      const key of ["serverTimeZone", "ServerTimeZone", "timezone", "Timezone", "result", "Result"]
    ) {
      const num = Number(row[key])
      if (Number.isFinite(num)) return num
      if (row[key] != null && typeof row[key] === "object") {
        const nested = timezonePrimitive(row[key])
        if (nested != null) return nested
      }
    }
    const row2 = timezoneish(row)
    const keys = Object.keys(row2)
    if (keys.length > 0) return Object.fromEntries(keys.map((k) => [k, row2[k]]))
  }
  return null
}

function barTime(row: unknown): unknown {
  if (row == null || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  for (
    const key of ["time", "Time", "dateTime", "DateTime", "timestamp", "Timestamp", "at"]
  ) {
    if (r[key] !== undefined && r[key] !== null && r[key] !== "") return r[key]
  }
  return null
}

function barClose(row: unknown): unknown {
  if (row == null || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  for (
    const key of ["closePrice", "ClosePrice", "close", "Close"]
  ) {
    if (r[key] !== undefined && r[key] !== null && r[key] !== "") return r[key]
  }
  return null
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Per-account time budget so a slow bridge cannot blow the platform timeout. */
function actionDeadline(seconds: number): () => boolean {
  const end = Date.now() + seconds * 1_000
  return () => Date.now() > end
}

interface ProbeAccount {
  id: string
  label: string
  platform: string
  mtapi_status: string | null
  mtapi_session_id: string
}

async function probeAccount(
  client: MtapiClient,
  account: ProbeAccount,
  nowMs: number,
): Promise<Record<string, unknown>> {
  const sessionId = account.mtapi_session_id
  const platform = account.platform
  const out: Record<string, unknown> = {
    label: account.label,
    platform,
    mtapiStatus: account.mtapi_status,
  }
  const errors: Record<string, string> = {}

  try {
    out.serverTimezoneRaw = timezonePrimitive(await client.serverTimezone(sessionId, platform))
  } catch (err) {
    errors.serverTimezone = errorText(err)
  }

  try {
    const details = await client.accountDetails(sessionId, platform)
    out.accountDetailsTimezone = timezoneish(details)
    const server = (details as Record<string, unknown>).server
      ?? (details as Record<string, unknown>).Server
    if (typeof server === "string") out.brokerServer = server
  } catch (err) {
    errors.accountDetails = errorText(err)
  }

  let symbols: string[] = []
  try {
    symbols = await client.symbols(sessionId, platform)
    out.symbolCount = symbols.length
    out.hasBtcUsd = symbols.some((s) => /^BTCUSD/i.test(s))
    out.hasXauUsd = symbols.some((s) => /^XAUUSD/i.test(s))
  } catch (err) {
    errors.symbols = errorText(err)
  }

  // Keep ORIGINAL casing — bridge history endpoints are case-sensitive
  // (e.g. "BTCUSDm" must be sent exactly as the Symbols list returned it).
  const candidates = ["BTCUSD", "BTCUSDT", "XAUUSD", "EURUSD", "GBPUSD"]
    .map((wanted) => symbols.find((s) => s.toUpperCase() === wanted)
      ?? symbols.find((s) => s.toUpperCase().startsWith(wanted)))
    .filter((s): s is string => Boolean(s))
  const picked: string[] = []
  for (const sym of candidates) {
    if (!picked.includes(sym)) picked.push(sym)
  }
  out.candidateSymbols = picked
  const historyErrors: Record<string, string> = {}
  const expired = actionDeadline(90)

  for (const probeSymbol of picked.slice(0, 3)) {
    if (expired()) {
      historyErrors.deadline = "90s budget exhausted — remaining candidates skipped"
      break
    }
    const recentFrom = iso(nowMs - 48 * HOUR_MS)
    const recentTo = iso(nowMs + 6 * HOUR_MS)
    if (!out.recentH1) {
      try {
        const rows = platform === "MT4"
          ? await client.quoteHistory(sessionId, {
            symbol: probeSymbol,
            timeframe: "H1",
            from: recentTo,
            count: 60,
          }, platform)
          : await client.priceHistory(sessionId, {
            symbol: probeSymbol,
            from: recentFrom,
            to: recentTo,
            timeFrame: 60,
            timeoutSeconds: 60,
          }, platform)
        if (Array.isArray(rows) && rows.length > 0) {
          out.recentSymbol = probeSymbol
          out.recentH1 = rows.slice(-60).map((row) => ({ t: barTime(row), c: barClose(row) }))
        } else {
          historyErrors[`recentH1:${probeSymbol}`] = "empty response"
        }
      } catch (err) {
        historyErrors[`recentH1:${probeSymbol}`] = errorText(err)
      }
    }

    if (!out.dailyD1) {
      try {
        const rows = platform === "MT4"
          ? await client.quoteHistory(sessionId, {
            symbol: probeSymbol,
            timeframe: "D1",
            from: iso(nowMs + 6 * HOUR_MS),
            count: 70,
          }, platform)
          : await client.priceHistory(sessionId, {
            symbol: probeSymbol,
            from: iso(nowMs - 70 * DAY_MS),
            to: recentTo,
            timeFrame: 1440,
            timeoutSeconds: 60,
          }, platform)
        if (Array.isArray(rows) && rows.length > 0) {
          out.dailySymbol = probeSymbol
          out.dailyD1 = rows.slice(0, 70).map((row) => barTime(row))
        } else {
          historyErrors[`dailyD1:${probeSymbol}`] = "empty response"
        }
      } catch (err) {
        historyErrors[`dailyD1:${probeSymbol}`] = errorText(err)
      }
    }

    if (out.recentH1 && out.dailyD1) break
  }

  if (Object.keys(historyErrors).length > 0) out.historyErrors = historyErrors
  if (Object.keys(errors).length > 0) out.errors = errors
  return out
}

async function probeClock(supabase: SupabaseClient): Promise<Response> {
  const nowMs = Date.now()
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id, label, platform, mtapi_status, mtapi_session_id")
    .eq("is_active", true)
    .eq("provider", "mtapi")
    .eq("mtapi_status", "connected")
    .not("mtapi_session_id", "is", null)
    .neq("mtapi_session_id", "")
    .order("created_at", { ascending: false })
    .limit(6)
  if (error) return jsonResponse({ error: error.message }, 500)

  const accounts = ((data ?? []) as unknown as ProbeAccount[])
    .filter((row) => String(row.mtapi_session_id ?? "").trim().length > 0)
    .slice(0, 6)

  const mtapi = new MtapiClient({ env: Deno.env, timeoutMs: 15_000 })
  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        return await probeAccount(mtapi, account, nowMs)
      } catch (err) {
        return {
          label: account.label,
          platform: account.platform,
          fatal: errorText(err),
        }
      }
    }),
  )

  return jsonResponse({
    nowUtcMs: nowMs,
    nowUtc: iso(nowMs),
    gate: {
      verified: envString("MTAPI_HISTORY_TIMEZONE_VERIFIED"),
      mode: envString("MTAPI_HISTORY_TIMESTAMP_MODE"),
      unit: envString("MTAPI_SERVER_TIMEZONE_UNIT"),
      unitMt4: envString("MTAPI_SERVER_TIMEZONE_UNIT_MT4"),
      unitMt5: envString("MTAPI_SERVER_TIMEZONE_UNIT_MT5"),
      sign: envString("MTAPI_SERVER_TIMEZONE_SIGN"),
      dst: envString("MTAPI_SERVER_TIMEZONE_DST"),
    },
    accounts: results,
  })
}

async function probeHistory(supabase: SupabaseClient): Promise<Response> {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id, label, platform, mtapi_status, mtapi_session_id")
    .eq("is_active", true)
    .eq("provider", "mtapi")
    .eq("mtapi_status", "connected")
    .not("mtapi_session_id", "is", null)
    .neq("mtapi_session_id", "")
    .order("created_at", { ascending: false })
    .limit(4)
  if (error) return jsonResponse({ error: error.message }, 500)

  const nowMs = Date.now()
  const mtapi = new MtapiClient({ env: Deno.env, timeoutMs: 15_000 })
  const results: Record<string, unknown>[] = []
  const expired = actionDeadline(150)
  for (const row of (data ?? []) as unknown as ProbeAccount[]) {
    if (expired()) {
      results.push({ skipped: "150s budget exhausted — remaining accounts not probed" })
      break
    }
    const sessionId = String(row.mtapi_session_id ?? "").trim()
    if (!sessionId) continue
    const source = new MtapiHistoricalMarketData(
      mtapi,
      createMtapiClockResolver(mtapi, Deno.env),
    )
    const entry: Record<string, unknown> = { label: row.label, platform: row.platform }
    try {
      const symbols = await source.symbols(sessionId, row.platform)
      const symbol = symbols.find((s) => s.toUpperCase() === "BTCUSD")
        ?? symbols.find((s) => s.toUpperCase().startsWith("BTCUSD"))
        ?? symbols.find((s) => s.toUpperCase().startsWith("XAUUSD"))
        ?? null
      if (!symbol) {
        entry.error = "no BTCUSD/XAUUSD symbol"
      } else {
        entry.symbol = symbol
        const result = await source.historicalBars({
          sessionId,
          platform: row.platform,
          symbol,
          timeframe: "5m",
          fromMs: nowMs - 24 * HOUR_MS,
          toMs: nowMs,
        })
        entry.barCount = result.data.length
        entry.requestCount = result.requestCount
        entry.firstBarUtc = result.data[0] ? iso(result.data[0].ts) : null
        entry.lastBarUtc = result.data.at(-1) ? iso(result.data.at(-1)!.ts) : null
        const expectedFirst = nowMs - 24 * HOUR_MS
        entry.firstBarSkewMinutes = result.data[0]
          ? Math.round((result.data[0].ts - expectedFirst) / 60_000)
          : null
        const expectedLastOpen = nowMs - (nowMs % 300_000)
        entry.lastBarSkewMinutes = result.data.at(-1)
          ? Math.round((result.data.at(-1)!.ts - expectedLastOpen) / 60_000)
          : null
      }
    } catch (err) {
      entry.error = errorText(err)
      entry.errorCode = (err as { code?: string })?.code ?? null
    }
    results.push(entry)
  }

  return jsonResponse({
    nowUtc: iso(nowMs),
    gate: {
      verified: envString("MTAPI_HISTORY_TIMEZONE_VERIFIED"),
      mode: envString("MTAPI_HISTORY_TIMESTAMP_MODE"),
      unit: envString("MTAPI_SERVER_TIMEZONE_UNIT"),
      unitMt4: envString("MTAPI_SERVER_TIMEZONE_UNIT_MT4"),
      unitMt5: envString("MTAPI_SERVER_TIMEZONE_UNIT_MT5"),
      sign: envString("MTAPI_SERVER_TIMEZONE_SIGN"),
      dst: envString("MTAPI_SERVER_TIMEZONE_DST"),
    },
    accounts: results,
  })
}

const CRYPTO_RE = /(BTC|ETH|XRP|SOL|ADA|DOGE|LTC|BNB|DOT|AVAX|LINK|TRX|XLM)/i

/** Live-market anchor + DST-weekend window. Decides UTC vs server-local strings. */
async function probeLive(supabase: SupabaseClient): Promise<Response> {
  const nowMs = Date.now()
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id, label, platform, mtapi_status, mtapi_session_id")
    .eq("is_active", true)
    .eq("provider", "mtapi")
    .eq("mtapi_status", "connected")
    .not("mtapi_session_id", "is", null)
    .neq("mtapi_session_id", "")
    .limit(8)
  if (error) return jsonResponse({ error: error.message }, 500)

  const accounts = ((data ?? []) as unknown as ProbeAccount[])
    .filter((row) => String(row.mtapi_session_id ?? "").trim().length > 0)
    .slice(0, 6)

  const mtapi = new MtapiClient({ env: Deno.env, timeoutMs: 15_000 })
  const results = await Promise.all(
    accounts.map(async (account) => {
      const out: Record<string, unknown> = {
        label: account.label,
        platform: account.platform,
      }
      try {
        out.serverTimezoneRaw = timezonePrimitive(
          await mtapi.serverTimezone(account.mtapi_session_id, account.platform),
        )
        const symbols = await mtapi.symbols(account.mtapi_session_id, account.platform)
        const crypto = symbols.filter((s) => CRYPTO_RE.test(s))
        out.cryptoCount = crypto.length
        out.cryptoSample = crypto.slice(0, 40)

        const errors: Record<string, string> = {}
        const expired = actionDeadline(90)
        for (const symbol of crypto.slice(0, 6)) {
          if (out.liveBars) break
          if (expired()) {
            errors.deadline = "90s budget exhausted — remaining candidates skipped"
            break
          }
          try {
            const rows = account.platform === "MT4"
              ? await mtapi.quoteHistory(account.mtapi_session_id, {
                symbol,
                timeframe: "H1",
                from: iso(nowMs + 2 * HOUR_MS),
                count: 16,
              }, account.platform)
              : await mtapi.priceHistory(account.mtapi_session_id, {
                symbol,
                from: iso(nowMs - 12 * HOUR_MS),
                to: iso(nowMs + 2 * HOUR_MS),
                timeFrame: 60,
                timeoutSeconds: 60,
              }, account.platform)
            if (Array.isArray(rows) && rows.length > 0) {
              out.liveSymbol = symbol
              out.liveBars = rows.map((row) => barTime(row))
            } else {
              errors[`live:${symbol}`] = "empty"
            }
          } catch (err) {
            errors[`live:${symbol}`] = errorText(err)
          }
        }

        // EU DST switch: Sunday 2026-10-25 01:00 UTC (CEST -> CET fall-back).
        const dstSymbol = String(out.liveSymbol ?? crypto[0] ?? "")
        if (dstSymbol && !expired()) {
          try {
            const rows = account.platform === "MT4"
              ? await mtapi.quoteHistory(account.mtapi_session_id, {
                symbol: dstSymbol,
                timeframe: "H1",
                from: "2026-10-26T12:00:00",
                count: 72,
              }, account.platform)
              : await mtapi.priceHistory(account.mtapi_session_id, {
                symbol: dstSymbol,
                from: "2026-10-24T00:00:00Z",
                to: "2026-10-26T12:00:00Z",
                timeFrame: 60,
                timeoutSeconds: 60,
              }, account.platform)
            if (Array.isArray(rows) && rows.length > 0) {
              out.dstSymbol = dstSymbol
              out.dstBars = rows.map((row) => barTime(row))
            }
          } catch (err) {
            errors[`dst:${dstSymbol}`] = errorText(err)
          }
        }

        if (Object.keys(errors).length > 0) out.errors = errors
      } catch (err) {
        out.fatal = errorText(err)
      }
      return out
    }),
  )

  return jsonResponse({ nowUtcMs: nowMs, nowUtc: iso(nowMs), accounts: results })
}

/**
 * Deep probe for a specific non-zero-offset server: find any weekend-active
 * symbol, inspect quote tick fields for an absolute epoch, and list time-ish
 * account fields. Settles UTC vs server-local string clock today.
 */
async function probeDeep(supabase: SupabaseClient): Promise<Response> {
  const nowMs = Date.now()
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id, label, platform, mtapi_status, mtapi_session_id")
    .eq("is_active", true)
    .eq("provider", "mtapi")
    .eq("mtapi_status", "connected")
    .not("mtapi_session_id", "is", null)
    .neq("mtapi_session_id", "")
    .limit(8)
  if (error) return jsonResponse({ error: error.message }, 500)

  const wanted = (data ?? []) as unknown as ProbeAccount[]
  const mtapi = new MtapiClient({ env: Deno.env, timeoutMs: 15_000 })
  const results: Record<string, unknown>[] = []
  const expired = actionDeadline(150)

  // Deep-probe only servers whose declared timezone is non-zero — those are
  // the only ones where UTC and server-local readings differ.
  const selected: ProbeAccount[] = []
  for (const account of wanted) {
    if (expired()) break
    try {
      const tz = timezonePrimitive(await mtapi.serverTimezone(account.mtapi_session_id, account.platform))
      if (String(tz ?? "0") !== "0" && !selected.some((s) => s.id === account.id)) {
        selected.push(account)
      }
    } catch {
      /* checked per-account below anyway */
    }
  }
  if (selected.length === 0 && wanted.length > 0 && !expired()) selected.push(wanted[0]!)

  for (const account of selected) {
    if (expired()) {
      results.push({ label: account.label, skipped: "150s budget exhausted — not probed" })
      continue
    }
    const sessionId = account.mtapi_session_id
    const out: Record<string, unknown> = {
      label: account.label,
      platform: account.platform,
    }
    try {
      out.serverTimezoneRaw = timezonePrimitive(await mtapi.serverTimezone(sessionId, account.platform))
      const symbols = await mtapi.symbols(sessionId, account.platform)
      const crypto = symbols.filter((s) => CRYPTO_RE.test(s))
      // Prefer plain, likely-active names first.
      const ordered = [
        ...crypto.filter((s) => /^(BTC|ETH|XRP|SOL|LTC|DOGE|ADA|BNB)$/i.test(s)),
        ...crypto.filter((s) => /^(ABTC|HBTC|BTCC|BTCU|SOL|LTC|XRP|ETH|ADAC)/i.test(s)),
        ...crypto.filter((s) => /BTC/i.test(s)),
        ...crypto,
      ].filter((s, i, arr) => arr.indexOf(s) === i)

      const attempts: Record<string, unknown>[] = []
      for (const symbol of ordered.slice(0, 14)) {
        if (expired()) {
          attempts.push({ symbol: null, deadline: "action budget exhausted — remaining candidates skipped" })
          break
        }
        const attempt: Record<string, unknown> = { symbol }
        try {
          const rows = account.platform === "MT4"
            ? await mtapi.quoteHistory(sessionId, {
              symbol,
              timeframe: "H1",
              from: iso(nowMs + 2 * HOUR_MS),
              count: 16,
            }, account.platform)
            : await mtapi.priceHistory(sessionId, {
              symbol,
              from: iso(nowMs - 12 * HOUR_MS),
              to: iso(nowMs + 2 * HOUR_MS),
              timeFrame: 60,
              timeoutSeconds: 60,
            }, account.platform)
          const times = (Array.isArray(rows) ? rows : []).map((r) => barTime(r))
          const fresh = times.filter((t) => {
            const ms = parseNaiveMs(t)
            return ms != null && ms >= nowMs - 6 * HOUR_MS && ms <= nowMs + 2 * HOUR_MS
          })
          attempt.liveRows = times.length
          attempt.liveLatest = times.length ? times[times.length - 1] : null
          attempt.liveFresh = fresh.length
          if (fresh.length > 0 && !out.freshSymbol) out.freshSymbol = symbol
        } catch (err) {
          attempt.liveError = errorText(err)
        }

        if (!out.dstBars && !expired()) {
          try {
            const rows = account.platform === "MT4"
              ? await mtapi.quoteHistory(sessionId, {
                symbol,
                timeframe: "H1",
                from: "2026-10-26T12:00:00",
                count: 72,
              }, account.platform)
              : await mtapi.priceHistory(sessionId, {
                symbol,
                from: "2026-10-24T00:00:00Z",
                to: "2026-10-26T12:00:00Z",
                timeFrame: 60,
                timeoutSeconds: 60,
              }, account.platform)
            const times = (Array.isArray(rows) ? rows : [])
              .map((r) => barTime(r))
              .filter((t) => {
                const s = String(t ?? "")
                return s >= "2026-10-24" && s < "2026-10-27"
              })
            if (times.length >= 24) {
              const labels = times.map(String)
              const dupes = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))]
              out.dstSymbol = symbol
              out.dstBars = labels
              out.dstDuplicateLabels = dupes
            } else {
              attempt.dstRows = times.length
            }
          } catch (err) {
            attempt.dstError = errorText(err)
          }
        }

        attempts.push(attempt)
        if (out.freshSymbol && out.dstBars) break
      }
      out.attempts = attempts

      // Quote tick: any absolute-time field (epoch) to anchor against bar strings.
      for (const symbol of ["XAUUSD", out.freshSymbol, ordered[0]]) {
        if (expired()) break
        if (!symbol || out.quote) continue
        try {
          const quote = await mtapi.getQuote(sessionId, String(symbol), account.platform)
          out.quote = { symbol: String(symbol), rows: quote }
        } catch (err) {
          out.quoteError = `${String(symbol)}: ${errorText(err)}`
        }
      }

      // Time-ish fields in account details (names + values of time keys only).
      if (!expired()) try {
        const details = await mtapi.accountDetails(sessionId, account.platform)
        const timeish: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(details)) {
          if (/(^time$|time$|date|stamp)/i.test(k) && typeof v !== "object") timeish[k] = v
        }
        out.detailsTimeish = timeish
        out.detailsKeys = Object.keys(details).slice(0, 60)
      } catch (err) {
        out.detailsError = errorText(err)
      }
    } catch (err) {
      out.fatal = errorText(err)
    }
    results.push(out)
  }

  return jsonResponse({ nowUtcMs: nowMs, nowUtc: iso(nowMs), accounts: results })
}

function parseNaiveMs(value: unknown): number | null {
  return parseMtapiTimestamp(value, { timestampMode: "utc", utcOffsetSeconds: 0 })
}

/**
 * Cross-feed clock test: XAUUSD H1 bars from the non-zero-offset server and
 * from a proven-UTC control server over 2026-10-20..2026-10-31 (spans the
 * 2026-10-25 EU DST switch), plus a narrow request-window consistency check.
 * Offline — works while markets are closed.
 */
async function probeXtalk(supabase: SupabaseClient): Promise<Response> {
  const nowMs = Date.now()
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("id, label, platform, mtapi_status, mtapi_session_id")
    .eq("is_active", true)
    .eq("provider", "mtapi")
    .eq("mtapi_status", "connected")
    .not("mtapi_session_id", "is", null)
    .neq("mtapi_session_id", "")
    .limit(8)
  if (error) return jsonResponse({ error: error.message }, 500)

  const wanted = (data ?? []) as unknown as ProbeAccount[]
  const pick = (match: (row: ProbeAccount) => boolean) => wanted.find(match)
  const target = pick((row) => row.label === "MT5 • 10012737211")
    ?? wanted.find((row) => row.platform === "MT5")
  const control = pick((row) => row.label === "MT5 • 476205482")
    ?? wanted.find((row) => row.id !== target?.id)

  const mtapi = new MtapiClient({ env: Deno.env, timeoutMs: 15_000 })

  const gold = async (account: ProbeAccount): Promise<Record<string, unknown> | null> => {
    if (!account) return null
    const symbols = await mtapi.symbols(account.mtapi_session_id, account.platform)
    const symbol = symbols.find((s) => s.toUpperCase() === "XAUUSD")
      ?? symbols.find((s) => s.toUpperCase().startsWith("XAUUSD"))
    if (!symbol) return { label: account.label, error: "no XAUUSD" }
    const rows = account.platform === "MT4"
      ? await mtapi.quoteHistory(account.mtapi_session_id, {
        symbol,
        timeframe: "H1",
        from: "2026-10-31T06:00:00",
        count: 264,
      }, account.platform)
      : await mtapi.priceHistory(account.mtapi_session_id, {
        symbol,
        from: "2026-10-20T00:00:00Z",
        to: "2026-10-31T00:00:00Z",
        timeFrame: 60,
        timeoutSeconds: 90,
      }, account.platform)
    const bars = (Array.isArray(rows) ? rows : [])
      .map((row) => ({ t: barTime(row), c: barClose(row) }))
      .filter((b) => String(b.t ?? "") >= "2026-10-20" && String(b.t ?? "") < "2026-11-01")
    return { label: account.label, symbol, bars }
  }

  // Narrow window: bounds are a KNOWN real hour gold was trading
  // (Fri 2026-10-30 19:00-20:00 UTC). Which label comes back reveals how the
  // bridge parses request times (X) relative to bar labels (Y).
  const narrow = async (account: ProbeAccount): Promise<Record<string, unknown> | null> => {
    if (!account) return null
    try {
      const symbols = await mtapi.symbols(account.mtapi_session_id, account.platform)
      const symbol = symbols.find((s) => s.toUpperCase() === "XAUUSD")
        ?? symbols.find((s) => s.toUpperCase().startsWith("XAUUSD"))
      if (!symbol) return null
      const rows = account.platform === "MT4"
        ? await mtapi.quoteHistory(account.mtapi_session_id, {
          symbol,
          timeframe: "H1",
          from: "2026-10-30T19:59:59",
          count: 2,
        }, account.platform)
        : await mtapi.priceHistory(account.mtapi_session_id, {
          symbol,
          from: "2026-10-30T19:00:00Z",
          to: "2026-10-30T19:59:59Z",
          timeFrame: 60,
          timeoutSeconds: 60,
        }, account.platform)
      return {
        label: account.label,
        symbol,
        bars: (Array.isArray(rows) ? rows : []).map((row) => ({ t: barTime(row), c: barClose(row) })),
      }
    } catch (err) {
      return { label: account.label, error: errorText(err) }
    }
  }

  const goldSafe = (account: ProbeAccount | undefined | null): Promise<Record<string, unknown> | null> =>
    account
      ? gold(account).catch((err) => ({ label: account.label, error: errorText(err) }))
      : Promise.resolve(null)
  const [targetGold, controlGold, targetNarrow, controlNarrow] = await Promise.all([
    goldSafe(target),
    goldSafe(control),
    target ? narrow(target) : Promise.resolve(null),
    control ? narrow(control) : Promise.resolve(null),
  ])

  return jsonResponse({
    nowUtcMs: nowMs,
    nowUtc: iso(nowMs),
    target: target?.label ?? null,
    control: control?.label ?? null,
    targetGold,
    controlGold,
    targetNarrow,
    controlNarrow,
  })
}

/**
 * Per-server clock map for the global backtest clock policy.
 * Body: { accounts?: [{label, platform, sessionId}] } — when provided, probe
 * exactly those sessions (prod sessions passed from the Management API);
 * otherwise auto-discover staging connected accounts.
 * Per account: declared ServerTimezone + H1 bars 2026-10-20..2026-10-31 for
 * BTC (absolute-anchored offline vs Coinbase), falling back to XAUUSD.
 * Session ids are used server-side only and never echoed.
 */
async function probeMap(
  supabase: SupabaseClient,
  explicit: ProbeAccount[],
  range: { from: string; to: string; count: number },
): Promise<Response> {
  const nowMs = Date.now()
  let accounts: ProbeAccount[] = explicit
  if (accounts.length === 0) {
    const { data, error } = await supabase
      .from("broker_accounts")
      .select("id, label, platform, mtapi_status, mtapi_session_id")
      .eq("is_active", true)
      .eq("provider", "mtapi")
      .eq("mtapi_status", "connected")
      .not("mtapi_session_id", "is", null)
      .neq("mtapi_session_id", "")
      .limit(10)
    if (error) return jsonResponse({ error: error.message }, 500)
    accounts = (data ?? []) as unknown as ProbeAccount[]
  }
  accounts = accounts.filter((row) => String(row.mtapi_session_id ?? "").trim().length > 0)

  const mtapi = new MtapiClient({ env: Deno.env, timeoutMs: 15_000 })
  const results = await Promise.all(
    accounts.map(async (account) => {
      const out: Record<string, unknown> = {
        label: account.label,
        platform: account.platform,
      }
      const sessionId = account.mtapi_session_id
      // Session ids in this action come from the request body — scrub them
      // from any bridge error text before the response leaves the function.
      const errText = (err: unknown) => errorText(err).split(sessionId).join("[SESSION]")
      try {
        out.declaredTz = timezonePrimitive(await mtapi.serverTimezone(sessionId, account.platform))
      } catch (err) {
        out.declaredTzError = errText(err)
      }
      try {
        const symbols = await mtapi.symbols(sessionId, account.platform)
        const btc = [
          ...symbols.filter((s) => s.toUpperCase() === "BTCUSD"),
          ...symbols.filter((s) => s.toUpperCase().startsWith("BTCUSD")),
          ...symbols.filter((s) => /BTC/i.test(s)),
        ].filter((s, i, arr) => arr.indexOf(s) === i)
        const gold = symbols.find((s) => s.toUpperCase() === "XAUUSD")
          ?? symbols.find((s) => s.toUpperCase().startsWith("XAUUSD"))
          ?? null

        const fetchBars = async (symbol: string): Promise<{ t: unknown; c: unknown }[]> => {
          const rows = account.platform === "MT4"
            ? await mtapi.quoteHistory(sessionId, {
              symbol,
              timeframe: "H1",
              from: range.to,
              count: range.count,
            }, account.platform)
            : await mtapi.priceHistory(sessionId, {
              symbol,
              from: range.from + "T00:00:00Z",
              to: range.to + "T00:00:00Z",
              timeFrame: 60,
              timeoutSeconds: 45,
            }, account.platform)
          return (Array.isArray(rows) ? rows : [])
            .map((row) => ({ t: barTime(row), c: barClose(row) }))
            .filter((b) => {
              const s = String(b.t ?? "")
              return s >= range.from && s < range.to && b.c != null
            })
        }

        const errors: Record<string, string> = {}
        const expired = actionDeadline(90)
        for (const symbol of btc.slice(0, 4)) {
          if (expired()) {
            errors.deadline = "90s budget exhausted — remaining candidates skipped"
            break
          }
          try {
            const bars = await fetchBars(symbol)
            if (bars.length >= 24) {
              out.instrument = symbol
              out.bars = bars
              break
            }
            errors[btc.length ? `btc:${symbol}` : symbol] = `only ${bars.length} bars`
          } catch (err) {
            errors[`btc:${symbol}`] = errText(err)
          }
        }
        if (!out.bars && gold && !expired()) {
          try {
            const bars = await fetchBars(gold)
            out.instrument = gold
            out.bars = bars
            out.goldOnly = true
          } catch (err) {
            errors[`gold:${gold}`] = errText(err)
          }
        }
        if (Object.keys(errors).length > 0) out.errors = errors
        if (!out.bars) out.noBars = true
      } catch (err) {
        out.fatal = errText(err)
      }
      return out
    }),
  )

  return jsonResponse({ nowUtcMs: nowMs, nowUtc: iso(nowMs), accounts: results })
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405)

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  const apikey = (req.headers.get("apikey") ?? "").trim()
  // Never accept SUPABASE_ANON_KEY here: it is public (shipped to browsers),
  // so it would leave this diagnostic open to anyone with the site bundle.
  const allowed = new Set(
    [
      envString("ALERT_EVALUATOR_SERVICE_KEY"),
      envString("SUPABASE_SERVICE_ROLE_KEY"),
    ].filter(Boolean),
  )
  if (!allowed.has(bearer) && !allowed.has(apikey)) {
    return jsonResponse({ error: "Unauthorized" }, 401)
  }

  const body = await req.json().catch(() => ({}) as Record<string, unknown>)
  const action = String(body.action ?? "clock")

  try {
    const supabase = createClient(
      envString("SUPABASE_URL"),
      envString("SUPABASE_SERVICE_ROLE_KEY"),
    ) as unknown as SupabaseClient

    if (action === "history") return await probeHistory(supabase)
    if (action === "live") return await probeLive(supabase)
    if (action === "deep") return await probeDeep(supabase)
    if (action === "xtalk") return await probeXtalk(supabase)
    if (action === "map") {
      const raw = Array.isArray(body.accounts) ? body.accounts : []
      const explicit = raw.map((row: Record<string, unknown>) => ({
        id: "",
        label: String(row.label ?? ""),
        platform: String(row.platform ?? "MT5"),
        mtapi_status: "connected",
        mtapi_session_id: String(row.sessionId ?? ""),
      }))
      const range = {
        from: /^\d{4}-\d{2}-\d{2}$/.test(String(body.from ?? ""))
          ? String(body.from)
          : "2026-10-20",
        to: /^\d{4}-\d{2}-\d{2}$/.test(String(body.to ?? ""))
          ? String(body.to)
          : "2026-11-01",
        count: Number(body.count) > 0 ? Math.min(Number(body.count), 1200) : 528,
      }
      return await probeMap(supabase, explicit, range)
    }
    return await probeClock(supabase)
  } catch (err) {
    return jsonResponse({ error: errorText(err) }, 500)
  }
})
