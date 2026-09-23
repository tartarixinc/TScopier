import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { encryptMtPassword, isEncryptionConfigured } from "../_shared/brokerCredentialsCrypto.ts"
import {
  assertBrokerAccountLimit,
  loadUserSubscription,
} from "../_shared/subscriptionAccess.ts"

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

  // ── connect ──────────────────────────────────────────────
  if (action === "connect") {
    const sub = await loadUserSubscription(supabase, userId)
    const limitDenied = await assertBrokerAccountLimit(supabase, userId, sub)
    if (limitDenied) return bad(403, limitDenied)

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

  // ── shared: load account row ─────────────────────────────
  const accountRowId = String(body.account_id ?? body.broker_id ?? "")
  if (!accountRowId) return bad(400, "account_id required")

  const { data: row, error: rowErr } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", accountRowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (rowErr) throw new Error(rowErr.message)
  if (!row) return bad(404, "Broker account not found")
  if (row.provider !== "mtapi") return bad(400, "This account is not an MTAPI account.")

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
    return Response.json(
      {
        ok: true,
        account: stripSecrets(row as Record<string, unknown>),
        pending: row.connection_status !== "connected",
      },
      { headers: corsHeaders },
    )
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
})
