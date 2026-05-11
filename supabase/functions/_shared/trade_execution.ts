import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const METATRADERAPI_KEY = Deno.env.get("METATRADERAPI_KEY") ?? ""
const METATRADERAPI_BASE = (Deno.env.get("METATRADERAPI_BASE_URL") ?? "https://api.metatraderapi.dev").replace(/\/$/, "")

interface ParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[]
  lot_size: number | null
  confidence: number
  raw_instruction?: string
  /** When set (e.g. 0.5 = half, 0.25 = partial), partial_profit uses this instead of TP-hit heuristics. */
  partial_close_fraction?: number | null
}

type JsonRecord = Record<string, unknown>
type BrokerRow = JsonRecord & {
  id: string
  user_id: string
  metaapi_account_id: string
  default_lot_size: number
  pip_tolerance: number
  copier_mode?: string | null
  signal_channel_ids?: string[] | null
  enforce_signal_channel_filter?: boolean | null
  ai_settings?: unknown
  manual_settings?: unknown
}

type ManualTpLot = { label: string; lot: number; enabled: boolean }
type ManualSettings = {
  symbol_mapping: Record<string, string>
  symbol_prefix: string
  symbol_suffix: string
  symbol_to_trade: string | null
  symbols_exclude: string[]
  risk_mode: "fixed_lot" | "dynamic_balance_percent"
  fixed_lot: number
  dynamic_balance_percent: number
  tp_lots: ManualTpLot[]
  trade_style: "single" | "multi"
  reverse_signal: boolean
  use_predefined_sl_pips: boolean
  predefined_sl_pips: number
  use_predefined_tp_pips: boolean
  predefined_tp_pips: number[]
  add_new_trades_to_existing: boolean
  close_on_opposite_signal: boolean
  time_filter_enabled: boolean
  trade_start_time: string
  trade_end_time: string
  days_filter_enabled: boolean
  trade_days: number[]
}

/**
 * Postgres uuid[] normally arrives as string[] via PostgREST; fall back if driver returns a `{a,b}` string.
 * Empty list = legacy "copy all subscribed channels".
 */
function normalizeSubscriberChannelIds(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
  }
  if (typeof raw === "string") {
    const s = raw.trim()
    if (s.startsWith("{") && s.endsWith("}")) {
      const inner = s.slice(1, -1).trim()
      if (!inner) return []
      return inner
        .split(",")
        .map((x) => x.replace(/^["']|["']$/g, "").trim().toLowerCase())
        .filter(Boolean)
    }
  }
  return []
}

function brokerEligibleForSignal(
  broker: Pick<BrokerRow, "signal_channel_ids" | "enforce_signal_channel_filter">,
  channelId: string | null,
): boolean {
  if (broker.enforce_signal_channel_filter !== true) return true
  const ids = normalizeSubscriberChannelIds(broker.signal_channel_ids)
  if (ids.length === 0) return true
  // Product choice: signals without DB channel linkage still mirror to all brokers (same as unrestricted list).
  if (!channelId) return true
  const cid = String(channelId).trim().toLowerCase()
  return ids.includes(cid)
}

function normalizeAiSettings(raw: unknown): {
  risk_percent_per_trade: number
  min_lot: number
  max_lot: number
  reference_equity: number
  fallback_lot: number | null
  risk_basis: "equity" | "balance"
  sizing_mode: "linear" | "margin"
} {
  const j = (raw && typeof raw === "object") ? raw as JsonRecord : {}
  const rb = String(j.risk_basis ?? "equity").toLowerCase()
  const sm = String(j.sizing_mode ?? "linear").toLowerCase()
  return {
    risk_percent_per_trade: Math.min(10, Math.max(0.05, Number(j.risk_percent_per_trade ?? 1) || 1)),
    min_lot: Math.max(0.001, Number(j.min_lot ?? 0.01) || 0.01),
    max_lot: Math.min(100, Math.max(0.01, Number(j.max_lot ?? 5) || 5)),
    reference_equity: Math.max(100, Number(j.reference_equity ?? 10000) || 10000),
    fallback_lot: j.fallback_lot != null && Number.isFinite(Number(j.fallback_lot)) ? Number(j.fallback_lot) : null,
    risk_basis: rb === "balance" ? "balance" : "equity",
    sizing_mode: sm === "margin" ? "margin" : "linear",
  }
}

function normalizeManualSettings(raw: unknown): ManualSettings {
  const j = (raw && typeof raw === "object") ? raw as JsonRecord : {}
  const rawMap = (j.symbol_mapping && typeof j.symbol_mapping === "object") ? j.symbol_mapping as Record<string, unknown> : {}
  const tpRaw = Array.isArray(j.tp_lots) ? j.tp_lots : []
  return {
    symbol_mapping: Object.fromEntries(Object.entries(rawMap).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
    symbol_prefix: String(j.symbol_prefix ?? ""),
    symbol_suffix: String(j.symbol_suffix ?? ""),
    symbol_to_trade: j.symbol_to_trade ? String(j.symbol_to_trade).toUpperCase() : null,
    symbols_exclude: Array.isArray(j.symbols_exclude) ? j.symbols_exclude.map((x) => String(x).toUpperCase()) : [],
    risk_mode: String(j.risk_mode ?? "fixed_lot") === "dynamic_balance_percent" ? "dynamic_balance_percent" : "fixed_lot",
    fixed_lot: Math.max(0.001, Number(j.fixed_lot ?? 0.01) || 0.01),
    dynamic_balance_percent: Math.min(20, Math.max(0.05, Number(j.dynamic_balance_percent ?? 1) || 1)),
    tp_lots: tpRaw.map((x, i) => {
      const r = (x && typeof x === "object") ? x as Record<string, unknown> : {}
      return { label: String(r.label ?? `TP${i + 1}`), lot: Math.max(0.001, Number(r.lot ?? 0.01) || 0.01), enabled: r.enabled !== false }
    }),
    trade_style: String(j.trade_style ?? "single") === "multi" ? "multi" : "single",
    reverse_signal: Boolean(j.reverse_signal ?? false),
    use_predefined_sl_pips: Boolean(j.use_predefined_sl_pips ?? false),
    predefined_sl_pips: Math.max(1, Number(j.predefined_sl_pips ?? 30) || 30),
    use_predefined_tp_pips: Boolean(j.use_predefined_tp_pips ?? false),
    predefined_tp_pips: Array.isArray(j.predefined_tp_pips) ? j.predefined_tp_pips.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0) : [],
    add_new_trades_to_existing: j.add_new_trades_to_existing !== false,
    close_on_opposite_signal: Boolean(j.close_on_opposite_signal ?? false),
    time_filter_enabled: Boolean(j.time_filter_enabled ?? false),
    trade_start_time: String(j.trade_start_time ?? "00:00"),
    trade_end_time: String(j.trade_end_time ?? "23:59"),
    days_filter_enabled: Boolean(j.days_filter_enabled ?? false),
    trade_days: Array.isArray(j.trade_days) ? j.trade_days.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [1, 2, 3, 4, 5],
  }
}

function normalizeSym(s: string | null): string {
  return String(s ?? "").trim().toUpperCase().replace(/\s+/g, "")
}

function inManualTradingWindow(m: ManualSettings): boolean {
  const now = new Date()
  if (m.days_filter_enabled) {
    const jsDay = now.getDay()
    if (!m.trade_days.includes(jsDay)) return false
  }
  if (!m.time_filter_enabled) return true
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
  return hhmm >= m.trade_start_time && hhmm <= m.trade_end_time
}

function applyManualSymbolRouting(inputSymbol: string | null, m: ManualSettings): string | null {
  const src = normalizeSym(inputSymbol)
  if (!src && !m.symbol_to_trade) return null
  let sym = src
  if (sym && m.symbol_mapping[sym]) sym = m.symbol_mapping[sym]
  if (m.symbol_to_trade) sym = normalizeSym(m.symbol_to_trade)
  if (m.symbol_prefix) sym = `${m.symbol_prefix}${sym}`
  if (m.symbol_suffix) sym = `${sym}${m.symbol_suffix}`
  if (m.symbols_exclude.includes(sym)) return null
  return sym
}

function clampLot(n: number, min: number, max: number): number {
  if (!Number.isFinite(n) || n <= 0) return min
  return Math.min(max, Math.max(min, n))
}

function extractBalanceEquityFromAccountPayload(p: Record<string, unknown>): {
  balance: number | null
  equity: number | null
} {
  const summary = (p.summary && typeof p.summary === "object") ? p.summary as Record<string, unknown> : {}
  const balRaw = Number(p.balance ?? p.Balance ?? summary.balance ?? summary.Balance)
  const eqRaw = Number(p.equity ?? p.Equity ?? summary.equity ?? summary.Equity)
  const balance = Number.isFinite(balRaw) && balRaw >= 0 ? balRaw : null
  const equity = Number.isFinite(eqRaw) && eqRaw >= 0 ? eqRaw : null
  return { balance, equity }
}

async function fetchAccountSnapshot(accountId: string): Promise<{ balance: number | null; equity: number | null }> {
  const from = "2024-01-01T00:00:00"
  const paths: [string, Record<string, QueryValue>][] = [
    ["/AccountSummary", { id: accountId }],
    ["/Account", { id: accountId }],
    ["/TradeStats", { id: accountId, from }],
  ]
  let balance: number | null = null
  let equity: number | null = null
  for (const [path, params] of paths) {
    try {
      const raw = await mtGet(path, params)
      if (!raw || typeof raw !== "object") continue
      const snap = extractBalanceEquityFromAccountPayload(raw as Record<string, unknown>)
      if (snap.balance != null) balance = snap.balance
      if (snap.equity != null) equity = snap.equity
      if (balance != null || equity != null) break
    } catch {
      // try next
    }
  }
  return { balance, equity }
}

/** Broker SYMBOL_VOLUME_MIN for the resolved instrument (lots), if discoverable via API. */
async function brokerMinLotForParsedSymbol(metaAccountId: string, symbolRaw: string | null): Promise<number | null> {
  if (!metaAccountId || !symbolRaw?.trim()) return null
  try {
    const resolved = await resolveTradableSymbol(metaAccountId, symbolRaw.trim())
    const spec = await fetchSymbolVolumeSpec(metaAccountId, resolved)
    const m = spec?.min
    return m != null && Number.isFinite(m) && m > 0 ? m : null
  } catch {
    return null
  }
}

async function resolveLotAndPips(
  supabase: ReturnType<typeof createClient>,
  brokerAccount: BrokerRow,
  signal: { channel_id: string | null },
  parsed: ParsedSignal,
): Promise<{ lotSize: number; pipTolerance: number; sizingLog: JsonRecord }> {
  let pipTolerance = Number(brokerAccount.pip_tolerance ?? 20)
  const defaultLot = Number(brokerAccount.default_lot_size ?? 0.01)
  let lotSize = defaultLot

  const metaId = String(brokerAccount.metaapi_account_id ?? "")

  if (signal.channel_id) {
    const { data: channel } = await supabase
      .from("telegram_channels")
      .select("pip_tolerance_override, lot_size_override")
      .eq("id", signal.channel_id)
      .maybeSingle()

    const ch = channel as { pip_tolerance_override?: number | null; lot_size_override?: number | null } | null
    if (ch?.pip_tolerance_override) pipTolerance = Number(ch.pip_tolerance_override)
    if (ch?.lot_size_override) lotSize = Number(ch.lot_size_override)
  }

  const brokerLotFloor = metaId ? await brokerMinLotForParsedSymbol(metaId, parsed.symbol) : null

  const parsedLot = parsed.lot_size != null ? Number(parsed.lot_size) : null
  if (Number.isFinite(parsedLot!) && parsedLot! > 0) {
    const lotRounded = brokerLotFloor != null ? Math.max(parsedLot!, brokerLotFloor) : parsedLot!
    return {
      lotSize: lotRounded,
      pipTolerance,
      sizingLog: {
        source: "parsed_signal_lot",
        parsed_lot: parsedLot,
        broker_min_lot_floor: brokerLotFloor,
      },
    }
  }

  const mode = String(brokerAccount.copier_mode ?? "ai").toLowerCase()
  const ai = normalizeAiSettings(brokerAccount.ai_settings)
  const manual = normalizeManualSettings(brokerAccount.manual_settings)
  const tpMeta = deriveTpExecutionMeta(parsed)

  if (mode === "manual") {
    if (manual.risk_mode === "dynamic_balance_percent" && metaId) {
      const snap = await fetchAccountSnapshot(metaId)
      const basis = snap.balance ?? snap.equity
      if (basis != null && basis > 0) {
        lotSize = Math.max(0.001, (basis * (manual.dynamic_balance_percent / 100)) / 10000)
      }
    } else {
      lotSize = manual.fixed_lot ?? defaultLot
    }
    const enabledTpLots = (manual.tp_lots ?? []).filter((x) => x.enabled !== false).map((x) => Number(x.lot)).filter((n) => Number.isFinite(n) && n > 0)
    if (enabledTpLots.length > 0) {
      lotSize = manual.trade_style === "single" ? enabledTpLots.reduce((a, b) => a + b, 0) : enabledTpLots[0]
    }
    if (brokerLotFloor != null && lotSize < brokerLotFloor) lotSize = brokerLotFloor
    lotSize = clampLot(lotSize, ai.min_lot, ai.max_lot)
    return {
      lotSize,
      pipTolerance,
      sizingLog: { source: "manual_mode", risk_mode: manual.risk_mode, trade_style: manual.trade_style, enabled_tp_lots: enabledTpLots, broker_min_lot_floor: brokerLotFloor },
    }
  }

  const snapshot = metaId ? await fetchAccountSnapshot(metaId) : { balance: null as number | null, equity: null as number | null }
  const accountBasis = ai.risk_basis === "balance"
    ? (snapshot.balance ?? snapshot.equity)
    : (snapshot.equity ?? snapshot.balance)
  const riskBudgetUsd =
    accountBasis != null && accountBasis > 0 ? accountBasis * (ai.risk_percent_per_trade / 100) : null

  const canTryMargin =
    ai.sizing_mode === "margin" &&
    Boolean(metaId) &&
    (parsed.action === "buy" || parsed.action === "sell") &&
    Boolean(parsed.symbol?.trim()) &&
    riskBudgetUsd != null &&
    riskBudgetUsd > 0

  if (canTryMargin) {
    let margin1: number | null = null
    let resolvedSym = ""
    try {
      resolvedSym = await resolveTradableSymbol(metaId, parsed.symbol!.trim())
      const dealType: "DealBuy" | "DealSell" = parsed.action === "sell" ? "DealSell" : "DealBuy"
      const pxRaw = parsed.entry_price ?? parsed.entry_zone_low ?? parsed.entry_zone_high
      const price = pxRaw != null && Number.isFinite(Number(pxRaw)) && Number(pxRaw) > 0 ? Number(pxRaw) : 0
      margin1 = await fetchRequiredMarginForOneLot(metaId, resolvedSym, dealType, price)
    } catch {
      margin1 = null
    }

    if (margin1 != null && margin1 > 0 && Number.isFinite(margin1)) {
      let lot = riskBudgetUsd! / margin1
      lot *= tpMeta.tpMultiplier
      lot = clampLot(lot, ai.min_lot, ai.max_lot)
      let nextLot = lot
      if (brokerLotFloor != null && nextLot < brokerLotFloor) {
        nextLot = brokerLotFloor
        nextLot = clampLot(nextLot, ai.min_lot, ai.max_lot)
      }
      return {
        lotSize: nextLot,
        pipTolerance,
        sizingLog: {
          source: "ai_margin_percent",
          sizing_mode: ai.sizing_mode,
          margin_per_1_lot: margin1,
          risk_budget_usd: riskBudgetUsd,
          risk_percent_per_trade: ai.risk_percent_per_trade,
          risk_basis: ai.risk_basis,
          account_basis: accountBasis,
          balance_snapshot: snapshot.balance,
          equity_snapshot: snapshot.equity,
          resolved_symbol: resolvedSym,
          broker_min_lot_floor: brokerLotFloor,
          min_lot: ai.min_lot,
          max_lot: ai.max_lot,
          tp_count: tpMeta.tpLevels.length,
          tp_open: tpMeta.tpOpen,
          tp_multiplier: tpMeta.tpMultiplier,
        },
      }
    }
  }

  const marginFallback =
    ai.sizing_mode === "margin" && canTryMargin ? "margin_unavailable_or_invalid" : null
  const riskUsdLinear = riskBudgetUsd ??
    (((snapshot.balance ?? snapshot.equity) ?? 0) > 0
      ? (snapshot.balance ?? snapshot.equity)! * (ai.risk_percent_per_trade / 100)
      : null)

  const refRiskUsd = Math.max(ai.reference_equity * 0.01, 1)
  let lot =
    riskUsdLinear != null && riskUsdLinear > 0
      ? defaultLot * (riskUsdLinear / refRiskUsd)
      : clampLot(defaultLot, ai.min_lot, ai.max_lot)
  lot = clampLot(lot, ai.min_lot, ai.max_lot)

  const entry = parsed.entry_price ?? parsed.entry_zone_low ?? parsed.entry_zone_high
  const sl = parsed.sl
  const refPx = Math.max(
    entry != null && Number.isFinite(Number(entry)) ? Math.abs(Number(entry)) : 0,
    sl != null && Number.isFinite(Number(sl)) ? Math.abs(Number(sl)) : 0,
  )
  const useSlDistanceRisk = refPx > 0 && refPx < 5000
  const basisForSl = snapshot.balance ?? snapshot.equity
  if (
    basisForSl != null && basisForSl > 0 && riskUsdLinear != null && riskUsdLinear > 0 &&
    entry != null && sl != null && useSlDistanceRisk &&
    Number.isFinite(entry) && Number.isFinite(sl)
  ) {
    const dist = Math.abs(Number(entry) - Number(sl))
    if (dist > 1e-8) {
      const heuristicLots = riskUsdLinear / (dist * 80)
      lot = clampLot(heuristicLots, ai.min_lot, ai.max_lot)
    }
  }

  lot *= tpMeta.tpMultiplier

  if (!Number.isFinite(lot) || lot <= 0) {
    lot = ai.fallback_lot != null ? ai.fallback_lot : defaultLot
  }
  lotSize = clampLot(lot, ai.min_lot, ai.max_lot)

  if (brokerLotFloor != null && lotSize < brokerLotFloor) {
    lotSize = brokerLotFloor
    lotSize = clampLot(lotSize, ai.min_lot, ai.max_lot)
  }

  return {
    lotSize,
    pipTolerance,
    sizingLog: {
      source: "ai_linear_risk",
      sizing_mode: ai.sizing_mode,
      margin_mode_fallback_reason: marginFallback,
      formula: "default_lot * (account_basis * risk_percent/100) / (reference_equity * 0.01)",
      balance_snapshot: snapshot.balance,
      equity_snapshot: snapshot.equity,
      risk_usd_budget: riskUsdLinear,
      account_basis: accountBasis,
      broker_min_lot_floor: brokerLotFloor,
      reference_equity: ai.reference_equity,
      risk_percent_per_trade: ai.risk_percent_per_trade,
      risk_basis: ai.risk_basis,
      default_lot_anchor: defaultLot,
      min_lot: ai.min_lot,
      max_lot: ai.max_lot,
      tp_count: tpMeta.tpLevels.length,
      tp_open: tpMeta.tpOpen,
      tp_multiplier: tpMeta.tpMultiplier,
    },
  }
}

type OpenTradeRow = {
  id: string
  signal_id: string | null
  telegram_channel_id?: string | null
  metaapi_order_id: string | null
  symbol: string
  direction: string
  entry_price: number | null
  lot_size: number
  sl: number | null
  tp: number | null
  tp_levels?: number[] | null
  tp_open?: boolean | null
  tp_step_policy?: Record<string, unknown> | null
  next_tp_index?: number | null
  opened_at?: string | null
  status?: string | null
}

type ManagementCorrelationResult =
  | { kind: "resolved"; trade: OpenTradeRow; resolution: string }
  | { kind: "blocked"; reason: string }
  | null

/** Schema: open | modified | closed | cancelled — modified is still an active broker position after SL/TP updates. */
const ACTIVE_POSITION_STATUSES = ["open", "modified"] as const

function isActivePositionStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase()
  return s === "open" || s === "modified"
}

async function loadOpenTradeRows(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  direction: string | null,
): Promise<OpenTradeRow[]> {
  let query = supabase
    .from("trades")
    .select("id, signal_id, telegram_channel_id, metaapi_order_id, symbol, direction, entry_price, lot_size, sl, tp, tp_levels, tp_open, tp_step_policy, next_tp_index, opened_at")
    .eq("user_id", userId)
    .eq("broker_account_id", brokerAccountId)
    .in("status", [...ACTIVE_POSITION_STATUSES])

  if (direction === "buy" || direction === "sell") {
    query = query.eq("direction", direction)
  }

  const { data: rows } = await query.order("opened_at", { ascending: false }).limit(40)
  return (rows ?? []) as OpenTradeRow[]
}

function pickTradeByParsedSymbol(rows: OpenTradeRow[], symbol: string | null): OpenTradeRow | null {
  if (!symbol?.trim()) return null
  const upper = symbol.toUpperCase().replace(/\s/g, "")
  const scored = rows.map((t) => {
    const ts = String(t.symbol ?? "").toUpperCase().replace(/\s/g, "")
    const exact = ts === upper ? 2 : ts.includes(upper) || upper.includes(ts) ? 1 : 0
    return { t, score: exact }
  }).filter((x) => x.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.t ?? null
}

const NON_INSTRUMENT_SYMBOL_TOKENS = new Set([
  "CHANGE", "CHANGED", "CHANGES", "UPDATE", "UPDATED", "MODIFY", "MODIFIED", "MODIFICATION",
  "ADJUST", "ADJUSTED", "REVISE", "REVISED", "EDIT", "MOVE", "MOVED", "SHIFT", "TWEAK",
  "CLOSE", "CLOSED", "EXIT", "QUIT", "CANCEL", "CANCELLED",
  "BREAKEVEN", "BE", "SECURE", "LOCK", "PROFIT", "LOSS", "TRAIL", "TRAILING",
  "SIGNAL", "SETUP", "ALERT", "CALL", "TRADE", "POSITION", "ORDER", "ACTIVE", "PENDING",
  "BUY", "SELL", "LONG", "SHORT", "MARKET", "LIMIT", "STOP", "ENTRY", "ZONE", "RANGE",
  "TP", "SL", "NOW", "HERE", "WAIT", "AREA", "CHANNEL", "PAIR", "CHART", "SCREEN",
])

function effectiveSymbolForManagementMatch(symbol: string | null): string | null {
  if (!symbol?.trim()) return null
  const u = symbol.trim().toUpperCase().replace(/\s/g, "")
  if (u.length < 5) return null
  if (NON_INSTRUMENT_SYMBOL_TOKENS.has(u)) return null
  return u
}

async function fetchLatestOpenTradeForChannel(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  channelId: string,
): Promise<OpenTradeRow | null> {
  // Fast path: new trades are linked directly to telegram_channel_id.
  const { data: directTrades } = await supabase
    .from("trades")
    .select("id, signal_id, telegram_channel_id, metaapi_order_id, symbol, direction, entry_price, lot_size, sl, tp, tp_levels, tp_open, tp_step_policy, next_tp_index, opened_at")
    .eq("user_id", userId)
    .eq("broker_account_id", brokerAccountId)
    .in("status", [...ACTIVE_POSITION_STATUSES])
    .eq("telegram_channel_id", channelId)
    .order("opened_at", { ascending: false })
    .limit(1)
  if (directTrades?.[0]) return directTrades[0] as OpenTradeRow

  // Keep a wide window so symbol-less management commands (e.g. "CLOSE FULL")
  // can still correlate long-running positions whose entry signal is older.
  const recentSignals = 5000
  const { data: sigRows } = await supabase
    .from("signals")
    .select("id")
    .eq("user_id", userId)
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(recentSignals)

  const signalIds = Array.from(new Set((sigRows ?? []).map((r: { id: string }) => r.id).filter(Boolean)))
  if (!signalIds.length) return null

  const { data: tradeList } = await supabase
    .from("trades")
    .select("id, signal_id, telegram_channel_id, metaapi_order_id, symbol, direction, entry_price, lot_size, sl, tp, tp_levels, tp_open, tp_step_policy, next_tp_index, opened_at")
    .eq("user_id", userId)
    .eq("broker_account_id", brokerAccountId)
    .in("status", [...ACTIVE_POSITION_STATUSES])
    .in("signal_id", signalIds)
    .order("opened_at", { ascending: false })
    .limit(1)

  const row = tradeList?.[0]
  return row ? (row as OpenTradeRow) : null
}

async function fetchOpenTradesForChannel(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  channelId: string,
  direction: string | null,
): Promise<OpenTradeRow[]> {
  // Use the same wide channel history window as management correlation.
  const recentSignals = 5000
  const { data: sigRows } = await supabase
    .from("signals")
    .select("id")
    .eq("user_id", userId)
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(recentSignals)
  const signalIds = Array.from(new Set((sigRows ?? []).map((r: { id: string }) => r.id).filter(Boolean)))
  if (!signalIds.length) return []

  let query = supabase
    .from("trades")
    .select("id, signal_id, telegram_channel_id, metaapi_order_id, symbol, direction, entry_price, lot_size, sl, tp, tp_levels, tp_open, tp_step_policy, next_tp_index, opened_at")
    .eq("user_id", userId)
    .eq("broker_account_id", brokerAccountId)
    .in("status", [...ACTIVE_POSITION_STATUSES])
    .in("signal_id", signalIds)
    .order("opened_at", { ascending: false })
    .limit(80)
  if (direction === "buy" || direction === "sell") query = query.eq("direction", direction)
  const { data: rows } = await query
  return (rows ?? []) as OpenTradeRow[]
}

async function findMatchingOpenTrade(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  symbol: string | null,
  direction: string | null,
): Promise<OpenTradeRow | null> {
  const rows = await loadOpenTradeRows(supabase, userId, brokerAccountId, direction)
  return pickTradeByParsedSymbol(rows, symbol)
}

async function resolveOpenTradeForEntryContinuation(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  parsedSymbol: string | null,
  direction: string,
  channelId: string | null,
): Promise<{ trade: OpenTradeRow; resolution: string } | null> {
  const symbol = effectiveSymbolForManagementMatch(parsedSymbol)
  if (!symbol) return null
  if (channelId) {
    const rows = await fetchOpenTradesForChannel(supabase, userId, brokerAccountId, channelId, direction)
    const bySymbol = pickTradeByParsedSymbol(rows, symbol)
    if (bySymbol) return { trade: bySymbol, resolution: "same_direction_symbol_channel_match" }
    return null
  }
  const bySymbol = await findMatchingOpenTrade(supabase, userId, brokerAccountId, symbol, direction)
  return bySymbol ? { trade: bySymbol, resolution: "same_direction_symbol_match_no_channel" } : null
}

function getTpLevels(parsed: ParsedSignal, trade?: OpenTradeRow | null): number[] {
  if (Array.isArray(parsed.tp) && parsed.tp.length) {
    return parsed.tp.map((x) => Number(x)).filter((x) => Number.isFinite(x))
  }
  if (Array.isArray(trade?.tp_levels) && trade!.tp_levels!.length) {
    return trade!.tp_levels!.map((x) => Number(x)).filter((x) => Number.isFinite(x))
  }
  const fallback = trade?.tp != null ? Number(trade.tp) : NaN
  return Number.isFinite(fallback) ? [fallback] : []
}

function finalTpFromLevels(levels: number[]): number {
  if (!levels.length) return 0
  const last = levels[levels.length - 1]
  return Number.isFinite(last) ? Number(last) : 0
}

function deriveTpExecutionMeta(parsed: ParsedSignal): { tpLevels: number[]; tpOpen: boolean; tpMultiplier: number } {
  const tpLevels = getTpLevels(parsed, null)
  const tpOpen = /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run)\b/i.test(String(parsed.raw_instruction ?? ""))
  const tpMultiplier = Math.max(1, tpLevels.length + (tpOpen ? 1 : 0))
  return { tpLevels, tpOpen, tpMultiplier }
}

function detectTpHitStage(rawInstruction: string): 1 | 2 | 3 | null {
  const t = String(rawInstruction ?? "").toLowerCase()
  if (!t) return null
  if (/\b(tp|target)\s*1\b|\bfirst\s+(tp|target)\b|\btp1\s+hit\b|\btarget\s+1\s+hit\b/.test(t)) return 1
  if (/\b(tp|target)\s*2\b|\bsecond\s+(tp|target)\b|\btp2\s+hit\b|\btarget\s+2\s+hit\b/.test(t)) return 2
  if (/\b(tp|target)\s*3\b|\bthird\s+(tp|target)\b|\btp3\s+hit\b|\btarget\s+3\s+hit\b/.test(t)) return 3
  return null
}

async function resolveOpenTradeByParentChain(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  rootSignalId: string,
): Promise<{ trade: OpenTradeRow; resolution: string } | null> {
  let cur: string | null = rootSignalId.trim()
  if (!cur) return null
  for (let depth = 0; depth < 8 && cur; depth++) {
    const { data: tradeRow } = await supabase
      .from("trades")
      .select(
        "id, signal_id, telegram_channel_id, metaapi_order_id, symbol, direction, entry_price, lot_size, sl, tp, tp_levels, tp_open, tp_step_policy, next_tp_index, opened_at, status",
      )
      .eq("user_id", userId)
      .eq("broker_account_id", brokerAccountId)
      .eq("signal_id", cur)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (tradeRow) {
      const st = (tradeRow as { status?: string }).status
      const ticket = (tradeRow as OpenTradeRow).metaapi_order_id
      if (isActivePositionStatus(st) && ticket) {
        return {
          trade: tradeRow as OpenTradeRow,
          resolution: `parent_signal_chain_depth_${depth}`,
        }
      }
      return null
    }
    const { data: sig } = await supabase
      .from("signals")
      .select("parent_signal_id")
      .eq("id", cur)
      .maybeSingle()
    cur = (sig?.parent_signal_id as string | null) ?? null
  }
  return null
}

/**
 * CLOSE/modify/etc.: reply parent chain (strict) → plausible symbol → same-channel open → fallbacks.
 */
async function resolveOpenTradeForManagement(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  parsedSymbol: string | null,
  channelId: string | null,
  parentSignalId: string | null,
): Promise<ManagementCorrelationResult> {
  const parent = parentSignalId?.trim() ?? null
  if (parent) {
    const byChain = await resolveOpenTradeByParentChain(supabase, userId, brokerAccountId, parent)
    if (byChain) return { kind: "resolved", trade: byChain.trade, resolution: byChain.resolution }
    return { kind: "blocked", reason: "parent_trade_closed_or_missing" }
  }

  const rows = await loadOpenTradeRows(supabase, userId, brokerAccountId, null)
  if (!rows.length) return null

  const symForMatch = effectiveSymbolForManagementMatch(parsedSymbol)
  const bySymbol = pickTradeByParsedSymbol(rows, symForMatch)
  if (bySymbol) return { kind: "resolved", trade: bySymbol, resolution: "symbol_match" }

  if (channelId) {
    const byChannel = await fetchLatestOpenTradeForChannel(supabase, userId, brokerAccountId, channelId)
    if (byChannel?.metaapi_order_id) {
      return { kind: "resolved", trade: byChannel, resolution: "latest_open_same_telegram_channel" }
    }
  }

  if (rows.length === 1) {
    return { kind: "resolved", trade: rows[0], resolution: "single_open_position_fallback" }
  }

  const sorted = [...rows].sort((a, b) => {
    const ta = Date.parse(String(a.opened_at ?? ""))
    const tb = Date.parse(String(b.opened_at ?? ""))
    if (Number.isFinite(tb) && Number.isFinite(ta) && tb !== ta) return tb - ta
    return String(b.id).localeCompare(String(a.id))
  })
  const latest = sorted[0]
  if (latest?.metaapi_order_id) {
    return { kind: "resolved", trade: latest, resolution: "latest_open_on_broker_fallback" }
  }

  return null
}

async function mtOrderModify(
  accountId: string,
  ticket: string | number,
  stoploss?: number,
  takeprofit?: number,
): Promise<unknown> {
  const params: Record<string, QueryValue> = { id: accountId, ticket }
  if (stoploss !== undefined && Number.isFinite(stoploss)) params.stoploss = stoploss
  if (takeprofit !== undefined && Number.isFinite(takeprofit)) params.takeprofit = takeprofit
  return await mtGetAny(
    ["/OrderModify", "/OrdersModify"],
    params,
  )
}

async function mtOrderClose(
  accountId: string,
  ticket: string | number,
  lots?: number,
): Promise<unknown> {
  const params: Record<string, QueryValue> = {
    id: accountId,
    ticket,
  }
  // MetaTrader API docs: GET /OrderClose uses query param `lots` (not `volume`); lots=0 / omitted closes entire position.
  if (lots != null && Number.isFinite(lots) && lots > 0) {
    params.lots = lots
  }
  return await mtGetAny(
    ["/OrderClose", "/ClosePosition", "/PositionsClose"],
    params,
  )
}

type QueryValue = string | number | boolean | null | undefined

async function logExecution(
  supabase: ReturnType<typeof createClient>,
  payload: {
    user_id: string
    signal_id: string
    broker_account_id?: string | null
    action: string
    status: "attempt" | "success" | "failed"
    request_payload?: Record<string, unknown> | null
    response_payload?: unknown
    error_message?: string | null
  },
) {
  try {
    await supabase.from("trade_execution_logs").insert({
      user_id: payload.user_id,
      signal_id: payload.signal_id,
      broker_account_id: payload.broker_account_id ?? null,
      action: payload.action,
      status: payload.status,
      request_payload: payload.request_payload ?? null,
      response_payload: payload.response_payload ?? null,
      error_message: payload.error_message ?? null,
    })
  } catch {
    // Logging should never block execution path.
  }
}

async function mtGet(path: string, params: Record<string, QueryValue>) {
  const url = new URL(`${METATRADERAPI_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": METATRADERAPI_KEY,
    },
  })
  const raw = await res.text()
  let data: unknown = null
  try { data = JSON.parse(raw) } catch { data = raw }
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "message" in (data as Record<string, unknown>))
      ? String((data as Record<string, unknown>).message)
      : raw
    throw new Error(msg || `Metatrader API error ${res.status}`)
  }
  return data
}

async function mtGetAny(paths: string[], params: Record<string, QueryValue>) {
  let lastError: unknown = null
  for (const path of paths) {
    try {
      return await mtGet(path, params)
    } catch (err) {
      lastError = err
    }
  }
  throw (lastError instanceof Error ? lastError : new Error("All provider endpoints failed"))
}

function parseRequiredMarginResponse(data: unknown): number | null {
  if (typeof data === "number" && Number.isFinite(data) && data > 0) return data
  if (typeof data === "string") {
    const n = Number(data.trim())
    return Number.isFinite(n) && n > 0 ? n : null
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>
    const candidates = [
      o.margin,
      o.Margin,
      o.requiredMargin,
      o.RequiredMargin,
      o.value,
      o.Value,
      o.result,
      o.data,
    ]
    for (const c of candidates) {
      const n = typeof c === "number" ? c : Number(c)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

async function fetchRequiredMarginForOneLot(
  accountId: string,
  symbol: string,
  dealType: "DealBuy" | "DealSell",
  price: number,
): Promise<number | null> {
  const sym = symbol.trim()
  if (!sym || !accountId.trim()) return null
  try {
    const px = Number.isFinite(price) && price > 0 ? price : 0
    const data = await mtGetAny(["/RequiredMargin"], {
      id: accountId,
      symbol: sym,
      lots: 1,
      type: dealType,
      price: px,
    })
    return parseRequiredMarginResponse(data)
  } catch {
    return null
  }
}

function extractSymbolsFromPayload(payload: unknown): string[] {
  const out = new Set<string>()
  const push = (v: unknown) => {
    if (typeof v !== "string") return
    const s = v.trim()
    if (s) out.add(s)
  }
  const walk = (node: unknown) => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== "object") return
    const obj = node as Record<string, unknown>
    push(obj.symbol)
    push(obj.Symbol)
    push(obj.name)
    push(obj.Name)
    push(obj.path)
    push(obj.Path)
  }
  walk(payload)
  if (typeof payload === "object" && payload) {
    const r = payload as Record<string, unknown>
    walk(r.data)
    walk(r.result)
    walk(r.items)
    walk(r.symbols)
    walk(r.list)
  }
  return Array.from(out)
}

interface SymbolVolumeSpec {
  min: number
  max: number
  step: number
}

function numPositive(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Pull min/max/step from one object (broker APIs differ in naming). */
function volumeSpecFromRecord(obj: Record<string, unknown>): SymbolVolumeSpec | null {
  const min =
    numPositive(obj.volume_min) ??
    numPositive(obj.minVolume) ??
    numPositive(obj.min_volume) ??
    numPositive(obj.VolumeMin) ??
    numPositive(obj.vol_min) ??
    numPositive(obj.lot_min) ??
    numPositive(obj.minLot) ??
    numPositive(obj.lotsMin) ??
    numPositive(obj.LotsMin)

  const max =
    numPositive(obj.volume_max) ??
    numPositive(obj.maxVolume) ??
    numPositive(obj.max_volume) ??
    numPositive(obj.VolumeMax) ??
    numPositive(obj.vol_max) ??
    numPositive(obj.lot_max) ??
    numPositive(obj.maxLot) ??
    numPositive(obj.lotsMax) ??
    numPositive(obj.LotsMax)

  const step =
    numPositive(obj.volume_step) ??
    numPositive(obj.stepVolume) ??
    numPositive(obj.volume_step_lot) ??
    numPositive(obj.VolumeStep) ??
    numPositive(obj.vol_step) ??
    numPositive(obj.volumeStep) ??
    numPositive(obj.volumeStepLot) ??
    numPositive(obj.lotStep) ??
    numPositive(obj.lots_step) ??
    numPositive(obj.LotsStep)

  if (!min || !step) return null
  return { min, max: max ?? Math.max(min * 2000, 100), step }
}

function depthFindVolumeSpec(node: unknown, depth: number): SymbolVolumeSpec | null {
  if (depth <= 0 || node == null) return null
  if (typeof node === "object" && !Array.isArray(node)) {
    const o = node as Record<string, unknown>
    const hit = volumeSpecFromRecord(o)
    if (hit) return hit
    for (const v of Object.values(o)) {
      const inner = depthFindVolumeSpec(v, depth - 1)
      if (inner) return inner
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const inner = depthFindVolumeSpec(item, depth - 1)
      if (inner) return inner
    }
  }
  return null
}

async function fetchSymbolVolumeSpec(accountId: string, symbol: string): Promise<SymbolVolumeSpec | null> {
  const sym = symbol.trim()
  if (!sym) return null
  try {
    const payload = await mtGetAny(
      [
        "/SymbolInfo",
        "/GetSymbolInfo",
        "/SymbolParameters",
        "/MarketSymbolInfo",
        "/SymbolSpecification",
      ],
      { id: accountId, symbol: sym },
    )
    const spec = depthFindVolumeSpec(payload, 8)
    if (!spec || spec.min <= 0 || spec.step <= 0 || spec.max < spec.min) return null
    return spec
  } catch {
    return null
  }
}

function decimalsForStep(step: number): number {
  const s = String(step)
  if (!s.includes(".")) return 0
  return Math.min(10, s.replace(/^.*\./, "").length)
}

/** Snap requested lots to SYMBOL_VOLUME_* grid so brokers do not reject with INVALID_VOLUME. */
function normalizeVolumeForOrder(volume: number, spec: SymbolVolumeSpec | null): number {
  const floor = spec?.min && spec.min > 0 ? spec.min : 0.01
  let v = Number(volume)
  if (!Number.isFinite(v) || v <= 0) v = floor

  if (
    spec == null || !Number.isFinite(spec.step) || spec.step <= 0 ||
    !Number.isFinite(spec.min) || spec.min <= 0
  ) {
    v = Math.round(v * 100) / 100
    return Math.min(1000, Math.max(floor, v))
  }

  const { min: mn, step: st } = spec
  let mx = Number(spec.max)
  if (!Number.isFinite(mx) || mx < mn) mx = Math.max(mn * 500, 100)

  const dec = decimalsForStep(st)
  let snapped = Math.round(v / st) * st
  snapped = Number(snapped.toFixed(dec))
  if (snapped < mn) {
    const k = Math.ceil(mn / st - 1e-14)
    snapped = Number((k * st).toFixed(dec))
    if (snapped < mn) snapped = Number(mn.toFixed(dec))
  }
  if (snapped > mx) {
    const k = Math.floor(mx / st + 1e-14)
    snapped = Number((k * st).toFixed(dec))
  }
  if (snapped < mn) snapped = mn
  return Math.min(mx, Math.max(mn, snapped))
}

/** Floor lots to symbol step (partial closes must not round *up* past intended fraction). */
function normalizeVolumeFloorForPartial(volume: number, spec: SymbolVolumeSpec | null): number {
  const floorMin = spec?.min && spec.min > 0 ? spec.min : 0.01
  let v = Number(volume)
  if (!Number.isFinite(v) || v <= 0) return 0
  if (spec == null || !Number.isFinite(spec.step) || spec.step <= 0) {
    return Math.floor(v * 100 + 1e-9) / 100
  }
  const { min: mn, step: st } = spec
  let mx = Number(spec.max)
  if (!Number.isFinite(mx) || mx < mn) mx = Math.max(mn * 500, 100)
  const dec = decimalsForStep(st)
  let snapped = Math.floor((v + 1e-12) / st) * st
  snapped = Number(snapped.toFixed(dec))
  if (snapped < mn) {
    const k = Math.ceil(mn / st - 1e-14)
    snapped = Number((k * st).toFixed(dec))
  }
  if (snapped > mx) {
    const k = Math.floor(mx / st + 1e-14)
    snapped = Number((k * st).toFixed(dec))
  }
  if (snapped < mn) snapped = mn
  return Math.min(mx, Math.max(floorMin, snapped))
}

/** Partial close volume snapped *down* to symbol step; never the full position. */
async function snapPartialCloseLots(
  accountId: string,
  symbol: string | null | undefined,
  currentLot: number,
  fraction: number,
): Promise<number> {
  if (!Number.isFinite(currentLot) || currentLot <= 0 || !Number.isFinite(fraction) || fraction <= 0) return 0
  const sym = symbol?.trim()
  const spec = sym ? await fetchSymbolVolumeSpec(accountId, sym) : null
  const step = spec?.step && spec.step > 0 ? spec.step : 0.01
  const raw = currentLot * fraction
  let v = normalizeVolumeFloorForPartial(raw, spec)
  const maxClose = Math.max(0, currentLot - step)
  const maxCloseSnapped = normalizeVolumeFloorForPartial(maxClose, spec)
  v = Math.min(v, maxCloseSnapped)
  const minLot = spec?.min && spec.min > 0 ? spec.min : 0.01
  if (!Number.isFinite(v) || v < minLot) return 0
  return v
}

async function resolveTradableSymbol(accountId: string, requestedSymbol: string): Promise<string> {
  const requested = requestedSymbol.trim()
  const requestedUpper = requested.toUpperCase()
  if (!requested) return requestedSymbol
  try {
    const payload = await mtGetAny(
      ["/Symbols", "/GetSymbols", "/SymbolList", "/MarketWatchSymbols"],
      { id: accountId },
    )
    const symbols = extractSymbolsFromPayload(payload)
    if (!symbols.length) return requestedSymbol

    const exact = symbols.find((s) => s.toUpperCase() === requestedUpper)
    if (exact) return exact

    // Common broker suffix/prefix forms (e.g. XAUUSDm, XAUUSD.pro).
    const prefixedOrSuffixed = symbols.find((s) => {
      const u = s.toUpperCase()
      return u.startsWith(requestedUpper) || u.endsWith(requestedUpper)
    })
    if (prefixedOrSuffixed) return prefixedOrSuffixed

    return requestedSymbol
  } catch {
    return requestedSymbol
  }
}

async function getMarketExecutionPrice(accountId: string, symbol: string, action: "buy" | "sell"): Promise<number | null> {
  try {
    const tick = await mtGetAny(
      ["/SymbolInfoTick", "/GetSymbolInfoTick", "/TickInfo"],
      { id: accountId, symbol },
    )
    if (!tick || typeof tick !== "object") return null
    const t = tick as Record<string, unknown>
    const bid = Number(t.bid ?? t.Bid ?? t.bidPrice ?? t.BidPrice)
    const ask = Number(t.ask ?? t.Ask ?? t.askPrice ?? t.AskPrice)
    const candidate = action === "buy" ? ask : bid
    return Number.isFinite(candidate) && candidate > 0 ? candidate : null
  } catch {
    return null
  }
}

function pickTicket(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  const ticket =
    r.ticket ??
    (r.orderInternal as Record<string, unknown> | undefined)?.ticket ??
    (r.dealInternalIn as Record<string, unknown> | undefined)?.ticketNumber ??
    (r.dealInternalOut as Record<string, unknown> | undefined)?.ticketNumber
  if (ticket === undefined || ticket === null) return null
  return String(ticket)
}

function normalizeProviderResult(result: unknown): {
  ticket: string | null
  code: string | null
  state: string | null
  message: string | null
} {
  if (!result || typeof result !== "object") {
    return { ticket: null, code: null, state: null, message: null }
  }
  const r = result as Record<string, unknown>
  return {
    ticket: pickTicket(result),
    code: typeof r.code === "string" ? r.code : null,
    state: typeof r.state === "string" ? r.state : (typeof (r.orderInternal as Record<string, unknown> | undefined)?.state === "string" ? String((r.orderInternal as Record<string, unknown>).state) : null),
    message: typeof r.message === "string" ? r.message : null,
  }
}

function extractOpenPriceFromOrderResult(result: unknown): number | null {
  if (result == null || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  const candidates: unknown[] = [
    r.openPrice,
    r.OpenPrice,
    r.priceOpen,
    r.open_price,
    (r.orderInternal as Record<string, unknown> | undefined)?.openPrice,
    (r.orderInternal as Record<string, unknown> | undefined)?.price,
    (r.dealInternalIn as Record<string, unknown> | undefined)?.openPrice,
    (r.dealInternalIn as Record<string, unknown> | undefined)?.price,
    (r.dealInternalOut as Record<string, unknown> | undefined)?.openPrice,
  ]
  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function asPositionArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>
    for (const k of ["data", "result", "items", "positions", "orders", "openedOrders", "trades"]) {
      const v = p[k]
      if (Array.isArray(v)) return v as Record<string, unknown>[]
    }
  }
  return []
}

function rowTicketCandidates(row: Record<string, unknown>): string[] {
  const keys = [
    row.ticket,
    row.Ticket,
    row.orderTicket,
    row.positionId,
    row.positionTicket,
    row.PositionTicket,
    row.identifier,
    row.Identifier,
    row.OrderTicket,
    row.dealTicket,
    row.historyOrderId,
  ]
  return keys.filter((x) => x != null).map((x) => String(x).trim()).filter(Boolean)
}

function rowMatchesTicket(row: Record<string, unknown>, ticket: string): boolean {
  const t = String(ticket).trim()
  if (!t) return false
  return rowTicketCandidates(row).some((c) => c === t || c.replace(/\.\d+$/, "") === t)
}

function extractOpenPriceFromPositionRow(row: Record<string, unknown>): number | null {
  const candidates: unknown[] = [
    row.openPrice,
    row.OpenPrice,
    row.priceOpen,
    row.open_price,
    row.entryPrice,
    row.EntryPrice,
    row.price,
    row.Price,
  ]
  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

async function fetchOpenPriceForPositionTicket(accountId: string, ticket: string): Promise<number | null> {
  if (!accountId.trim() || !ticket.trim()) return null
  const paths = ["/OpenPositions", "/Positions", "/OpenedOrders", "/OpenOrders"]
  for (const path of paths) {
    try {
      const data = await mtGetAny([path], { id: accountId })
      const rows = asPositionArray(data)
      for (const row of rows) {
        if (!rowMatchesTicket(row, ticket)) continue
        const px = extractOpenPriceFromPositionRow(row)
        if (px != null) return px
      }
    } catch {
      // try next
    }
  }
  return null
}

function operationFor(action: string, signalPrice: number | null): string {
  if (action === "buy") return signalPrice != null ? "BuyLimit" : "Buy"
  if (action === "sell") return signalPrice != null ? "SellLimit" : "Sell"
  return "Buy"
}

function isInvalidPriceResult(result: unknown): boolean {
  const normalized = normalizeProviderResult(result)
  const parts = [normalized.code, normalized.state, normalized.message].filter(Boolean).join(" ")
  return /invalid[_\s-]?price/i.test(parts)
}

async function orderSendWithFallback(
  accountId: string,
  parsed: ParsedSignal,
  lotSize: number,
  pipTolerance: number,
  signalId: string,
): Promise<{ result: unknown; volumeUsed: number }> {
  const signalPrice = parsed.entry_price ?? parsed.entry_zone_low ?? parsed.entry_zone_high
  const resolvedSymbol = parsed.symbol ? await resolveTradableSymbol(accountId, parsed.symbol) : parsed.symbol
  const volSpec = resolvedSymbol ? await fetchSymbolVolumeSpec(accountId, resolvedSymbol) : null
  const volumeUsed = normalizeVolumeForOrder(lotSize, volSpec)
  const tpMeta = deriveTpExecutionMeta(parsed)
  const takeProfit = tpMeta.tpOpen ? 0 : finalTpFromLevels(tpMeta.tpLevels)
  const baseOperation = operationFor(parsed.action, signalPrice)
  const isLimit = baseOperation === "BuyLimit" || baseOperation === "SellLimit"
  const marketOperation = parsed.action === "buy" ? "Buy" : "Sell"
  const marketPrice = resolvedSymbol
    ? await getMarketExecutionPrice(accountId, resolvedSymbol, parsed.action === "buy" ? "buy" : "sell")
    : null

  const baseParams: Record<string, QueryValue> = {
    id: accountId,
    symbol: resolvedSymbol,
    operation: baseOperation,
    volume: volumeUsed,
    slippage: pipTolerance ?? 0,
    stoploss: parsed.sl ?? 0,
    takeprofit: takeProfit,
    comment: `TSCopier signal ${signalId}`,
    expertID: 0,
    stopLimitPrice: 0,
    expirationType: "GTC",
    placedType: "Signal",
  }

  // First attempt:
  // - limit orders: include entry price
  // - market orders: prefer live bid/ask when available
  const firstParams = isLimit
    ? { ...baseParams, price: signalPrice ?? 0 }
    : (marketPrice != null ? { ...baseParams, price: marketPrice } : { ...baseParams })
  const firstResult = await mtGet("/OrderSend", firstParams)
  if (!isInvalidPriceResult(firstResult)) {
    return { result: firstResult, volumeUsed }
  }

  // Retry #1 for INVALID_PRICE:
  // switch order type and keep SL/TP.
  const retry1Params: Record<string, QueryValue> = isLimit
    ? {
      ...baseParams,
      operation: marketOperation,
      ...(marketPrice != null ? { price: marketPrice } : {}),
    }
    : {
      ...baseParams,
      operation: parsed.action === "buy" ? "BuyLimit" : "SellLimit",
      price: signalPrice ?? 0,
    }
  const retry1Result = await mtGet("/OrderSend", retry1Params)
  if (!isInvalidPriceResult(retry1Result)) {
    return { result: retry1Result, volumeUsed }
  }

  // Retry #2 for stubborn broker constraints:
  // send pure market order without explicit price and without SL/TP,
  // then caller can still treat missing ticket as failure.
  const retry2Params: Record<string, QueryValue> = {
    id: accountId,
    symbol: resolvedSymbol ?? parsed.symbol,
    operation: marketOperation,
    volume: volumeUsed,
    ...(marketPrice != null ? { price: marketPrice } : {}),
    slippage: pipTolerance ?? 0,
    comment: `TSCopier signal ${signalId}`,
    expertID: 0,
    stopLimitPrice: 0,
    expirationType: "GTC",
    placedType: "Signal",
  }
  const retry2Result = await mtGet("/OrderSend", retry2Params)
  return { result: retry2Result, volumeUsed }
}

/** Per-broker execution. Signals table is updated only by the caller after aggregating results. */
async function executeOneBroker(
  supabase: ReturnType<typeof createClient>,
  signal: { user_id: string; channel_id: string | null; parent_signal_id?: string | null },
  signalId: string,
  parsed: ParsedSignal,
  brokerAccount: BrokerRow,
): Promise<{ ok: boolean; error?: string; trade_id?: string | null }> {
  const accountId = String(brokerAccount.metaapi_account_id ?? "")
  if (!accountId) {
    return { ok: false, error: "Missing MT bridge account id (broker_accounts link id)" }
  }

  const mode = String(brokerAccount.copier_mode ?? "ai").toLowerCase()
  const manual = normalizeManualSettings(brokerAccount.manual_settings)
  let effectiveParsed: ParsedSignal = { ...parsed, tp: [...(parsed.tp ?? [])] }
  const isEntryAction = effectiveParsed.action === "buy" || effectiveParsed.action === "sell"
  if (mode === "manual") {
    // Manual filters/overrides gate entries only; management commands must always be allowed.
    if (isEntryAction && !inManualTradingWindow(manual)) return { ok: false, error: "Blocked by manual time/day filters" }
    if (isEntryAction && manual.reverse_signal) {
      if (effectiveParsed.action === "buy") effectiveParsed.action = "sell"
      else if (effectiveParsed.action === "sell") effectiveParsed.action = "buy"
    }
    const routed = applyManualSymbolRouting(effectiveParsed.symbol, manual)
    if (isEntryAction && !routed) {
      return { ok: false, error: "Symbol excluded or unresolved by manual symbol routing" }
    }
    if (isEntryAction && routed) effectiveParsed.symbol = routed
    if (isEntryAction && manual.use_predefined_tp_pips && manual.predefined_tp_pips.length > 0) {
      const anchor = Number(effectiveParsed.entry_price ?? effectiveParsed.entry_zone_low ?? 0)
      if (Number.isFinite(anchor) && anchor > 0) {
        const dir = effectiveParsed.action === "sell" ? -1 : 1
        effectiveParsed.tp = manual.predefined_tp_pips.map((p) => anchor + (dir * (p / 100)))
      }
    }
  }

  const { lotSize, pipTolerance, sizingLog } = await resolveLotAndPips(
    supabase,
    brokerAccount,
    { channel_id: signal.channel_id },
    effectiveParsed,
  )
  const requestPayload: Record<string, unknown> = {
    signal_id: signalId,
    parsed: effectiveParsed,
    account_id: accountId,
    broker_account_id: brokerAccount.id,
    sizing: sizingLog,
  }

  await logExecution(supabase, {
    user_id: signal.user_id,
    signal_id: signalId,
    broker_account_id: brokerAccount.id,
    action: effectiveParsed.action,
    status: "attempt",
    request_payload: requestPayload,
  })

  const logFail = async (msg: string, response?: unknown) => {
    await logExecution(supabase, {
      user_id: signal.user_id,
      signal_id: signalId,
      broker_account_id: brokerAccount.id,
      action: effectiveParsed.action,
      status: "failed",
      request_payload: requestPayload,
      response_payload: response ?? null,
      error_message: msg,
    })
  }

  const logOk = async (response: unknown, extra?: Record<string, unknown>) => {
    await logExecution(supabase, {
      user_id: signal.user_id,
      signal_id: signalId,
      broker_account_id: brokerAccount.id,
      action: effectiveParsed.action,
      status: "success",
      request_payload: extra ? { ...requestPayload, ...extra } : requestPayload,
      response_payload: response,
    })
  }

  try {
    if (effectiveParsed.action === "buy" || effectiveParsed.action === "sell") {
      if (!effectiveParsed.symbol) {
        await logFail("No symbol detected")
        return { ok: false, error: "No symbol detected" }
      }
      if (mode === "manual" && !manual.add_new_trades_to_existing) {
        const existingForSymbol = await findMatchingOpenTrade(
          supabase,
          signal.user_id,
          brokerAccount.id,
          effectiveParsed.symbol,
          null,
        )
        if (existingForSymbol?.metaapi_order_id) {
          // Guard against stale DB rows: only block new entry if the ticket still exists on broker.
          const brokerHasPosition = await fetchOpenPriceForPositionTicket(
            accountId,
            String(existingForSymbol.metaapi_order_id),
          )
          if (brokerHasPosition == null || !Number.isFinite(Number(brokerHasPosition))) {
            await supabase
              .from("trades")
              .update({ status: "closed", closed_at: new Date().toISOString() })
              .eq("id", existingForSymbol.id)
          } else
          if (manual.close_on_opposite_signal && String(existingForSymbol.direction ?? "").toLowerCase() !== effectiveParsed.action) {
            await mtOrderClose(accountId, String(existingForSymbol.metaapi_order_id))
            await supabase.from("trades").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", existingForSymbol.id)
          } else {
            await logOk({ skipped: "manual_add_new_trades_to_existing_disabled" }, { manual_blocked: true })
            return { ok: true, trade_id: existingForSymbol.id }
          }
        }
      }
      const continuation = await resolveOpenTradeForEntryContinuation(
        supabase,
        signal.user_id,
        brokerAccount.id,
        effectiveParsed.symbol,
        effectiveParsed.action,
        signal.channel_id,
      )
      if (continuation?.trade?.metaapi_order_id) {
        const existing = continuation.trade
        const levels = getTpLevels(parsed, existing)
        const tpOpen = /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run)\b/i.test(String(effectiveParsed.raw_instruction ?? ""))
        const hasParsedSl = effectiveParsed.sl != null && Number.isFinite(Number(effectiveParsed.sl))
        const newSl = hasParsedSl ? Number(effectiveParsed.sl) : Number(existing.sl ?? 0)
        const newTp = tpOpen ? 0 : finalTpFromLevels(levels)
        const hasSlSource = hasParsedSl || (existing.sl != null && Number.isFinite(Number(existing.sl)))
        const hasTpSource = (levels.length > 0 && !tpOpen) || (existing.tp != null && Number.isFinite(Number(existing.tp)))
        ;(requestPayload as Record<string, unknown>).entry_continuation = {
          resolution: continuation.resolution,
          trade_id: existing.id,
          ticket: existing.metaapi_order_id,
          tp_levels: levels,
          tp_open: tpOpen,
        }
        if (!hasSlSource && !hasTpSource) {
          await logOk({ skipped: "same_direction_second_signal_no_params" }, { converted_to_modify: true, no_op: true })
          return { ok: true, trade_id: existing.id }
        }
        const modifyResult = await mtOrderModify(accountId, String(existing.metaapi_order_id), newSl, newTp)
        await logOk(modifyResult, { converted_to_modify: true, tp_levels: levels, tp_open: tpOpen })
        await supabase
          .from("trades")
          .update({
            symbol: effectiveParsed.symbol,
            entry_price: parsed.entry_price ?? parsed.entry_zone_low ?? existing.entry_price ?? null,
            sl: hasParsedSl ? Number(effectiveParsed.sl) : existing.sl,
            tp: tpOpen ? null : (levels.length ? levels[levels.length - 1] : existing.tp),
            tp_levels: levels.length ? levels : existing.tp_levels ?? null,
            tp_open: tpOpen,
            tp_step_policy: { tp1_close_fraction: 0.25, tp2_close_fraction: 0.5, runner_to_tp3: true },
            next_tp_index: 1,
            status: "modified",
          })
          .eq("id", existing.id)
        return { ok: true, trade_id: existing.id }
      }
      const sent = await orderSendWithFallback(accountId, effectiveParsed, lotSize, pipTolerance, signalId)
      const result = sent.result
      const normalized = normalizeProviderResult(result)
      const orderTicket = normalized.ticket
      const ticketAsNum = Number(orderTicket)
      const hasValidTicket = orderTicket != null && Number.isFinite(ticketAsNum) && ticketAsNum > 0
      if (!hasValidTicket) {
        const reason =
          `OrderSend returned no valid ticket. code=${normalized.code ?? "null"} state=${normalized.state ?? "null"} message=${normalized.message ?? "null"}`
        await logFail(reason, result)
        return { ok: false, error: reason }
      }
      await logOk(result, { volume_executed: sent.volumeUsed })
      const entryFromProvider = extractOpenPriceFromOrderResult(result)
      const tpMeta = deriveTpExecutionMeta(effectiveParsed)
      const finalTp = tpMeta.tpOpen ? null : (tpMeta.tpLevels.length ? tpMeta.tpLevels[tpMeta.tpLevels.length - 1] : null)
      const { data: tradeRow } = await supabase
        .from("trades")
        .insert({
          user_id: signal.user_id,
          signal_id: signalId,
          telegram_channel_id: signal.channel_id,
          broker_account_id: brokerAccount.id,
          metaapi_order_id: orderTicket,
          symbol: effectiveParsed.symbol,
          direction: effectiveParsed.action,
          entry_price: effectiveParsed.entry_price ?? effectiveParsed.entry_zone_low ?? entryFromProvider ?? null,
          sl: effectiveParsed.sl,
          tp: finalTp,
          tp_levels: tpMeta.tpLevels,
          tp_open: tpMeta.tpOpen,
          tp_step_policy: { tp1_close_fraction: 0.25, tp2_close_fraction: 0.5, runner_to_tp3: true },
          next_tp_index: 1,
          lot_size: sent.volumeUsed,
          status: "open",
          opened_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      return { ok: true, trade_id: tradeRow?.id ?? null }
    }

    const symForMatch = effectiveSymbolForManagementMatch(effectiveParsed.symbol)
    const resolvedMg = await resolveOpenTradeForManagement(
      supabase,
      signal.user_id,
      brokerAccount.id,
      effectiveParsed.symbol,
      signal.channel_id,
      signal.parent_signal_id ?? null,
    )
    if (resolvedMg?.kind === "blocked") {
      await logFail(resolvedMg.reason)
      return { ok: false, error: resolvedMg.reason }
    }
    if (resolvedMg?.kind !== "resolved" || !resolvedMg.trade.metaapi_order_id) {
      const msg = symForMatch
        ? `No matching open trade for management action (${symForMatch}) — no open Copier position on this broker`
        : "No matching open trade for management action — no open Copier position on this broker for this channel"
      await logFail(msg)
      return { ok: false, error: msg }
    }
    const trade = resolvedMg.trade
    const ticket = String(trade.metaapi_order_id)

    ;(requestPayload as Record<string, unknown>).management_correlation = {
      resolution: resolvedMg.resolution,
      effective_symbol: trade.symbol,
      parsed_symbol: effectiveParsed.symbol ?? null,
      symbol_used_for_match: symForMatch ?? null,
      telegram_channel_id: signal.channel_id ?? null,
      parent_signal_id: signal.parent_signal_id ?? null,
    }

    if (effectiveParsed.action === "close") {
      const result = await mtOrderClose(accountId, ticket)
      await logOk(result)
      await supabase
        .from("trades")
        .update({
          status: "closed",
          closed_at: new Date().toISOString(),
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    if (effectiveParsed.action === "breakeven") {
      let entry = trade.entry_price != null ? Number(trade.entry_price) : null
      if (entry == null || !Number.isFinite(entry)) {
        entry = await fetchOpenPriceForPositionTicket(accountId, String(ticket))
      }
      if (entry == null || !Number.isFinite(entry)) {
        const msg =
          "Breakeven needs the position open price (not found on trade record or broker positions list — check ticket sync)"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const newSl = entry
      const tpLevels = getTpLevels(effectiveParsed, trade)
      const tpOpen = /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run)\b/i.test(String(effectiveParsed.raw_instruction ?? "")) || trade.tp_open === true
      const tpForMt = tpOpen ? 0 : finalTpFromLevels(tpLevels)
      const result = await mtOrderModify(accountId, ticket, newSl, tpForMt)
      await logOk(result)
      const needsEntryBackfill = trade.entry_price == null || !Number.isFinite(Number(trade.entry_price))
      await supabase
        .from("trades")
        .update({
          ...(needsEntryBackfill ? { entry_price: entry } : {}),
          sl: newSl,
          tp: tpOpen ? null : (tpLevels.length ? tpLevels[tpLevels.length - 1] : trade.tp),
          tp_levels: tpLevels.length ? tpLevels : trade.tp_levels ?? null,
          tp_open: tpOpen,
          status: "modified",
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    if (effectiveParsed.action === "partial_profit") {
      const currentLot = Number(trade.lot_size)
      if (!Number.isFinite(currentLot) || currentLot <= 0.02) {
        const msg = "Position too small or invalid for partial close"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const stage = detectTpHitStage(String(effectiveParsed.raw_instruction ?? ""))
      const explicitFrac = effectiveParsed.partial_close_fraction
      let frac: number
      if (explicitFrac != null && Number.isFinite(Number(explicitFrac)) && Number(explicitFrac) > 0 && Number(explicitFrac) <= 1) {
        frac = Number(explicitFrac)
      } else {
        frac = stage === 1 ? 0.25 : 0.5
      }
      const partialVol = await snapPartialCloseLots(accountId, trade.symbol, currentLot, frac)
      if (!partialVol || partialVol <= 0) {
        const msg = "Position too small or volume grid prevents partial close at requested fraction"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const result = await mtOrderClose(accountId, ticket, partialVol)
      await logOk(result, {
        partial_volume: partialVol,
        tp_stage: stage ?? null,
        partial_fraction: frac,
        partial_close_fraction: effectiveParsed.partial_close_fraction ?? null,
      })
      const remainder = Math.max(0, currentLot - partialVol)
      const closed = remainder < 0.02
      await supabase
        .from("trades")
        .update({
          lot_size: closed ? 0 : remainder,
          status: closed ? "closed" : "open",
          closed_at: closed ? new Date().toISOString() : null,
          next_tp_index: stage ? Math.min(stage + 1, 3) : trade.next_tp_index ?? 1,
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    if (effectiveParsed.action === "partial_breakeven") {
      const currentLot = Number(trade.lot_size)
      if (!Number.isFinite(currentLot) || currentLot <= 0.02) {
        const msg = "Position too small or invalid for partial close"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const partialVol = await snapPartialCloseLots(accountId, trade.symbol, currentLot, 0.5)
      if (!partialVol || partialVol <= 0) {
        const msg = "Position too small or volume grid prevents partial close at requested fraction"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const closeResult = await mtOrderClose(accountId, ticket, partialVol)
      await logOk(closeResult, { partial_volume: partialVol, step: "partial_close" })
      const remainder = Math.max(0, currentLot - partialVol)
      const fullyClosed = remainder < 0.02
      if (fullyClosed) {
        await supabase
          .from("trades")
          .update({
            lot_size: 0,
            status: "closed",
            closed_at: new Date().toISOString(),
          })
          .eq("id", trade.id)
        return { ok: true, trade_id: trade.id }
      }

      let entry = trade.entry_price != null ? Number(trade.entry_price) : null
      if (entry == null || !Number.isFinite(entry)) {
        entry = await fetchOpenPriceForPositionTicket(accountId, String(ticket))
      }
      if (entry == null || !Number.isFinite(entry)) {
        const msg =
          "Partial close succeeded; breakeven needs the position open price (not found on trade record or broker positions list)"
        await logFail(msg)
        await supabase
          .from("trades")
          .update({
            lot_size: remainder,
            status: "open",
          })
          .eq("id", trade.id)
        return { ok: false, error: msg }
      }
      const newSl = entry
      const tpLevels = getTpLevels(effectiveParsed, trade)
      const tpOpen = /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run)\b/i.test(String(effectiveParsed.raw_instruction ?? "")) || trade.tp_open === true
      const tpForMt = tpOpen ? 0 : finalTpFromLevels(tpLevels)
      const modifyResult = await mtOrderModify(accountId, ticket, newSl, tpForMt)
      await logOk(modifyResult, { step: "breakeven_after_partial" })
      const needsEntryBackfill = trade.entry_price == null || !Number.isFinite(Number(trade.entry_price))
      await supabase
        .from("trades")
        .update({
          ...(needsEntryBackfill ? { entry_price: entry } : {}),
          lot_size: remainder,
          sl: newSl,
          tp: tpOpen ? null : (tpLevels.length ? tpLevels[tpLevels.length - 1] : trade.tp),
          tp_levels: tpLevels.length ? tpLevels : trade.tp_levels ?? null,
          tp_open: tpOpen,
          status: "modified",
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    if (effectiveParsed.action === "modify") {
      const hasParsedSl = effectiveParsed.sl != null && Number.isFinite(Number(effectiveParsed.sl))
      const tpLevelsMsg = Array.isArray(effectiveParsed.tp) && effectiveParsed.tp.length
        ? effectiveParsed.tp.map((x) => Number(x)).filter((n) => Number.isFinite(n))
        : []
      const tpOpenMsg = /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run)\b/i.test(
        String(effectiveParsed.raw_instruction ?? ""),
      )
      const hasParsedTp = tpOpenMsg || tpLevelsMsg.length > 0
      if (!hasParsedSl && !hasParsedTp && trade.sl == null && trade.tp == null) {
        const msg = "Modify requires SL and/or TP in signal or on trade record"
        await logFail(msg)
        return { ok: false, error: msg }
      }

      let stoploss: number | undefined
      if (hasParsedSl) stoploss = Number(effectiveParsed.sl)
      else if (trade.sl != null && Number.isFinite(Number(trade.sl))) stoploss = Number(trade.sl)

      let takeprofit: number | undefined
      if (hasParsedTp) {
        takeprofit = tpOpenMsg ? 0 : finalTpFromLevels(tpLevelsMsg)
      } else {
        if (trade.tp != null && Number.isFinite(Number(trade.tp))) takeprofit = Number(trade.tp)
        else if (Array.isArray(trade.tp_levels) && trade.tp_levels.length) {
          const lv = trade.tp_levels.map((x) => Number(x)).filter((n) => Number.isFinite(n))
          if (lv.length) takeprofit = finalTpFromLevels(lv)
        }
      }

      if (stoploss === undefined && takeprofit === undefined) {
        const msg = "Modify has no SL/TP values to send to the broker (check parsed price and trade record)"
        await logFail(msg)
        return { ok: false, error: msg }
      }

      const result = await mtOrderModify(accountId, ticket, stoploss, takeprofit)
      await logOk(result, {
        modify_stoploss: stoploss ?? null,
        modify_takeprofit: takeprofit ?? null,
        modify_has_parsed_sl: hasParsedSl,
        modify_has_parsed_tp: hasParsedTp,
      })

      const nextSl = hasParsedSl ? Number(effectiveParsed.sl) : trade.sl
      const nextTp = hasParsedTp ? (tpOpenMsg ? null : finalTpFromLevels(tpLevelsMsg)) : trade.tp
      const nextTpLevels = hasParsedTp
        ? (tpLevelsMsg.length ? tpLevelsMsg : (tpOpenMsg ? null : trade.tp_levels ?? null))
        : trade.tp_levels ?? null
      const nextTpOpen = hasParsedTp ? tpOpenMsg : trade.tp_open ?? false

      await supabase
        .from("trades")
        .update({
          sl: nextSl,
          tp: nextTp,
          tp_levels: nextTpLevels,
          tp_open: nextTpOpen,
          status: "modified",
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    const msg = `Unsupported action: ${effectiveParsed.action}`
    await logFail(msg)
    return { ok: false, error: msg }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await logExecution(supabase, {
      user_id: signal.user_id,
      signal_id: signalId,
      broker_account_id: brokerAccount.id,
      action: effectiveParsed.action,
      status: "failed",
      request_payload: requestPayload,
      error_message: message,
    })
    return { ok: false, error: message }
  }
}

/** With verify_jwt=false on this function: require service role secret (new keys use apikey header, not Bearer). */
function authorizeExecuteCaller(req: Request): boolean {
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!svc) return false
  const apikey = req.headers.get("apikey") ?? ""
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^\s*Bearer\s+/i, "").trim()
  return apikey === svc || bearer === svc
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  if (!authorizeExecuteCaller(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
  }

  try {
    if (!METATRADERAPI_KEY) {
      return Response.json({ error: "METATRADERAPI_KEY is not configured" }, { status: 503, headers: corsHeaders })
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const body = await req.json() as {
      signal_id: string
      parsed: ParsedSignal & { parent_signal_id?: string | null }
      parent_signal_id?: string | null
    }
    const { signal_id, parsed: rawParsed } = body
    const parentFromBody = typeof body.parent_signal_id === "string" ? body.parent_signal_id : null
    const parentFromParsed = typeof rawParsed.parent_signal_id === "string"
      ? rawParsed.parent_signal_id
      : null
    const { parent_signal_id: _stripParent, ...parsedFields } = rawParsed as ParsedSignal & {
      parent_signal_id?: string | null
    }
    const parsed = parsedFields as ParsedSignal
    // #region agent log
    fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H4',location:'supabase/functions/execute-trade/index.ts:103',message:'execute-trade invoked',data:{hasSignalId:!!signal_id,action:parsed?.action ?? null,hasSymbol:!!parsed?.symbol},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (!signal_id || !parsed) {
      return Response.json({ error: "signal_id and parsed required" }, { status: 400, headers: corsHeaders })
    }

    // Defensive: clients may omit tp[] or vary action casing before calling this function directly.
    parsed.action = String(parsed.action ?? "ignore").trim().toLowerCase()
    if (!Array.isArray(parsed.tp)) parsed.tp = []

    // Load signal to get user_id
    const { data: signal } = await supabase
      .from("signals")
      .select("user_id, channel_id, is_modification, parent_signal_id")
      .eq("id", signal_id)
      .single()

    if (!signal) {
      return Response.json({ error: "Signal not found" }, { status: 404, headers: corsHeaders })
    }

    const channelId = signal.channel_id as string | null
    const effectiveParentSignalId =
      parentFromBody ?? parentFromParsed ?? (signal.parent_signal_id as string | null) ?? null

    const { data: brokerRows } = await supabase
      .from("broker_accounts")
      .select("*")
      .eq("user_id", signal.user_id)
      .eq("is_active", true)

    const eligible = (brokerRows ?? []).filter((b) =>
      brokerEligibleForSignal(b as BrokerRow, channelId)
    ) as BrokerRow[]

    if (!eligible.length) {
      const skipDetail =
        `[signal channel_id=${channelId ?? "null"}] No active broker is allowed to copy this channel. ` +
        "Open Account & configuration: either clear Telegram channel restrictions (copy all connected channels) or include this channel in the allowed list."
      await supabase
        .from("signals")
        .update({
          status: "skipped",
          skip_reason: "No active broker account subscribed to this signal channel",
        })
        .eq("id", signal_id)
      await logExecution(supabase, {
        user_id: signal.user_id as string,
        signal_id,
        broker_account_id: null,
        action: parsed.action,
        status: "failed",
        request_payload: {
          reason: "no_eligible_broker",
          channel_id: channelId,
          active_broker_count: (brokerRows ?? []).length,
        },
        error_message: skipDetail,
      })
      return Response.json(
        { skipped: true, reason: "No eligible broker account for this channel", detail: skipDetail },
        { headers: corsHeaders },
      )
    }

    // Option A: execute on every eligible broker (true multi-account copier).
    const results: { broker_account_id: string; ok: boolean; error?: string; trade_id?: string | null }[] = []
    for (const brokerAccount of eligible) {
      const r = await executeOneBroker(
        supabase,
        {
          user_id: signal.user_id as string,
          channel_id: channelId,
          parent_signal_id: effectiveParentSignalId,
        },
        signal_id,
        parsed,
        brokerAccount,
      )
      results.push({
        broker_account_id: brokerAccount.id,
        ok: r.ok,
        error: r.error,
        trade_id: r.trade_id,
      })
    }

    const anyOk = results.some((x) => x.ok)
    const failMsgs = results.filter((x) => !x.ok).map((x) => x.error ?? "unknown").join("; ")

    if (!anyOk) {
      const reason = failMsgs || "All broker executions failed"
      await supabase.from("signals").update({ status: "failed", skip_reason: reason }).eq("id", signal_id)
      return Response.json({ error: reason, results }, { status: 400, headers: corsHeaders })
    }

    await supabase
      .from("signals")
      .update({
        status: "executed",
        skip_reason: results.some((x) => !x.ok)
          ? `Partial: ${results.filter((x) => !x.ok).length} broker(s) failed`
          : null,
      })
      .eq("id", signal_id)

    // #region agent log
    fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run2',hypothesisId:'H9',location:'supabase/functions/execute-trade/index.ts:aggregate',message:'execute-trade brokers done',data:{signalId:signal_id,eligible:eligible.length,anyOk,failCount:results.filter(x=>!x.ok).length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    return Response.json({ executed: true, results }, { headers: corsHeaders })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("execute-trade error:", message)
    // #region agent log
    fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H5',location:'supabase/functions/execute-trade/index.ts:243',message:'execute-trade caught error',data:{error:message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    try {
      const body = await req.clone().json().catch(() => ({})) as { signal_id?: string }
      if (body.signal_id) {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        )
        const { data: s } = await supabase.from("signals").select("user_id").eq("id", body.signal_id).maybeSingle()
        await supabase
          .from("signals")
          .update({ status: "failed", skip_reason: message })
          .eq("id", body.signal_id)
        if (s?.user_id) {
          await logExecution(supabase, {
            user_id: s.user_id as string,
            signal_id: body.signal_id,
            action: "unknown",
            status: "failed",
            error_message: message,
          })
        }
      }
    } catch {
      // no-op
    }
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
