import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { inferBrokerLabel } from "../_shared/brokerLabel.ts"
import {
  isMtApiAuthConfigured,
  makeClientFromEnv,
  MetatraderApiError,
  type MtPlatform,
} from "../_shared/metatraderapi.ts"

function mtClient(env: { get(name: string): string | undefined }, platform: string): ReturnType<typeof makeClientFromEnv> {
  const p: MtPlatform = platform === "MT4" ? "MT4" : "MT5"
  return makeClientFromEnv(env, p)
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const PLATFORMS = new Set(["MT4", "MT5"])

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

function ensureMtApiConfigured(env: { get(name: string): string | undefined }): void {
  if (!isMtApiAuthConfigured(env)) {
    throw new MetatraderApiError(
      "MT API is not configured on the server. Set MT4API_BASIC_USER + MT4API_BASIC_PASSWORD (plain text from support) in Supabase Edge secrets, then redeploy broker-metatrader.",
      503,
    )
  }
}

/** Turn mt4api.dev HTTP statuses into actionable UI copy. */
function friendlyMtApiError(e: MetatraderApiError): MetatraderApiError {
  const raw = e.message.trim()
  if (e.status === 401 || /^unauthorized$/i.test(raw)) {
    return new MetatraderApiError(
      "MT API rejected the request (missing or invalid Basic Auth). Set MT4API_BASIC_USER and MT4API_BASIC_PASSWORD in Supabase Edge secrets — these are your mt4api.dev API credentials, not your MT5 login.",
      e.status,
      e.code,
    )
  }
  if (e.status === 403 || /^forbidden$/i.test(raw)) {
    return new MetatraderApiError(
      "MT API rejected the API credentials (Forbidden). Check MT4API_BASIC_USER and MT4API_BASIC_PASSWORD in Supabase Edge secrets match what mt4api.dev support gave you. Do not use your MT5 account login here, and do not use the old METATRADERAPI_KEY.",
      e.status,
      e.code,
    )
  }
  return e
}

/**
 * Account lifecycle for MetatraderAPI. Trade execution is NOT here — it lives in the
 * worker process for minimum latency. This function only runs for the rare UI-driven
 * register / delete / refresh balance / check connection calls, plus the trades read
 * for the Trades page.
 */
const BUILD_TAG = "broker-metatrader@trades-order-history-v1"
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""
    if (!token) return bad(401, "Unauthorized")
    const { data: authData, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !authData.user) return bad(401, "Unauthorized")
    const userId = authData.user.id

    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const action = String((body as Record<string, unknown>).action ?? "")
    if (!action) return bad(400, "action required")

    if (action === "register") {
      ensureMtApiConfigured(Deno.env)
      const platform = String((body as Record<string, unknown>).platform ?? "MT5").toUpperCase()
      if (!PLATFORMS.has(platform)) return bad(400, "platform must be MT4 or MT5")
      const client = mtClient(Deno.env, platform)
      const server = String((body as Record<string, unknown>).server ?? "").trim()
      const login = String((body as Record<string, unknown>).login ?? "").trim()
      const password = String((body as Record<string, unknown>).password ?? "")
      const label = String((body as Record<string, unknown>).label ?? "").trim()
      const channelIds = Array.isArray((body as Record<string, unknown>).signal_channel_ids)
        ? ((body as Record<string, unknown>).signal_channel_ids as unknown[]).map(String)
        : []

      if (!server) return bad(400, "server required")
      if (!login) return bad(400, "login required")
      if (!password) return bad(400, "password required")

      const brokerName = inferBrokerLabel(server)
      const displayLabel = label || `${platform} • ${login}`
      const sessionId = crypto.randomUUID()
      const uuid = await client.connectEx({
        id: sessionId,
        server,
        login,
        password,
      })
      if (!uuid) return bad(502, "MetatraderAPI did not return a session id")

      // After ConnectEx the session needs a moment to authenticate
      // before /AccountSummary returns real numbers. CheckConnect both
      // waits for the connection and triggers a reconnect if needed, and
      // we retry the summary a few times with backoff in case the first
      // call lands before the broker server replies with account state.
      let summary: Awaited<ReturnType<typeof client.accountSummary>> | null = null
      try { await client.checkConnect(uuid) } catch { /* swallow */ }
      for (let i = 0; i < 5; i++) {
        try {
          const s = await client.accountSummary(uuid)
          if (s && (s.balance != null || s.equity != null || s.currency)) {
            summary = s
            break
          }
        } catch { /* swallow and retry */ }
        await new Promise(r => setTimeout(r, 600 + i * 400))
      }

      const insertPayload = {
        user_id: userId,
        label: displayLabel,
        platform,
        metaapi_account_id: uuid,
        broker_server: server,
        account_login: login,
        broker_name: brokerName,
        connection_status: "connected" as const,
        copier_mode: "manual" as const,
        signal_channel_ids: channelIds,
        enforce_signal_channel_filter: false,
        ai_settings: {},
        manual_settings: {},
        default_lot_size: 0.01,
        pip_tolerance: 20,
        max_trades_per_zone: 1,
        is_active: true,
        last_balance: summary?.balance ?? null,
        last_equity: summary?.equity ?? null,
        last_currency: summary?.currency ?? null,
        last_synced_at: summary ? new Date().toISOString() : null,
        performance_baseline_balance: summary?.balance ?? null,
      }

      const { data: row, error: insErr } = await supabase
        .from("broker_accounts")
        .insert(insertPayload)
        .select("*")
        .single()
      if (insErr) {
        // Roll back the MetatraderAPI side so we don't orphan accounts.
        try { await client.deleteAccount(uuid) } catch { /* swallow */ }
        return bad(500, insErr.message)
      }

      // Make sure the server we just used is remembered for the typeahead next time.
      try {
        await supabase
          .from("mt_servers")
          .upsert(
            {
              server_name: server,
              platform,
              source: "learned",
              broker_label: brokerName || null,
              is_active: true,
            },
            { onConflict: "server_name_normalized" },
          )
      } catch { /* non-fatal */ }

      return Response.json({ ok: true, broker: row, summary }, { headers: corsHeaders })
    }

    if (action === "delete") {
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")

      const { data: broker } = await supabase
        .from("broker_accounts")
        .select("id,user_id,metaapi_account_id,platform")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")

      const uuid = String(broker.metaapi_account_id ?? "").trim()
      if (uuid && !uuid.includes("|")) {
        try {
          await mtClient(Deno.env, String(broker.platform ?? "MT5")).disconnect(uuid)
        } catch { /* swallow — proceed with DB delete */ }
      }

      const { error: delErr } = await supabase
        .from("broker_accounts")
        .delete()
        .eq("id", brokerId)
        .eq("user_id", userId)
      if (delErr) return bad(500, delErr.message)

      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    if (action === "summary") {
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")
      const { data: broker } = await supabase
        .from("broker_accounts")
        .select("id,metaapi_account_id,performance_baseline_balance,platform")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")
      const uuid = String(broker.metaapi_account_id ?? "").trim()
      if (!uuid || uuid.includes("|")) return bad(400, "Broker is not linked to MetatraderAPI yet")
      const client = mtClient(Deno.env, String(broker.platform ?? "MT5"))

      try {
        try { await client.ensureConnected(uuid) } catch { /* swallow */ }
        let summary: Awaited<ReturnType<typeof client.accountSummary>> | null = null
        let lastErr: unknown = null
        for (let i = 0; i < 3; i++) {
          try {
            const s = await client.accountSummary(uuid)
            if (s && (s.balance != null || s.equity != null || s.currency)) {
              summary = s
              break
            }
          } catch (err) { lastErr = err }
          await new Promise(r => setTimeout(r, 400 + i * 400))
        }
        if (!summary) {
          if (lastErr instanceof MetatraderApiError) throw lastErr
          throw new Error("AccountSummary returned no data")
        }
        let openPositions: number | null = null
        try {
          const orders = await client.openedOrders(uuid)
          openPositions = Array.isArray(orders) ? orders.length : 0
        } catch {
          openPositions = null
        }
        const updatePayload: Record<string, unknown> = {
          last_balance: summary?.balance ?? null,
          last_equity: summary?.equity ?? null,
          last_currency: summary?.currency ?? null,
          last_synced_at: new Date().toISOString(),
          connection_status: "connected",
        }
        if (
          broker?.performance_baseline_balance == null &&
          summary?.balance != null &&
          Number.isFinite(summary.balance)
        ) {
          updatePayload.performance_baseline_balance = summary.balance
        }
        const { data: updatedRow, error: updErr } = await supabase
          .from("broker_accounts")
          .update(updatePayload)
          .eq("id", brokerId)
          .eq("user_id", userId)
          .select("performance_baseline_balance")
          .maybeSingle()
        if (updErr) throw new Error(updErr.message)
        return Response.json(
          {
            ok: true,
            summary,
            open_positions: openPositions,
            performance_baseline_balance: updatedRow?.performance_baseline_balance ?? null,
          },
          { headers: corsHeaders },
        )
      } catch (e) {
        await supabase
          .from("broker_accounts")
          .update({ connection_status: "error" })
          .eq("id", brokerId)
          .eq("user_id", userId)
        const status = e instanceof MetatraderApiError ? e.status : 502
        const msg = e instanceof Error ? e.message : "AccountSummary failed"
        return bad(status >= 400 && status < 600 ? status : 502, msg)
      }
    }

    if (action === "check") {
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")
      const { data: broker } = await supabase
        .from("broker_accounts")
        .select("id,metaapi_account_id,platform")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")
      const uuid = String(broker.metaapi_account_id ?? "").trim()
      if (!uuid || uuid.includes("|")) return bad(400, "Broker is not linked to MetatraderAPI yet")
      const client = mtClient(Deno.env, String(broker.platform ?? "MT5"))

      try {
        await client.ensureConnected(uuid)
        const result = await client.checkConnect(uuid)
        await supabase
          .from("broker_accounts")
          .update({ connection_status: "connected" })
          .eq("id", brokerId)
          .eq("user_id", userId)
        return Response.json({ ok: true, result }, { headers: corsHeaders })
      } catch (e) {
        await supabase
          .from("broker_accounts")
          .update({ connection_status: "error" })
          .eq("id", brokerId)
          .eq("user_id", userId)
        const status = e instanceof MetatraderApiError ? e.status : 502
        const msg = e instanceof Error ? e.message : "CheckConnect failed"
        return bad(status >= 400 && status < 600 ? status : 502, msg)
      }
    }

    if (action === "trades") {
      const bodyRec = body as Record<string, unknown>
      const brokerId = String(bodyRec.broker_id ?? "").trim()
      const scope = String(bodyRec.scope ?? "all").toLowerCase()
      const wantOpen = scope === "all" || scope === "open"
      const wantClosed = scope === "all" || scope === "closed"
      const formatMtDt = (d: Date) => d.toISOString().slice(0, 19)
      const historyTo = typeof bodyRec.history_to === "string" && bodyRec.history_to.trim()
        ? String(bodyRec.history_to).trim()
        : formatMtDt(new Date())
      const defaultHistoryFrom = new Date()
      defaultHistoryFrom.setDate(defaultHistoryFrom.getDate() - 90)
      const historyFrom = typeof bodyRec.history_from === "string" && bodyRec.history_from.trim()
        ? String(bodyRec.history_from).trim()
        : formatMtDt(defaultHistoryFrom)
      type RawOrder = Record<string, unknown>
      const unwrapOrders = (raw: unknown): RawOrder[] => {
        if (Array.isArray(raw)) return raw as RawOrder[]
        if (raw && typeof raw === "object") {
          const r = raw as Record<string, unknown>
          if (Array.isArray(r.result)) return r.result as RawOrder[]
          if (Array.isArray(r.Result)) return r.Result as RawOrder[]
        }
        return []
      }

      let brokers: { id: string; label: string; metaapi_account_id: string; broker_name: string | null; platform: string }[] = []
      if (brokerId) {
        const { data } = await supabase
          .from("broker_accounts")
          .select("id,label,metaapi_account_id,broker_name,platform")
          .eq("id", brokerId)
          .eq("user_id", userId)
          .maybeSingle()
        if (!data) return bad(404, "Broker account not found")
        brokers = [data as typeof brokers[number]]
      } else {
        const { data } = await supabase
          .from("broker_accounts")
          .select("id,label,metaapi_account_id,broker_name,platform")
          .eq("user_id", userId)
        brokers = ((data ?? []) as typeof brokers)
      }

      const num = (v: unknown): number | null => {
        if (v === null || v === undefined) return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }

      const pick = (order: RawOrder, ...keys: string[]): unknown => {
        for (const k of keys) {
          if (order[k] !== undefined && order[k] !== null) return order[k]
        }
        return undefined
      }

      // MT order code → direction + label. Used for both MT4-style 'cmd' and MT5 'OrderType' enums.
      // MT4 CMD: 0=BUY, 1=SELL, 2=BUYLIMIT, 3=SELLLIMIT, 4=BUYSTOP, 5=SELLSTOP, 6=BALANCE.
      // MT5 OrderType: 0=BUY, 1=SELL, 2=BUYLIMIT, 3=SELLLIMIT, 4=BUYSTOP, 5=SELLSTOP, 6=BUYSTOPLIMIT, 7=SELLSTOPLIMIT, 8=CLOSEBY.
      const codeMap: Record<number, { direction: "buy" | "sell" | ""; label: string }> = {
        0: { direction: "buy", label: "Buy" },
        1: { direction: "sell", label: "Sell" },
        2: { direction: "buy", label: "Buy Limit" },
        3: { direction: "sell", label: "Sell Limit" },
        4: { direction: "buy", label: "Buy Stop" },
        5: { direction: "sell", label: "Sell Stop" },
        6: { direction: "buy", label: "Buy Stop Limit" },
        7: { direction: "sell", label: "Sell Stop Limit" },
        8: { direction: "", label: "Close By" },
      }

      const fromString = (raw: string): { direction: "buy" | "sell" | ""; label: string } | null => {
        const cleaned = raw.replace(/^(OrderType_|DealType_|DEAL_TYPE_|ORDER_TYPE_)/i, "").trim()
        if (!cleaned) return null
        const lower = cleaned.toLowerCase()
        const direction: "buy" | "sell" | "" =
          lower.startsWith("buy") ? "buy" : lower.startsWith("sell") ? "sell" : ""
        const label = cleaned.replace(/([a-z])([A-Z])/g, "$1 $2")
        return { direction, label }
      }

      const resolveDirection = (order: RawOrder): { direction: "buy" | "sell" | ""; type_label: string } => {
        // Try every known string-typed field name first.
        const stringCandidate = pick(
          order,
          "type", "Type",
          "orderType", "OrderType",
          "dealType", "DealType",
          "cmdString",
        )
        if (typeof stringCandidate === "string" && stringCandidate.trim()) {
          const parsed = fromString(stringCandidate)
          if (parsed) return { direction: parsed.direction, type_label: parsed.label }
        }
        // Then try numeric-typed fields and any nested 'ex.cmd'.
        const ex = order.ex as Record<string, unknown> | undefined
        const numericCandidate = pick(
          order,
          "type", "Type",
          "orderType", "OrderType",
          "dealType", "DealType",
          "cmd", "Cmd",
        )
        const numericFromEx = ex ? pick(ex, "cmd", "Cmd", "OrderType", "orderType") : undefined
        const candidate =
          typeof numericCandidate === "number"
            ? numericCandidate
            : typeof numericFromEx === "number"
              ? numericFromEx
              : undefined
        if (typeof candidate === "number" && codeMap[candidate]) {
          const m = codeMap[candidate]
          return { direction: m.direction, type_label: m.label }
        }
        return { direction: "", type_label: "" }
      }

      const normalize = (
        order: RawOrder,
        broker: typeof brokers[number],
        status: "open" | "closed",
      ) => {
        const ticket = Number(pick(order, "ticket", "Ticket") ?? 0)
        const { direction, type_label } = resolveDirection(order)
        const openTime = pick(order, "openTime", "OpenTime") as string | undefined
        const closeTime = pick(order, "closeTime", "CloseTime") as string | undefined
        return {
          id: `${broker.id}:${ticket}`,
          broker_id: broker.id,
          broker_label: broker.label,
          broker_name: broker.broker_name,
          ticket,
          symbol: String(pick(order, "symbol", "Symbol") ?? ""),
          direction,
          type: type_label,
          lot_size: num(pick(order, "lots", "Lots", "volume", "Volume")) ?? 0,
          entry_price: num(pick(order, "openPrice", "OpenPrice", "price")),
          sl: num(pick(order, "stopLoss", "StopLoss", "sl")),
          tp: num(pick(order, "takeProfit", "TakeProfit", "tp")),
          close_price: num(pick(order, "closePrice", "ClosePrice")),
          profit: num(pick(order, "profit", "Profit")),
          swap: num(pick(order, "swap", "Swap")),
          commission: num(pick(order, "commission", "Commission")),
          comment: (pick(order, "comment", "Comment") as string | undefined) ?? null,
          magic: num(pick(order, "magicNumber", "MagicNumber", "magic", "Magic", "expertId", "ExpertId")),
          opened_at: openTime ?? null,
          closed_at: closeTime ?? null,
          state: (pick(order, "state", "State") as string | undefined) ?? null,
          status,
        }
      }

      let firstRawSample: RawOrder | null = null
      const tradesByBroker = await Promise.all(
        brokers.map(async (b) => {
          const uuid = String(b.metaapi_account_id ?? "").trim()
          if (!uuid || uuid.includes("|")) return [] as ReturnType<typeof normalize>[]
          const bClient = mtClient(Deno.env, String(b.platform ?? "MT5"))
          try { await bClient.ensureConnected(uuid) } catch { /* best-effort */ }
          const [openedRes, closedRes] = await Promise.allSettled([
            wantOpen ? bClient.openedOrders(uuid) : Promise.resolve([] as unknown[]),
            wantClosed
              ? bClient.orderHistory(uuid, historyFrom, historyTo).catch(() => bClient.closedOrders(uuid))
              : Promise.resolve([] as unknown[]),
          ])
          const out: ReturnType<typeof normalize>[] = []
          if (openedRes.status === "fulfilled" && Array.isArray(openedRes.value)) {
            for (const o of openedRes.value as RawOrder[]) {
              if (!firstRawSample) firstRawSample = o
              out.push(normalize(o, b, "open"))
            }
          }
          if (closedRes.status === "fulfilled") {
            const closedRows = unwrapOrders(closedRes.value)
            for (const o of closedRows) {
              if (!firstRawSample) firstRawSample = o
              out.push(normalize(o, b, "closed"))
            }
          }
          return out
        }),
      )
      const trades = tradesByBroker.flat().sort((a, b) => {
        const at = a.status === "closed" ? (a.closed_at ?? a.opened_at) : a.opened_at
        const bt = b.status === "closed" ? (b.closed_at ?? b.opened_at) : b.opened_at
        const av = at ? Date.parse(at) : 0
        const bv = bt ? Date.parse(bt) : 0
        return bv - av
      })
      // When at least one trade is missing direction, echo back the raw shape so the
      // client can show the diagnostic and we can extend the parser if needed.
      const hasMissingDirection = trades.some((t) => !t.direction)
      const debug = hasMissingDirection && firstRawSample
        ? { raw_sample_keys: Object.keys(firstRawSample), raw_sample: firstRawSample }
        : undefined
      return Response.json({ ok: true, trades, debug }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action} (${BUILD_TAG})`)
  } catch (e: unknown) {
    const apiErr = e instanceof MetatraderApiError ? friendlyMtApiError(e) : null
    let msg = apiErr?.message ?? (e instanceof Error ? e.message : "Internal server error")
    if (/invalid dns name/i.test(msg)) {
      msg =
        "Invalid MT API host URL (DNS error). Check Supabase secrets MT4API_MT4_BASE_URL / MT4API_MT5_BASE_URL — use exactly https://mt4.mt4api.dev or https://mt5.mt4api.dev with no trailing slash or parentheses."
    }
    const status = apiErr?.status ?? (e instanceof MetatraderApiError ? e.status : 500)
    return Response.json({ error: msg }, { status: status >= 400 && status < 600 ? status : 500, headers: corsHeaders })
  }
})
