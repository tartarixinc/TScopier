import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { encryptMtPassword, isEncryptionConfigured } from "../_shared/brokerCredentialsCrypto.ts"
import {
  assertBrokerAccountLimit,
  loadUserSubscription,
} from "../_shared/subscriptionAccess.ts"
import {
  isMtapiConfigured,
  MtapiApiError,
  MtapiClient,
  normalizeMtapiAccountSummary,
} from "../_shared/mtapiClient.ts"
import {
  BROKER_FULL_HISTORY_FROM_DATE,
  fetchFxsocketBrokerTrades,
} from "../_shared/fxsocketTrades.ts"
import type { MtHistoryProfile } from "../_shared/mtTradeFields.ts"
import { effectiveAccountSummaryBalance } from "../_shared/effectiveBrokerBalance.ts"
import { resolvePerformanceBaselineBalance } from "../_shared/performanceBaseline.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

function stripSecrets(row: Record<string, unknown>) {
  const { broker_password_encrypted: _pw, mtapi_session_id: _sid, ...safe } = row
  return safe
}

function makeMtapiClient(): MtapiClient {
  if (!isMtapiConfigured(Deno.env)) {
    throw new MtapiApiError(
      "MTAPI is not configured. Set MTAPI_BASE_URL in Supabase Edge secrets.",
      503,
      "NOT_CONFIGURED",
    )
  }
  return new MtapiClient({ env: Deno.env })
}

type SupabaseClient = ReturnType<typeof createClient>

async function loadMtapiBrokerRow(
  supabase: SupabaseClient,
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
  if (!data) return null
  if (data.provider !== "mtapi") return null
  return data
}

function formatMtDt(d: Date): string {
  return d.toISOString().slice(0, 19)
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return bad(401, "Missing authorization")

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  )

  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser()
  if (authError || !user) return bad(401, "Unauthorized")
  const userId = user.id

  // Service-role client for DB writes. The broker_accounts_guard_mtapi_credentials
  // trigger strips broker_password_encrypted / mtapi_session_id / auto_reconnect_enabled
  // for the authenticated and anon roles, so trusted edge code must write as service_role.
  // Every query below is still scoped by user_id.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  )

  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    /* empty body */
  }

  const action = String(body.action ?? "").trim()
  if (!action) return bad(400, "action required")

  try {
    // ── connect ──────────────────────────────────────────────
    if (action === "connect") {
      const sub = await loadUserSubscription(supabase, userId)
      const limitDenied = await assertBrokerAccountLimit(supabase, userId, sub)
      if (limitDenied) {
        const payload = await limitDenied.json().catch(() => ({
          error: "Broker account limit reached",
        })) as { error?: string }
        return bad(limitDenied.status, payload.error ?? "Broker account limit reached")
      }

      const server = String(body.server ?? "").trim()
      const login = String(body.login ?? "").trim()
      const password = String(body.password ?? "").trim()
      const label = String(body.label ?? "").trim()
      const platformRaw = String(body.platform ?? "MT5").trim().toUpperCase()
      const platform = platformRaw === "MT4" ? "MT4" : "MT5"

      if (!server) return bad(400, "server required")
      if (!login) return bad(400, "login required")
      if (!password) return bad(400, "password required")

      const displayLabel = label || `${platform} • ${login}`

      const { data: dup } = await supabase
        .from("broker_accounts")
        .select("id,label")
        .eq("user_id", userId)
        .eq("account_login", login)
        .eq("broker_server", server)
        .maybeSingle()
      if (dup) {
        return bad(409, `This MT login is already linked as "${dup.label}". Delete it first to reconnect.`)
      }

      const encryptedPassword = isEncryptionConfigured(Deno.env)
        ? await encryptMtPassword(password, Deno.env)
        : password

      const insertBase: Record<string, unknown> = {
        user_id: userId,
        label: displayLabel,
        platform,
        provider: "mtapi",
        account_login: login || null,
        broker_server: server || null,
        broker_password_encrypted: encryptedPassword,
        auto_reconnect_enabled: true,
        connection_status: "pending",
        connection_error: null,
        is_active: true,
      }

      const { data: row, error: insErr } = await supabase
        .from("broker_accounts")
        .insert(insertBase)
        .select("*")
        .single()

      if (insErr) {
        const msg = insErr.message
        if (/broker_account_limit|subscription_required/i.test(msg)) {
          const cleaned = msg.includes(": ") ? msg.slice(msg.indexOf(": ") + 2) : msg
          return bad(403, cleaned)
        }
        return bad(500, msg)
      }

      return Response.json(
        { ok: true, account: stripSecrets(row as Record<string, unknown>), pending: true },
        { headers: corsHeaders },
      )
    }

    // ── trades (all brokers or one) ──────────────────────────
    // Runs before the shared account_id load so it can serve an empty list
    // (no MTAPI brokers) or a broker_id without requiring connect fields.
    if (action === "trades") {
      const brokerId = String(body.broker_id ?? "").trim()
      const scope = String(body.scope ?? "all").toLowerCase()
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
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0
      const includeBalanceCashFlow = body.include_balance_cashflow !== false

      let brokers: Array<{
        id: string
        label: string
        broker_name: string | null
        fxsocket_account_id: string
        platform?: string | null
        mtapi_session_id: string | null
      }> = []

      if (brokerId) {
        const row = await loadMtapiBrokerRow(supabase, userId, brokerId)
        if (!row) return bad(400, "This account is not an MTAPI account.")
        const session = String(row.mtapi_session_id ?? "").trim()
        if (!session) {
          // Account exists but has no live session — empty list, not an error.
          return Response.json({ ok: true, trades: [] }, { headers: corsHeaders })
        }
        brokers = [{
          id: row.id,
          label: row.label,
          broker_name: row.broker_name ?? null,
          fxsocket_account_id: session,
          platform: row.platform,
          mtapi_session_id: session,
        }]
      } else {
        const { data, error } = await supabase
          .from("broker_accounts")
          .select("id,label,broker_name,platform,mtapi_session_id")
          .eq("user_id", userId)
          .eq("provider", "mtapi")
          .eq("is_active", true)
        if (error) return bad(500, error.message)
        brokers = ((data ?? []) as Array<{
          id: string
          label: string
          broker_name: string | null
          platform?: string | null
          mtapi_session_id: string | null
        }>)
          .filter(b => (b.mtapi_session_id ?? "").trim().length > 0)
          .map(b => ({
            id: b.id,
            label: b.label,
            broker_name: b.broker_name,
            fxsocket_account_id: String(b.mtapi_session_id).trim(),
            platform: b.platform,
            mtapi_session_id: b.mtapi_session_id,
          }))
      }

      if (brokers.length === 0) {
        return Response.json({ ok: true, trades: [] }, { headers: corsHeaders })
      }

      if (!isMtapiConfigured(Deno.env)) {
        throw new MtapiApiError(
          "MTAPI is not configured. Set MTAPI_BASE_URL in Supabase Edge secrets.",
          503,
          "NOT_CONFIGURED",
        )
      }

      const mtapi = new MtapiClient({ env: Deno.env })
      const tradesByBroker = await Promise.all(
        brokers.map(b => fetchFxsocketBrokerTrades(mtapi, b, {
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

    // ── shared: load account row ─────────────────────────────
    const accountRowId = String(body.account_id ?? body.broker_id ?? "")
    if (!accountRowId) return bad(400, "account_id required")

    const { data: row, error: rowErr } = await supabase
      .from("broker_accounts")
      .select("*")
      .eq("id", accountRowId)
      .eq("user_id", userId)
      .maybeSingle()
    if (rowErr) return bad(500, rowErr.message)
    if (!row) return bad(404, "Broker account not found")
    if (row.provider !== "mtapi") return bad(400, "This account is not an MTAPI account.")

    // ── opened_orders / order_history / position_history ────
    // Same shapes as fxsocket-broker so trade-time hydration is provider-agnostic.
    if (action === "opened_orders" || action === "order_history" || action === "position_history") {
      const session = String(row.mtapi_session_id ?? "").trim()
      if (!session) return Response.json({ ok: true, orders: [], positions: [] }, { headers: corsHeaders })
      const mtapi = makeMtapiClient()
      const platform = row.platform === "MT4" ? "MT4" : "MT5"

      if (action === "opened_orders") {
        const orders = await mtapi.openedOrders(session, platform)
        return Response.json({ ok: true, orders }, { headers: corsHeaders })
      }

      const fromRaw = String(body.history_from ?? "").trim()
      const toRaw = String(body.history_to ?? "").trim()
      const historyFrom = fromRaw || BROKER_FULL_HISTORY_FROM_DATE
      const historyTo = toRaw || formatMtDt(new Date())

      if (action === "order_history") {
        const orders = await mtapi.orderHistory(session, historyFrom, historyTo, platform)
        return Response.json({ ok: true, orders }, { headers: corsHeaders })
      }

      const positions = await mtapi.positionHistory(session, historyFrom, historyTo, platform)
      return Response.json({ ok: true, positions }, { headers: corsHeaders })
    }

    // ── reconnect ────────────────────────────────────────────
    if (action === "reconnect") {
      const password = String(body.password ?? "").trim()
      const server = String(body.server ?? "").trim()
      const login = String(body.login ?? "").trim()
      if (!password) return bad(400, "password required")
      if (!login) return bad(400, "Broker login is missing — delete and connect again.")
      if (!server) return bad(400, "Broker server is missing — delete and connect again.")

      const { data: updated, error: updErr } = await supabase
        .from("broker_accounts")
        .update({
          broker_password_encrypted: isEncryptionConfigured(Deno.env)
            ? await encryptMtPassword(password, Deno.env)
            : password,
          auto_reconnect_enabled: true,
          mtapi_session_id: null,
          mtapi_status: "connecting",
          connection_status: "pending",
          connection_error: null,
          connection_error_kind: null,
          connection_error_message: null,
        })
        .eq("id", accountRowId)
        .eq("user_id", userId)
        .select("*")
        .single()
      if (updErr) return bad(500, updErr.message)
      return Response.json(
        { ok: true, account: stripSecrets(updated as Record<string, unknown>), pending: true },
        { headers: corsHeaders },
      )
    }

    // ── broker_status ────────────────────────────────────────
    // DB-cached snapshot (worker refreshes it each sweep). Returned in the same
    // shape as fxsocket-broker's broker_status so the health modal is provider-agnostic.
    if (action === "broker_status") {
      const connected = row.mtapi_status === "connected" || row.connection_status === "connected"
      const status = {
        status: connected ? "ready" : "disconnected",
        serverTime: row.last_synced_at ?? null,
        terminal: { alive: connected },
        broker: { connected, server: row.broker_server ?? undefined },
        account: {
          loggedIn: connected,
          login: row.account_login ? Number(row.account_login) : undefined,
          currency: row.last_currency ?? undefined,
          // parseMtAccountTradeMode accepts 'Demo'/'Live' strings as well as numeric modes.
          type: (row.linked_account_type as string | null) ?? undefined,
          tradeAllowed: connected,
        },
        bridge: { tradeEaReady: connected, symbolsSynced: connected },
      }
      return Response.json(
        {
          ok: true,
          account: stripSecrets(row as Record<string, unknown>),
          healthy: connected,
          status,
        },
        { headers: corsHeaders },
      )
    }

    // ── refresh_summary ──────────────────────────────────────
    if (action === "refresh_summary") {
      const connected = row.mtapi_status === "connected" || row.connection_status === "connected"
      const pending = !connected
      if (pending || !row.mtapi_session_id) {
        return Response.json(
          {
            ok: true,
            account: stripSecrets(row as Record<string, unknown>),
            pending,
          },
          { headers: corsHeaders },
        )
      }

      try {
        const mtapi = makeMtapiClient()
        const platform = row.platform === "MT4" ? "MT4" : "MT5"
        const rawSummary = await mtapi.accountSummary(String(row.mtapi_session_id), platform)
        const summary = normalizeMtapiAccountSummary(rawSummary)
        const balance = effectiveAccountSummaryBalance(summary)
        const equity = summary.equity ?? null
        const currency = summary.currency ?? null
        const patch: Record<string, unknown> = {
          last_balance: balance,
          last_equity: equity,
          last_currency: currency,
          last_synced_at: new Date().toISOString(),
        }
        const baselineBalance = resolvePerformanceBaselineBalance(
          (row.performance_baseline_balance as number | null) ?? null,
          summary,
        )
        if (baselineBalance != null) {
          patch.performance_baseline_balance = baselineBalance
          patch.performance_baseline_captured_at = new Date().toISOString()
        }

        const { data: updated, error: updErr } = await supabase
          .from("broker_accounts")
          .update(patch)
          .eq("id", accountRowId)
          .eq("user_id", userId)
          .select("*")
          .single()
        if (updErr) throw new Error(updErr.message)

        return Response.json(
          {
            ok: true,
            account: stripSecrets(updated as Record<string, unknown>),
            summary,
            pending: false,
          },
          { headers: corsHeaders },
        )
      } catch (e) {
        // Configuration / auth-class errors must surface with a real status.
        // Only transport/unknown failures fall back to the DB-cached row.
        if (e instanceof MtapiApiError && e.status >= 400 && e.status <= 599) {
          throw e
        }
        // Non-fatal: fall back to the DB-cached row so the UI still renders.
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[mtapi-broker] refresh_summary AccountSummary failed: ${msg}`)
        return Response.json(
          {
            ok: true,
            account: stripSecrets(row as Record<string, unknown>),
            pending: false,
            error: msg,
          },
          { headers: corsHeaders },
        )
      }
    }

    // ── delete ───────────────────────────────────────────────
    if (action === "delete") {
      const { error } = await supabase
        .from("broker_accounts")
        .delete()
        .eq("id", accountRowId)
        .eq("user_id", userId)
      if (error) return bad(500, error.message)
      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (e) {
    if (e instanceof MtapiApiError) {
      // MTAPI often returns application errors with HTTP 201. Forwarding that
      // status makes res.ok true in the browser and hides the error as [].
      const status = e.status >= 400 && e.status <= 599 ? e.status : 502
      return bad(status, e.message)
    }
    const msg = e instanceof Error ? e.message : "Internal error"
    console.error("[mtapi-broker]", msg)
    return bad(500, msg)
  }
})
