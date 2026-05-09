import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const METATRADERAPI_BASE_URL = (Deno.env.get("METATRADERAPI_BASE_URL") ?? "https://api.metatraderapi.dev").replace(/\/$/, "")
const METATRADERAPI_KEY = Deno.env.get("METATRADERAPI_KEY") ?? ""

type TradeStatus = "open" | "closed"

interface BrokerTrade {
  id: string
  broker_account_id: string
  symbol: string
  direction: string
  entry_price: number | null
  sl: number | null
  tp: number | null
  lot_size: number | null
  profit: number | null
  status: TradeStatus
  opened_at: string | null
}

function toNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeLotSize(rawVolume: unknown): number | null {
  const volume = toNum(rawVolume)
  if (volume == null) return null

  // Some providers return volume in scaled integer units.
  // Example observed: 20000000 should be 0.2 lots.
  if (volume >= 100000) {
    return volume / 100000000
  }

  // Some history endpoints return cent/micro-lot integer units.
  // Example: 20000 -> 0.2 lots.
  if (volume >= 10000) {
    return volume / 100000
  }

  return volume
}

function extractRawVolume(row: Record<string, unknown>): unknown {
  const candidates: unknown[] = [
    row.lotSize,
    row.lot_size,
    row.size,
    row.volumeLots,
    row.VolumeLots,
    row.volume,
    row.Volume,
    row.lot,
    row.lots,
    row.closedVolume,
    row.closed_volume,
    row.volumeClosed,
    row.initialVolume,
    row.currentVolume,
    row.requestedVolume,
    row.qty,
  ]
  // Prefer non-zero values first; many closed endpoints set one volume key to 0
  // and another key to the executed lot size.
  for (const c of candidates) {
    const n = toNum(c)
    if (n != null && n > 0) return n
  }
  // Fallback to any numeric value (including 0) if no positive value exists.
  for (const c of candidates) {
    const n = toNum(c)
    if (n != null) return n
  }
  return null
}

function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>
    if (Array.isArray(p.data)) return p.data
    if (Array.isArray(p.result)) return p.result
    if (Array.isArray(p.items)) return p.items
    if (Array.isArray(p.orders)) return p.orders
    if (Array.isArray(p.positions)) return p.positions
    if (Array.isArray(p.deals)) return p.deals
    if (Array.isArray(p.trades)) return p.trades
    if (Array.isArray(p.history)) return p.history
    if (Array.isArray(p.historyOrders)) return p.historyOrders
    if (Array.isArray(p.historyDeals)) return p.historyDeals
  }
  return []
}

/**
 * MT4 OP_* / MT5 ORDER_TYPE_*: even 0–6 are buy-side, odd 1–7 are sell-side (incl. limits & stops).
 * Avoid Number(true)→1 falsely mapping to sell; reject booleans.
 */
function mtCmdToBuySell(raw: unknown): "buy" | "sell" | null {
  if (typeof raw === "boolean") return null
  if (raw === 0 || raw === "0") return "buy"
  if (raw === 1 || raw === "1") return "sell"
  const n = typeof raw === "number"
    ? raw
    : (typeof raw === "string" && raw.trim() !== "" && /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN)
  if (!Number.isInteger(n)) return null
  if (n >= 0 && n <= 7) return n % 2 === 0 ? "buy" : "sell"
  return null
}

function normalizeDirection(row: Record<string, unknown>): string {
  const fromCmd =
    mtCmdToBuySell(row.cmd) ??
    mtCmdToBuySell(row.command) ??
    mtCmdToBuySell(row.positionType ?? row.PositionType) ??
    mtCmdToBuySell(row.dealType ?? row.DealType) ??
    mtCmdToBuySell(row.entryType ?? row.EntryType)

  if (fromCmd) return fromCmd

  // Prefer explicit text fields before generic "type" — some payloads put a numeric ORDER_TYPE under `type`,
  // which we already mapped above via mtCmdToBuySell if present on `cmd`; also try `type` as number:
  const fromNumericType = mtCmdToBuySell(row.type ?? row.orderType ?? row.OrderType)
  if (fromNumericType) return fromNumericType

  const op = String(row.operation ?? row.side ?? row.type ?? "").toLowerCase()
  // Check "buy"/"long" before "sell"/"short" so mixed strings behave sensibly.
  if (/\bbuy\b/.test(op) || /\blong\b/.test(op)) return "buy"
  if (/\bsell\b/.test(op) || /\bshort\b/.test(op)) return "sell"
  if (op && op !== "—") return op || "—"
  return "—"
}

function toTrade(row: unknown, brokerAccountId: string, status: TradeStatus): BrokerTrade | null {
  if (!row || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  const id = String(
    r.id ??
    r.orderId ??
    r.positionId ??
    r.dealId ??
    r.historyOrderId ??
    r.ticket ??
    r.tiket ??
    ""
  )
  const symbol = String(
    r.symbol ??
    r.Symbol ??
    r.symbolName ??
    r.instrument ??
    r.market ??
    r.pair ??
    ""
  )
  if (!id || !symbol) return null
  return {
    id: `${brokerAccountId}:${id}:${status}`,
    broker_account_id: brokerAccountId,
    symbol,
    direction: normalizeDirection(r),
    entry_price: toNum(
      r.entryPrice ??
      r.openPrice ??
      r.priceOpen ??
      r.open_price ??
      r.price ??
      r.EntryPrice
    ),
    sl: toNum(r.sl ?? r.stopLoss ?? r.StopLoss),
    tp: toNum(r.tp ?? r.takeProfit ?? r.TakeProfit),
    lot_size: normalizeLotSize(extractRawVolume(r)),
    profit: toNum(r.profit ?? r.Profit ?? r.pnl ?? r.PnL ?? r.realizedPnl),
    status,
    opened_at: String(
      r.openTime ??
      r.open_time ??
      r.openDate ??
      r.closeTime ??
      r.close_time ??
      r.closeDate ??
      r.time ??
      r.date ??
      r.openedAt ??
      ""
    ) || null,
  }
}

async function fetchJson(path: string): Promise<{ ok: boolean; payload: unknown }> {
  const res = await fetch(`${METATRADERAPI_BASE_URL}${path}`, {
    method: "GET",
    headers: { "x-api-key": METATRADERAPI_KEY },
  })
  const raw = await res.text()
  let payload: unknown = null
  try { payload = JSON.parse(raw) } catch { payload = raw }
  return { ok: res.ok, payload }
}

async function loadOpenTrades(accountId: string, brokerAccountId: string): Promise<BrokerTrade[]> {
  const paths = [
    `/OpenedOrders?id=${encodeURIComponent(accountId)}`,
    `/OpenOrders?id=${encodeURIComponent(accountId)}`,
    `/OpenPositions?id=${encodeURIComponent(accountId)}`,
    `/Positions?id=${encodeURIComponent(accountId)}`,
  ]
  for (const path of paths) {
    const res = await fetchJson(path)
    if (!res.ok) continue
    const trades = asArray(res.payload)
      .map(row => toTrade(row, brokerAccountId, "open"))
      .filter((t): t is BrokerTrade => !!t)
    if (trades.length > 0) return trades
  }
  return []
}

async function loadClosedTrades(accountId: string, brokerAccountId: string): Promise<BrokerTrade[]> {
  const from = encodeURIComponent("2024-01-01T00:00:00")
  const paths = [
    `/OrderHistory?id=${encodeURIComponent(accountId)}&from=${from}`,
    `/TradeHistory?id=${encodeURIComponent(accountId)}&from=${from}`,
    `/HistoryOrders?id=${encodeURIComponent(accountId)}&from=${from}`,
    `/HistoryDeals?id=${encodeURIComponent(accountId)}&from=${from}`,
    `/ClosedOrders?id=${encodeURIComponent(accountId)}&from=${from}`,
  ]
  for (const path of paths) {
    const res = await fetchJson(path)
    if (!res.ok) continue
    const trades = asArray(res.payload)
      .map(row => toTrade(row, brokerAccountId, "closed"))
      .filter((t): t is BrokerTrade => !!t)
    if (trades.length > 0) return trades
  }
  return []
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    }
    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    }
    if (!METATRADERAPI_KEY) {
      return Response.json({ error: "METATRADERAPI_KEY is not configured" }, { status: 503, headers: corsHeaders })
    }

    const body = await req.json().catch(() => ({})) as { filter?: "all" | "open" | "closed" }
    const filter = body.filter ?? "all"

    const { data: accounts, error: accErr } = await supabase
      .from("broker_accounts")
      .select("id, metaapi_account_id, is_active")
      .eq("user_id", user.id)
      .eq("is_active", true)
    if (accErr) {
      return Response.json({ error: accErr.message }, { status: 500, headers: corsHeaders })
    }

    const all: BrokerTrade[] = []
    for (const acc of accounts ?? []) {
      const accountId = String(acc.metaapi_account_id ?? "")
      if (!accountId) continue
      if (filter === "all" || filter === "open") {
        all.push(...await loadOpenTrades(accountId, acc.id))
      }
      if (filter === "all" || filter === "closed") {
        all.push(...await loadClosedTrades(accountId, acc.id))
      }
    }

    all.sort((a, b) => (b.opened_at ?? "").localeCompare(a.opened_at ?? ""))
    return Response.json({ trades: all.slice(0, 200) }, { headers: corsHeaders })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("metatrader-trades error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
