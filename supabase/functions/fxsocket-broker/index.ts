import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { searchBrokerCompanies } from "../_shared/fxsocketBsaClient.ts"
import {
  FxsocketApiError,
  isFxsocketConfigured,
  makeFxsocketClientFromEnv,
  type FxsocketAccountSummary,
} from "../_shared/fxsocketClient.ts"
import {
  PERFORMANCE_BASELINE_HISTORY_DAYS,
  resolvePerformanceBaselineBalance,
} from "../_shared/performanceBaseline.ts"
import { fetchFxsocketBrokerTrades, fetchClosedHistoryForBaseline, BROKER_FULL_HISTORY_FROM_DATE } from "../_shared/fxsocketTrades.ts"
import type { MtHistoryProfile } from "../_shared/mtTradeFields.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

function ensureFxsocketConfigured(): void {
  if (!isFxsocketConfigured(Deno.env)) {
    throw new FxsocketApiError(
      "FxSocket is not configured. Set FXSOCKET_API_KEY in Supabase Edge secrets.",
      503,
    )
  }
}

function summaryToRowPatch(summary: FxsocketAccountSummary) {
  return {
    last_balance: summary.balance ?? null,
    last_equity: summary.equity ?? null,
    last_currency: summary.currency ?? null,
    last_synced_at: new Date().toISOString(),
  }
}

/** WebSocket URL for worker stream proxy (token appended by client). */
function buildWorkerStreamWsUrl(brokerAccountId: string): string {
  const raw = (Deno.env.get("WORKER_PUBLIC_URL") ?? "").trim().replace(/\/+$/, "")
  if (!raw) {
    throw new FxsocketApiError(
      "WORKER_PUBLIC_URL is not configured on the server.",
      503,
    )
  }
  const httpBase = raw.startsWith("http") ? raw : `https://${raw}`
  const u = new URL(httpBase)
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
  u.pathname = "/broker/stream"
  u.search = new URLSearchParams({ broker_account_id: brokerAccountId }).toString()
  return u.toString()
}

async function loadOwnedBrokerRow(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  rowId: string,
) {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", rowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new FxsocketApiError("Broker account not found", 404)
  const fxsocketId = String(data.fxsocket_account_id ?? "").trim()
  if (!fxsocketId) throw new FxsocketApiError("Broker has no FxSocket account linked", 400)
  return data
}

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
    const action = String(body.action ?? "")
    if (!action) return bad(400, "action required")

    if (action === "list") {
      const { data, error } = await supabase
        .from("broker_accounts")
        .select("*")
        .eq("user_id", userId)
        .neq("fxsocket_account_id", "")
        .order("created_at", { ascending: false })
      if (error) return bad(500, error.message)
      return Response.json({ ok: true, accounts: data ?? [] }, { headers: corsHeaders })
    }

    if (action === "search_brokers") {
      ensureFxsocketConfigured()
      const company = String(body.company ?? "").trim()
      const platform = String(body.platform ?? "MT5").trim()
      const companies = await searchBrokerCompanies(Deno.env, {
        company,
        code: platform.toUpperCase() === "MT4" ? "mt4" : "mt5",
      })
      return Response.json({ ok: true, companies }, { headers: corsHeaders })
    }

    ensureFxsocketConfigured()
    const fx = makeFxsocketClientFromEnv(Deno.env)

    if (action === "connect") {
      const login = String(body.login ?? "").trim()
      const password = String(body.password ?? "")
      const server = String(body.server ?? "").trim()
      const label = String(body.label ?? "").trim()
      const existingUuid = String(body.fxsocket_account_id ?? "").trim()
      const linkingExisting = /^[0-9a-f-]{36}$/i.test(existingUuid)

      if (!linkingExisting) {
        if (!server) return bad(400, "server required")
        if (!login) return bad(400, "login required")
        if (!password) return bad(400, "password required")
      }

      const displayLabel = label
        || (login ? `MT5 • ${login}` : linkingExisting ? `MT5 • ${existingUuid.slice(0, 8)}` : "MT5")

      const { data: dup } = await supabase
        .from("broker_accounts")
        .select("id,label")
        .eq("user_id", userId)
        .eq("account_login", login || null)
        .eq("broker_server", server || null)
        .maybeSingle()
      if (dup && login) {
        return bad(409, `This MT login is already linked as "${dup.label}". Delete it first to reconnect.`)
      }

      if (linkingExisting) {
        const { data: dupUuid } = await supabase
          .from("broker_accounts")
          .select("id,label")
          .eq("user_id", userId)
          .eq("fxsocket_account_id", existingUuid)
          .maybeSingle()
        if (dupUuid) {
          return bad(409, `This FxSocket account UUID is already linked as "${dupUuid.label}".`)
        }
      }

      let accountId = linkingExisting ? existingUuid : ""
      if (!accountId) {
        try {
          const connected = await fx.connectAccount({ login, password, server, label: displayLabel })
          accountId = connected.accountId
        } catch (e) {
          const msg = e instanceof FxsocketApiError ? e.message : e instanceof Error ? e.message : "Connect failed"
          return bad(e instanceof FxsocketApiError ? e.status : 502, msg)
        }
      }

      const insertBase: Record<string, unknown> = {
        user_id: userId,
        label: displayLabel,
        platform: "MT5",
        metaapi_account_id: "",
        fxsocket_account_id: accountId,
        account_login: login || null,
        broker_server: server || null,
        fxsocket_status: "connecting",
        connection_status: "pending",
        connection_error: null,
        is_active: true,
        default_lot_size: 0.01,
        pip_tolerance: 5,
        max_trades_per_zone: 3,
      }

      const { data: row, error: insErr } = await supabase
        .from("broker_accounts")
        .insert(insertBase)
        .select("*")
        .single()

      if (insErr) {
        if (!linkingExisting) {
          try { await fx.deleteAccount(accountId) } catch { /* swallow */ }
        }
        return bad(500, insErr.message)
      }

      // Return immediately — MT5 terminal spin-up can take minutes. Client polls refresh_summary.
      return Response.json(
        { ok: true, account: row, pending: true },
        { headers: corsHeaders },
      )
    }

    if (action === "delete") {
      const accountRowId = String(body.account_id ?? body.broker_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      if (row.fxsocket_account_id) {
        try { await fx.deleteAccount(row.fxsocket_account_id) } catch { /* swallow */ }
      }
      const { error } = await supabase
        .from("broker_accounts")
        .delete()
        .eq("id", accountRowId)
        .eq("user_id", userId)
      if (error) return bad(500, error.message)
      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    if (action === "refresh_summary") {
      const accountRowId = String(body.account_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      try {
        const readiness = await fx.resolveLinkReadiness(row.fxsocket_account_id)

        if (readiness.ready) {
          let baselinePatch: Record<string, number> = {}
          const formatMtDt = (d: Date) => d.toISOString().slice(0, 19)
          const historyTo = formatMtDt(new Date())
          const historyFromDate = new Date()
          historyFromDate.setDate(historyFromDate.getDate() - PERFORMANCE_BASELINE_HISTORY_DAYS)
          let tradesForBaseline: Awaited<ReturnType<typeof fetchFxsocketBrokerTrades>> = []
          try {
            tradesForBaseline = await fetchClosedHistoryForBaseline(fx, {
              id: row.id,
              label: row.label,
              broker_name: row.broker_name ?? null,
              fxsocket_account_id: row.fxsocket_account_id,
            }, {
              historyFrom: formatMtDt(historyFromDate),
              historyTo,
              historyProfile: "trades",
            })
          } catch (e) {
            console.warn("[fxsocket-broker] baseline history fetch failed:", e)
          }
          const baseline = resolvePerformanceBaselineBalance(
            row.performance_baseline_balance,
            readiness.summary,
            tradesForBaseline,
          )
          if (baseline != null) {
            baselinePatch = { performance_baseline_balance: baseline }
          }

          const { data: updated, error } = await supabase
            .from("broker_accounts")
            .update({
              fxsocket_status: "connected",
              connection_status: "connected",
              connection_error: null,
              ...summaryToRowPatch(readiness.summary),
              ...baselinePatch,
            })
            .eq("id", accountRowId)
            .eq("user_id", userId)
            .select("*")
            .single()
          if (error) return bad(500, error.message)
          return Response.json(
            { ok: true, account: updated, summary: readiness.summary },
            { headers: corsHeaders },
          )
        }

        if (readiness.pending) {
          const { data: updated, error } = await supabase
            .from("broker_accounts")
            .update({
              fxsocket_status: "connecting",
              connection_status: "pending",
              connection_error: null,
            })
            .eq("id", accountRowId)
            .eq("user_id", userId)
            .select("*")
            .single()
          if (error) return bad(500, error.message)
          return Response.json(
            { ok: true, account: updated ?? row, pending: true },
            { headers: corsHeaders },
          )
        }

        const msg = readiness.error || "FxSocket terminal connection failed"
        await supabase
          .from("broker_accounts")
          .update({
            fxsocket_status: "error",
            connection_status: "error",
            connection_error: msg,
          })
          .eq("id", accountRowId)
          .eq("user_id", userId)
        return bad(502, msg)
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Refresh failed"
        await supabase
          .from("broker_accounts")
          .update({
            fxsocket_status: "error",
            connection_status: "error",
            connection_error: msg,
          })
          .eq("id", accountRowId)
          .eq("user_id", userId)
        return bad(502, msg)
      }
    }

    if (action === "opened_orders") {
      const accountRowId = String(body.account_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const orders = await fx.openedOrders(row.fxsocket_account_id)
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    if (action === "order_history") {
      const accountRowId = String(body.account_id ?? "")
      const historyFrom = String(body.history_from ?? "").trim()
      const historyTo = String(body.history_to ?? "").trim()
      if (!accountRowId || !historyFrom || !historyTo) {
        return bad(400, "account_id, history_from, and history_to required")
      }
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const orders = await fx.orderHistory(row.fxsocket_account_id, historyFrom, historyTo)
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    if (action === "position_history") {
      const accountRowId = String(body.account_id ?? "")
      const historyFrom = String(body.history_from ?? "").trim()
      const historyTo = String(body.history_to ?? "").trim()
      if (!accountRowId || !historyFrom || !historyTo) {
        return bad(400, "account_id, history_from, and history_to required")
      }
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const positions = await fx.positionHistory(row.fxsocket_account_id, historyFrom, historyTo)
      return Response.json({ ok: true, positions }, { headers: corsHeaders })
    }

    if (action === "quote") {
      const accountRowId = String(body.account_id ?? "")
      const symbol = String(body.symbol ?? "EURUSD").trim()
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const quote = await fx.getQuote(row.fxsocket_account_id, symbol)
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "symbols") {
      const accountRowId = String(body.account_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const symbols = await fx.symbols(row.fxsocket_account_id)
      return Response.json({ ok: true, symbols }, { headers: corsHeaders })
    }

    if (action === "symbol_info") {
      const accountRowId = String(body.account_id ?? "")
      const symbol = String(body.symbol ?? "").trim()
      if (!accountRowId) return bad(400, "account_id required")
      if (!symbol) return bad(400, "symbol required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const info = await fx.symbolInfo(row.fxsocket_account_id, symbol)
      return Response.json({ ok: true, symbol_info: info }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const accountRowId = String(body.account_id ?? body.broker_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const summary = await fx.accountSummary(row.fxsocket_account_id)
      return Response.json({ ok: true, summary }, { headers: corsHeaders })
    }

    if (action === "stream_ticket") {
      const accountRowId = String(body.account_id ?? body.broker_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const ws_url = buildWorkerStreamWsUrl(accountRowId)
      return Response.json({ ok: true, ws_url }, { headers: corsHeaders })
    }

    if (action === "trades") {
      const brokerId = String(body.broker_id ?? "").trim()
      const scope = String(body.scope ?? "all").toLowerCase()
      const formatMtDt = (d: Date) => d.toISOString().slice(0, 19)
      const historyTo = typeof body.history_to === "string" && body.history_to.trim()
        ? String(body.history_to).trim()
        : formatMtDt(new Date())
      const defaultHistoryFrom = new Date()
      defaultHistoryFrom.setDate(defaultHistoryFrom.getDate() - 90)
      const historyProfile: MtHistoryProfile =
        body.history_profile === "trades" ? "trades" : "dashboard"
      const historyFrom = typeof body.history_from === "string" && body.history_from.trim()
        ? String(body.history_from).trim()
        : historyProfile === "trades"
          ? BROKER_FULL_HISTORY_FROM_DATE
          : formatMtDt(defaultHistoryFrom)
      const limitRaw = Number(body.limit ?? 0)
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.floor(limitRaw)
          : 0

      let brokers: Array<{ id: string; label: string; broker_name: string | null; fxsocket_account_id: string }> = []
      if (brokerId) {
        const row = await loadOwnedBrokerRow(supabase, userId, brokerId)
        brokers = [{
          id: row.id,
          label: row.label,
          broker_name: row.broker_name ?? null,
          fxsocket_account_id: row.fxsocket_account_id,
        }]
      } else {
        const { data } = await supabase
          .from("broker_accounts")
          .select("id,label,broker_name,fxsocket_account_id")
          .eq("user_id", userId)
          .eq("is_active", true)
          .neq("fxsocket_account_id", "")
        brokers = (data ?? []) as typeof brokers
      }

      const tradesByBroker = await Promise.all(
        brokers.map(b => fetchFxsocketBrokerTrades(fx, b, {
          scope,
          historyFrom,
          historyTo,
          historyProfile,
          limit,
        })),
      )
      const trades = tradesByBroker.flat()
      return Response.json({ ok: true, trades }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (e) {
    if (e instanceof FxsocketApiError) return bad(e.status, e.message)
    const msg = e instanceof Error ? e.message : "Internal error"
    console.error("[fxsocket-broker]", msg)
    return bad(500, msg)
  }
})
