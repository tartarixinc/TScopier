import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const METATRADERAPI_KEY = Deno.env.get("METATRADERAPI_KEY") ?? ""
const METATRADERAPI_BASE = (Deno.env.get("METATRADERAPI_BASE_URL") ?? "https://api.metatraderapi.dev").replace(/\/$/, "")

export interface ParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[]
  lot_size: number | null
  confidence: number
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
  ai_settings?: unknown
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

function brokerEligibleForSignal(broker: Pick<BrokerRow, "signal_channel_ids">, channelId: string | null): boolean {
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
} {
  const j = (raw && typeof raw === "object") ? raw as JsonRecord : {}
  return {
    risk_percent_per_trade: Math.min(10, Math.max(0.05, Number(j.risk_percent_per_trade ?? 1) || 1)),
    min_lot: Math.max(0.001, Number(j.min_lot ?? 0.01) || 0.01),
    max_lot: Math.min(100, Math.max(0.01, Number(j.max_lot ?? 5) || 5)),
    reference_equity: Math.max(100, Number(j.reference_equity ?? 10000) || 10000),
    fallback_lot: j.fallback_lot != null && Number.isFinite(Number(j.fallback_lot)) ? Number(j.fallback_lot) : null,
  }
}

function clampLot(n: number, min: number, max: number): number {
  if (!Number.isFinite(n) || n <= 0) return min
  return Math.min(max, Math.max(min, n))
}

async function fetchAccountBalance(accountId: string): Promise<number | null> {
  const from = "2024-01-01T00:00:00"
  const paths: [string, Record<string, QueryValue>][] = [
    ["/AccountSummary", { id: accountId }],
    ["/Account", { id: accountId }],
    ["/TradeStats", { id: accountId, from }],
  ]
  for (const [path, params] of paths) {
    try {
      const raw = await mtGet(path, params)
      if (!raw || typeof raw !== "object") continue
      const p = raw as Record<string, unknown>
      const summary = (p.summary && typeof p.summary === "object") ? p.summary as Record<string, unknown> : {}
      const bal = Number(p.balance ?? p.Balance ?? summary.balance ?? summary.Balance)
      if (Number.isFinite(bal) && bal >= 0) return bal
    } catch {
      // try next
    }
  }
  return null
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

  if (mode === "manual") {
    lotSize = clampLot(defaultLot, ai.min_lot, ai.max_lot)
    if (brokerLotFloor != null && lotSize < brokerLotFloor) lotSize = brokerLotFloor
    lotSize = clampLot(lotSize, ai.min_lot, ai.max_lot)
    return { lotSize, pipTolerance, sizingLog: { source: "manual_mode", default_lot: defaultLot, broker_min_lot_floor: brokerLotFloor } }
  }

  const balance = metaId ? await fetchAccountBalance(metaId) : null
  /** AI default: stake `risk_percent_per_trade`% of equity per trade (`ai_settings`, default 1%). */
  const riskUsd = balance != null && balance > 0 ? balance * (ai.risk_percent_per_trade / 100) : null

  // Baseline lots: normalize 1%-of-equity notionally against reference_equity (default $10k ⇒ default_lot ~= target at that size).
  const refRiskUsd = Math.max(ai.reference_equity * 0.01, 1)
  let lot =
    riskUsd != null && riskUsd > 0 ? defaultLot * (riskUsd / refRiskUsd) : clampLot(defaultLot, ai.min_lot, ai.max_lot)
  lot = clampLot(lot, ai.min_lot, ai.max_lot)

  const entry = parsed.entry_price ?? parsed.entry_zone_low ?? parsed.entry_zone_high
  const sl = parsed.sl
  const refPx = Math.max(
    entry != null && Number.isFinite(Number(entry)) ? Math.abs(Number(entry)) : 0,
    sl != null && Number.isFinite(Number(sl)) ? Math.abs(Number(sl)) : 0,
  )
  // SL-distance refinement: same risk USD budget vs distance (forex-style); skip huge quotes (BTC, etc.).
  const useSlDistanceRisk = refPx > 0 && refPx < 5000
  if (
    balance != null && balance > 0 && riskUsd != null && riskUsd > 0 &&
    entry != null && sl != null && useSlDistanceRisk &&
    Number.isFinite(entry) && Number.isFinite(sl)
  ) {
    const dist = Math.abs(Number(entry) - Number(sl))
    if (dist > 1e-8) {
      const heuristicLots = riskUsd / (dist * 80)
      lot = clampLot(heuristicLots, ai.min_lot, ai.max_lot)
    }
  }

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
      source: "ai_money_management",
      balance_snapshot: balance,
      risk_usd_budget: riskUsd,
      broker_min_lot_floor: brokerLotFloor,
      reference_equity: ai.reference_equity,
      risk_percent_per_trade: ai.risk_percent_per_trade,
      min_lot: ai.min_lot,
      max_lot: ai.max_lot,
    },
  }
}

type OpenTradeRow = {
  id: string
  metaapi_order_id: string | null
  symbol: string
  direction: string
  entry_price: number | null
  lot_size: number
  sl: number | null
  tp: number | null
}

async function loadOpenTradeRows(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  direction: string | null,
): Promise<OpenTradeRow[]> {
  let query = supabase
    .from("trades")
    .select("id, metaapi_order_id, symbol, direction, entry_price, lot_size, sl, tp, opened_at")
    .eq("user_id", userId)
    .eq("broker_account_id", brokerAccountId)
    .eq("status", "open")

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

/**
 * CLOSE/modify/etc.: match by symbol first; if parser picked wrong instrument, use sole open ticket when unambiguous.
 */
async function resolveOpenTradeForManagement(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  brokerAccountId: string,
  parsedSymbol: string | null,
): Promise<{ trade: OpenTradeRow; resolution: string } | null> {
  const rows = await loadOpenTradeRows(supabase, userId, brokerAccountId, null)
  if (!rows.length) return null

  const bySymbol = pickTradeByParsedSymbol(rows, parsedSymbol)
  if (bySymbol) return { trade: bySymbol, resolution: "symbol_match" }

  if (rows.length === 1) {
    return { trade: rows[0], resolution: "single_open_position_fallback" }
  }

  return null
}

async function mtOrderModify(
  accountId: string,
  ticket: string | number,
  stoploss: number,
  takeprofit: number,
): Promise<unknown> {
  return await mtGetAny(
    ["/OrderModify", "/OrdersModify"],
    { id: accountId, ticket, stoploss, takeprofit },
  )
}

async function mtOrderClose(
  accountId: string,
  ticket: string | number,
  volume?: number,
): Promise<unknown> {
  const params: Record<string, QueryValue> = {
    id: accountId,
    ticket,
  }
  if (volume != null && Number.isFinite(volume) && volume > 0) {
    params.volume = volume
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
    takeprofit: parsed.tp?.[0] ?? 0,
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
  signal: { user_id: string; channel_id: string | null },
  signalId: string,
  parsed: ParsedSignal,
  brokerAccount: BrokerRow,
): Promise<{ ok: boolean; error?: string; trade_id?: string | null }> {
  const accountId = String(brokerAccount.metaapi_account_id ?? "")
  if (!accountId) {
    return { ok: false, error: "Missing MetaAPI account id" }
  }

  const { lotSize, pipTolerance, sizingLog } = await resolveLotAndPips(
    supabase,
    brokerAccount,
    { channel_id: signal.channel_id },
    parsed,
  )
  const requestPayload: Record<string, unknown> = {
    signal_id: signalId,
    parsed,
    account_id: accountId,
    broker_account_id: brokerAccount.id,
    sizing: sizingLog,
  }

  await logExecution(supabase, {
    user_id: signal.user_id,
    signal_id: signalId,
    broker_account_id: brokerAccount.id,
    action: parsed.action,
    status: "attempt",
    request_payload: requestPayload,
  })

  const logFail = async (msg: string, response?: unknown) => {
    await logExecution(supabase, {
      user_id: signal.user_id,
      signal_id: signalId,
      broker_account_id: brokerAccount.id,
      action: parsed.action,
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
      action: parsed.action,
      status: "success",
      request_payload: extra ? { ...requestPayload, ...extra } : requestPayload,
      response_payload: response,
    })
  }

  try {
    if (parsed.action === "buy" || parsed.action === "sell") {
      if (!parsed.symbol) {
        await logFail("No symbol detected")
        return { ok: false, error: "No symbol detected" }
      }
      const sent = await orderSendWithFallback(accountId, parsed, lotSize, pipTolerance, signalId)
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
      const { data: tradeRow } = await supabase
        .from("trades")
        .insert({
          user_id: signal.user_id,
          signal_id: signalId,
          broker_account_id: brokerAccount.id,
          metaapi_order_id: orderTicket,
          symbol: parsed.symbol,
          direction: parsed.action,
          entry_price: parsed.entry_price ?? parsed.entry_zone_low ?? null,
          sl: parsed.sl,
          tp: parsed.tp?.[0] ?? null,
          lot_size: sent.volumeUsed,
          status: "open",
          opened_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      return { ok: true, trade_id: tradeRow?.id ?? null }
    }

    // Management actions: correlate to an open position (symbol match → else single-open fallback).
    const resolvedMg = await resolveOpenTradeForManagement(
      supabase,
      signal.user_id,
      brokerAccount.id,
      parsed.symbol,
    )
    if (!resolvedMg?.trade?.metaapi_order_id) {
      const msg = parsed.symbol?.trim()
        ? `No matching open trade for management action (${parsed.symbol}) — ambiguous or missing position`
        : "No matching open trade for management action (multiple open positions; specify symbol in signal)"
      await logFail(msg)
      return { ok: false, error: msg }
    }
    const trade = resolvedMg.trade
    const ticket = trade.metaapi_order_id

    ;(requestPayload as Record<string, unknown>).management_correlation = {
      resolution: resolvedMg.resolution,
      effective_symbol: trade.symbol,
      parsed_symbol: parsed.symbol ?? null,
    }

    if (parsed.action === "close") {
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

    if (parsed.action === "breakeven") {
      const entry = trade.entry_price != null ? Number(trade.entry_price) : null
      if (entry == null || !Number.isFinite(entry)) {
        const msg = "Breakeven requires entry price on open trade record"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const newSl = entry
      const tpForMt = parsed.tp?.[0] != null ? Number(parsed.tp[0]) : Number(trade.tp ?? 0)
      const result = await mtOrderModify(accountId, ticket, newSl, tpForMt)
      await logOk(result)
      await supabase
        .from("trades")
        .update({
          sl: newSl,
          tp: parsed.tp?.[0] != null ? Number(parsed.tp[0]) : trade.tp,
          status: "modified",
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    if (parsed.action === "partial_profit") {
      const currentLot = Number(trade.lot_size)
      if (!Number.isFinite(currentLot) || currentLot <= 0.02) {
        const msg = "Position too small or invalid for partial close"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const partialVol = Math.min(
        Math.max(0.01, Math.floor((currentLot / 2) * 100) / 100),
        currentLot - 0.01,
      )
      const result = await mtOrderClose(accountId, ticket, partialVol)
      await logOk(result, { partial_volume: partialVol })
      const remainder = Math.max(0, currentLot - partialVol)
      const closed = remainder < 0.02
      await supabase
        .from("trades")
        .update({
          lot_size: closed ? 0 : remainder,
          status: closed ? "closed" : "open",
          closed_at: closed ? new Date().toISOString() : null,
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    if (parsed.action === "modify") {
      const hasParsedSl = parsed.sl != null && Number.isFinite(Number(parsed.sl))
      const hasParsedTp = parsed.tp?.length && parsed.tp[0] != null && Number.isFinite(Number(parsed.tp[0]))
      if (!hasParsedSl && !hasParsedTp && trade.sl == null && trade.tp == null) {
        const msg = "Modify requires SL and/or TP in signal or on trade record"
        await logFail(msg)
        return { ok: false, error: msg }
      }
      const newSl = hasParsedSl ? Number(parsed.sl) : Number(trade.sl ?? 0)
      const newTp = hasParsedTp ? Number(parsed.tp![0]) : Number(trade.tp ?? 0)
      const result = await mtOrderModify(accountId, ticket, newSl, newTp)
      await logOk(result)
      await supabase
        .from("trades")
        .update({
          sl: hasParsedSl ? newSl : trade.sl,
          tp: hasParsedTp ? newTp : trade.tp,
          status: "modified",
        })
        .eq("id", trade.id)
      return { ok: true, trade_id: trade.id }
    }

    const msg = `Unsupported action: ${parsed.action}`
    await logFail(msg)
    return { ok: false, error: msg }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await logExecution(supabase, {
      user_id: signal.user_id,
      signal_id: signalId,
      broker_account_id: brokerAccount.id,
      action: parsed.action,
      status: "failed",
      request_payload: requestPayload,
      error_message: message,
    })
    return { ok: false, error: message }
  }
}

export function isMetatraderConfigured(): boolean {
  return Boolean(METATRADERAPI_KEY)
}

/** Core trade pipeline (also invoked from parse-signal to avoid a second Edge Function cold start). */
export async function runExecuteTradeFromPayload(payload: {
  signal_id: string
  parsed: ParsedSignal
}): Promise<Response> {
  try {
    if (!METATRADERAPI_KEY) {
      return Response.json({ error: "METATRADERAPI_KEY is not configured" }, { status: 503, headers: corsHeaders })
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const { signal_id, parsed } = payload
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

    const { data: brokerRows } = await supabase
      .from("broker_accounts")
      .select("*")
      .eq("user_id", signal.user_id)
      .eq("is_active", true)

    const eligible = (brokerRows ?? []).filter((b) =>
      brokerEligibleForSignal(b as BrokerRow, channelId)
    ) as BrokerRow[]

    if (!eligible.length) {
      await supabase
        .from("signals")
        .update({
          status: "skipped",
          skip_reason: "No active broker account subscribed to this signal channel",
        })
        .eq("id", signal_id)
      return Response.json(
        { skipped: true, reason: "No eligible broker account for this channel" },
        { headers: corsHeaders },
      )
    }

    // Option A: execute on every eligible broker (true multi-account copier).
    const results: { broker_account_id: string; ok: boolean; error?: string; trade_id?: string | null }[] = []
    for (const brokerAccount of eligible) {
      const r = await executeOneBroker(
        supabase,
        { user_id: signal.user_id as string, channel_id: channelId },
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
      if (payload.signal_id) {
        const sb = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        )
        const { data: s } = await sb.from("signals").select("user_id").eq("id", payload.signal_id).maybeSingle()
        await sb
          .from("signals")
          .update({ status: "failed", skip_reason: message })
          .eq("id", payload.signal_id)
        if (s?.user_id) {
          await logExecution(sb, {
            user_id: s.user_id as string,
            signal_id: payload.signal_id,
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
}
