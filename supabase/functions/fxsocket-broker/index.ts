import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { searchBrokerDirectory } from "../_shared/fxsocketBsaClient.ts"
import {
  classifyBrokerConnectError,
  friendlyBrokerConnectError,
  isDefinitiveCredentialError,
} from "../_shared/brokerConnectError.ts"
import {
  FxsocketApiError,
  isFxsocketConfigured,
  makeFxsocketClientFromEnv,
  type FxsocketAccountSummary,
  type FxsocketMtStatus,
} from "../_shared/fxsocketClient.ts"
import {
  isFxsocketMtStatusHealthy,
  terminalHealthRowPatchFromMtStatus,
} from "../_shared/fxsocketMtStatus.ts"
import {
  resolvePerformanceBaselineBalance,
} from "../_shared/performanceBaseline.ts"
import { fetchFxsocketBrokerTrades, BROKER_FULL_HISTORY_FROM_DATE } from "../_shared/fxsocketTrades.ts"
import type { MtHistoryProfile } from "../_shared/mtTradeFields.ts"
import {
  assertBrokerAccountLimit,
  loadUserSubscription,
} from "../_shared/subscriptionAccess.ts"
import { effectiveAccountSummaryBalance } from "../_shared/effectiveBrokerBalance.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function isApiThrottleMessage(message: string | null | undefined): boolean {
  return /throttl|rate limit|too many requests|expected available in/i.test(String(message ?? ""))
}

function parseThrottleBackoffMs(message: string | null | undefined): number {
  const m = String(message ?? "").match(/expected available in\s+(\d+)\s*seconds?/i)
  const sec = m ? Number(m[1]) : NaN
  if (Number.isFinite(sec) && sec > 0) return Math.min(120_000, Math.max(2_000, sec * 1000 + 500))
  return 8_000
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
    last_balance: effectiveAccountSummaryBalance(summary),
    last_equity: summary.equity ?? null,
    last_currency: summary.currency ?? null,
    last_synced_at: new Date().toISOString(),
  }
}

function terminalHealthRowPatch(status: FxsocketMtStatus) {
  return terminalHealthRowPatchFromMtStatus(status)
}

async function fetchTerminalHealthPatch(
  fx: ReturnType<typeof makeFxsocketClientFromEnv>,
  fxsocketAccountId: string,
  platform: string,
): Promise<Record<string, boolean | null>> {
  try {
    const status = await fx.mtStatus(fxsocketAccountId, platform)
    return terminalHealthRowPatch(status)
  } catch {
    return { terminal_connected: false, trade_allowed: false }
  }
}

async function persistBrokerMtStatus(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  accountRowId: string,
  status: FxsocketMtStatus,
) {
  const healthy = isFxsocketMtStatusHealthy(status)
  const { data: updated, error } = await supabase
    .from("broker_accounts")
    .update(terminalHealthRowPatch(status))
    .eq("id", accountRowId)
    .eq("user_id", userId)
    .select("*")
    .single()
  if (error) throw new Error(error.message)
  return { healthy, account: updated }
}

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

function brokerApiPlatform(row: { platform?: string | null }): string {
  return row.platform === "MT4" ? "MT4" : "MT5"
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
      const query = String(body.company ?? body.query ?? "").trim()
      if (query.length < 4) {
        return Response.json({ ok: true, companies: [] }, { headers: corsHeaders })
      }
      const platformRaw = String(body.platform ?? "MT5").trim().toUpperCase()
      const platform = platformRaw === "MT4" ? "MT4" : "MT5"
      const companies = await searchBrokerDirectory(Deno.env, { query, platform })
      return Response.json({ ok: true, companies }, { headers: corsHeaders })
    }

    ensureFxsocketConfigured()
    const fx = makeFxsocketClientFromEnv(Deno.env)

    if (action === "connect") {
      const sub = await loadUserSubscription(supabase, userId)
      const limitDenied = await assertBrokerAccountLimit(supabase, userId, sub)
      if (limitDenied) {
        const payload = await limitDenied.json().catch(() => ({ error: "Broker account limit reached" })) as {
          error?: string
        }
        return bad(limitDenied.status, payload.error ?? "Broker account limit reached")
      }

      const login = String(body.login ?? "").trim()
      const password = String(body.password ?? "")
      const server = String(body.server ?? "").trim()
      const label = String(body.label ?? "").trim()
      const platformRaw = String(body.platform ?? "MT5").trim().toUpperCase()
      const platform = platformRaw === "MT4" ? "MT4" : "MT5"
      const existingUuid = String(body.fxsocket_account_id ?? "").trim()
      const linkingExisting = /^[0-9a-f-]{36}$/i.test(existingUuid)

      if (!linkingExisting) {
        if (!server) return bad(400, "server required")
        if (!login) return bad(400, "login required")
        if (!password) return bad(400, "password required")
      }

      const displayLabel = label
        || (login ? `${platform} • ${login}` : linkingExisting ? `${platform} • ${existingUuid.slice(0, 8)}` : platform)

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
          const connected = await fx.connectAccount({
            login,
            password,
            server,
            label: displayLabel,
            platform,
          })
          accountId = connected.accountId
        } catch (e) {
          const msg = e instanceof FxsocketApiError ? e.message : e instanceof Error ? e.message : "Connect failed"
          return bad(e instanceof FxsocketApiError ? e.status : 502, msg)
        }
      }

      const insertBase: Record<string, unknown> = {
        user_id: userId,
        label: displayLabel,
        platform,
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
        const msg = insErr.message
        if (/broker_account_limit|subscription_required/i.test(msg)) {
          const cleaned = msg.includes(": ") ? msg.slice(msg.indexOf(": ") + 2) : msg
          return bad(403, cleaned)
        }
        return bad(500, msg)
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

    // Password re-link on the same broker_accounts row (preserves trading config).
    if (action === "reconnect") {
      const accountRowId = String(body.account_id ?? body.broker_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const password = String(body.password ?? "")
      if (!password) return bad(400, "password required")

      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const login = String(row.account_login ?? "").trim()
      const server = String(body.server ?? row.broker_server ?? "").trim()
      if (!login) return bad(400, "Broker login is missing — delete and connect again.")
      if (!server) return bad(400, "Broker server is missing — delete and connect again.")

      const platform = brokerApiPlatform(row)
      const oldUuid = String(row.fxsocket_account_id ?? "").trim()
      const displayLabel = String(row.label ?? "").trim() || `${platform} • ${login}`

      let newAccountId = ""
      try {
        const connected = await fx.connectAccount({
          login,
          password,
          server,
          label: displayLabel,
          platform,
        })
        newAccountId = connected.accountId
      } catch (e) {
        const rawMsg = e instanceof FxsocketApiError ? e.message : e instanceof Error ? e.message : "Reconnect failed"
        const kind = classifyBrokerConnectError(rawMsg, { credentialConnect: true })
        const msg = friendlyBrokerConnectError(rawMsg, { credentialConnect: true })
        await supabase
          .from("broker_accounts")
          .update({
            fxsocket_status: "error",
            connection_status: "error",
            connection_error: msg,
            connection_error_kind: kind,
            connection_error_message: rawMsg,
          })
          .eq("id", accountRowId)
          .eq("user_id", userId)
        return bad(e instanceof FxsocketApiError ? e.status : 502, msg)
      }

      if (oldUuid && oldUuid !== newAccountId) {
        try { await fx.deleteAccount(oldUuid) } catch { /* swallow */ }
      }

      const { data: updated, error: updErr } = await supabase
        .from("broker_accounts")
        .update({
          fxsocket_account_id: newAccountId,
          broker_server: server,
          fxsocket_status: "connecting",
          connection_status: "pending",
          connection_error: null,
          connection_error_kind: null,
          connection_error_message: null,
          terminal_connected: false,
          trade_allowed: false,
        })
        .eq("id", accountRowId)
        .eq("user_id", userId)
        .select("*")
        .single()

      if (updErr) {
        try { await fx.deleteAccount(newAccountId) } catch { /* swallow */ }
        return bad(500, updErr.message)
      }

      return Response.json(
        { ok: true, account: updated, pending: true },
        { headers: corsHeaders },
      )
    }

    if (action === "refresh_summary") {
      const accountRowId = String(body.account_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)

      const respondPending = async () => {
        const { data: updated, error } = await supabase
          .from("broker_accounts")
          .update({
            fxsocket_status: "connecting",
            connection_status: "pending",
            connection_error: null,
            connection_error_kind: null,
            connection_error_message: null,
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
      // While establishing (incl. recovering a stuck `error` row), only definitive
      // credential failures flip the account to a hard error — everything else stays
      // pending so polling / background sync can recover.
      const establishing = ["pending", "connecting", "error"].includes(row.connection_status)

      try {
        const readiness = await fx.resolveLinkReadiness(row.fxsocket_account_id)

        if (readiness.ready) {
          let baselinePatch: Record<string, number | string> = {}
          const baseline = resolvePerformanceBaselineBalance(
            row.performance_baseline_balance,
            readiness.summary,
          )
          if (baseline != null) {
            baselinePatch = {
              performance_baseline_balance: baseline,
              performance_baseline_captured_at: new Date().toISOString(),
            }
          }

          const terminalPatch = await fetchTerminalHealthPatch(
            fx,
            row.fxsocket_account_id,
            brokerApiPlatform(row),
          )

          const { data: updated, error } = await supabase
            .from("broker_accounts")
            .update({
              fxsocket_status: "connected",
              connection_status: "connected",
              connection_error: null,
              connection_error_kind: null,
              connection_error_message: null,
              ...summaryToRowPatch(readiness.summary),
              ...baselinePatch,
              ...terminalPatch,
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
          return await respondPending()
        }

        const rawMsg = readiness.error || "FxSocket terminal connection failed"
        if (isApiThrottleMessage(rawMsg) || classifyBrokerConnectError(rawMsg) === "rate_limited") {
          return Response.json(
            {
              ok: true,
              account: row,
              throttled: true,
              retry_after_ms: parseThrottleBackoffMs(rawMsg),
            },
            { headers: corsHeaders },
          )
        }
        const readinessKind = classifyBrokerConnectError(rawMsg, { credentialConnect: establishing })
        if (establishing && !isDefinitiveCredentialError(readinessKind)) {
          return await respondPending()
        }
        const msg = friendlyBrokerConnectError(rawMsg, { credentialConnect: establishing })
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
        const rawMsg = e instanceof Error ? e.message : "Refresh failed"
        if (isApiThrottleMessage(rawMsg) || classifyBrokerConnectError(rawMsg) === "rate_limited") {
          return Response.json(
            {
              ok: true,
              account: row,
              throttled: true,
              retry_after_ms: parseThrottleBackoffMs(rawMsg),
            },
            { headers: corsHeaders },
          )
        }
        const errorKind = classifyBrokerConnectError(rawMsg, { credentialConnect: establishing })
        if (establishing && !isDefinitiveCredentialError(errorKind)) {
          return await respondPending()
        }
        const msg = friendlyBrokerConnectError(rawMsg, { credentialConnect: establishing })
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

    if (action === "broker_status" || action === "check_status") {
      const accountRowId = String(body.account_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      try {
        const status = await fx.mtStatus(row.fxsocket_account_id, brokerApiPlatform(row))
        const { healthy, account } = await persistBrokerMtStatus(supabase, userId, accountRowId, status)
        return Response.json(
          { ok: true, healthy, status, account },
          { headers: corsHeaders },
        )
      } catch (e) {
        const msg = e instanceof FxsocketApiError ? e.message : e instanceof Error ? e.message : "Status check failed"
        if (isApiThrottleMessage(msg)) {
          return Response.json(
            {
              ok: true,
              healthy: row.terminal_connected === true && row.trade_allowed !== false,
              account: row,
              throttled: true,
              retry_after_ms: parseThrottleBackoffMs(msg),
            },
            { headers: corsHeaders },
          )
        }
        await supabase
          .from("broker_accounts")
          .update({ terminal_connected: false, trade_allowed: false })
          .eq("id", accountRowId)
          .eq("user_id", userId)
        return bad(e instanceof FxsocketApiError ? e.status : 502, msg)
      }
    }

    if (action === "opened_orders") {
      const accountRowId = String(body.account_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const orders = await fx.openedOrders(row.fxsocket_account_id, brokerApiPlatform(row))
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
      const orders = await fx.orderHistory(row.fxsocket_account_id, historyFrom, historyTo, brokerApiPlatform(row))
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
      const positions = await fx.positionHistory(row.fxsocket_account_id, historyFrom, historyTo, brokerApiPlatform(row))
      return Response.json({ ok: true, positions }, { headers: corsHeaders })
    }

    if (action === "quote") {
      const accountRowId = String(body.account_id ?? "")
      const symbol = String(body.symbol ?? "EURUSD").trim()
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const quote = await fx.getQuote(row.fxsocket_account_id, symbol, brokerApiPlatform(row))
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "symbols") {
      const accountRowId = String(body.account_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const symbols = await fx.symbols(row.fxsocket_account_id, brokerApiPlatform(row))
      return Response.json({ ok: true, symbols }, { headers: corsHeaders })
    }

    if (action === "symbol_info") {
      const accountRowId = String(body.account_id ?? "")
      const symbol = String(body.symbol ?? "").trim()
      if (!accountRowId) return bad(400, "account_id required")
      if (!symbol) return bad(400, "symbol required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const info = await fx.symbolInfo(row.fxsocket_account_id, symbol, brokerApiPlatform(row))
      return Response.json({ ok: true, symbol_info: info }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const accountRowId = String(body.account_id ?? body.broker_id ?? "")
      if (!accountRowId) return bad(400, "account_id required")
      const row = await loadOwnedBrokerRow(supabase, userId, accountRowId)
      const summary = await fx.accountSummary(row.fxsocket_account_id, brokerApiPlatform(row))

      if (body.check_terminal !== true) {
        return Response.json({ ok: true, summary }, { headers: corsHeaders })
      }

      try {
        const status = await fx.mtStatus(row.fxsocket_account_id, brokerApiPlatform(row))
        const { healthy, account } = await persistBrokerMtStatus(supabase, userId, accountRowId, status)
        return Response.json(
          { ok: true, summary, status, healthy, account },
          { headers: corsHeaders },
        )
      } catch (e) {
        const msg = e instanceof FxsocketApiError ? e.message : e instanceof Error ? e.message : "Status check failed"
        const { data: updated, error } = await supabase
          .from("broker_accounts")
          .update({ terminal_connected: false, trade_allowed: false })
          .eq("id", accountRowId)
          .eq("user_id", userId)
          .select("*")
          .single()
        if (error) return bad(500, error.message)
        return Response.json(
          { ok: true, summary, healthy: false, account: updated, error: msg },
          { headers: corsHeaders },
        )
      }
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
      const includeBalanceCashFlow = body.include_balance_cashflow !== false

      let brokers: Array<{
        id: string
        label: string
        broker_name: string | null
        fxsocket_account_id: string
        platform?: string | null
      }> = []
      if (brokerId) {
        const row = await loadOwnedBrokerRow(supabase, userId, brokerId)
        brokers = [{
          id: row.id,
          label: row.label,
          broker_name: row.broker_name ?? null,
          fxsocket_account_id: row.fxsocket_account_id,
          platform: row.platform,
        }]
      } else {
        const { data } = await supabase
          .from("broker_accounts")
          .select("id,label,broker_name,fxsocket_account_id,platform")
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
          includeBalanceCashFlow,
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
