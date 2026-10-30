import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import {
  BrokerCredentialEncryptionError,
  decryptMtPassword,
  encryptMtPasswordRequired,
} from "../_shared/brokerCredentialsCrypto.ts"
import { resolvePerformanceBaselineBalance } from "../_shared/performanceBaseline.ts"
import {
  assertBrokerAccountLimit,
  loadUserSubscription,
} from "../_shared/subscriptionAccess.ts"
import {
  friendlyTradelockerError,
  isTradelockerEnvironment,
  tradelockerAccounts,
  tradelockerAccountTrades,
  tradelockerFingerprint,
  tradelockerLiveBook,
  tradelockerOpenedOrders,
  tradelockerQuote,
  tradelockerSnapshot,
  type TradelockerAccountRef,
  type TradelockerCredentials,
} from "../_shared/tradelockerApi.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

/** The TradeLocker password and every other broker's secret columns stay on the server. */
function stripSecrets(row: Record<string, unknown>) {
  const {
    broker_password_encrypted: _password,
    mtapi_session_id: _session,
    ctrader_access_token_encrypted: _ctAccess,
    ctrader_refresh_token_encrypted: _ctRefresh,
    ctrader_token_expires_at: _ctExpires,
    ctrader_client_id_encrypted: _ctClientId,
    ctrader_client_secret_encrypted: _ctClientSecret,
    binance_api_key_encrypted: _bnKey,
    binance_api_secret_encrypted: _bnSecret,
    bybit_api_key_encrypted: _byKey,
    bybit_api_secret_encrypted: _bySecret,
    kucoin_api_key_encrypted: _kcKey,
    kucoin_api_secret_encrypted: _kcSecret,
    kucoin_passphrase_encrypted: _kcPassphrase,
    dxtrade_password_encrypted: _dxPassword,
    tradelocker_password_encrypted: _tlPassword,
    matchtrader_password_encrypted: _mtPassword,
    ...safe
  } = row
  return safe
}

type ServiceClient = ReturnType<typeof createClient>

async function loadTradelockerRow(supabase: ServiceClient, userId: string, rowId: string) {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", rowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.provider !== "tradelocker") return null
  return data
}

async function credsForRow(row: Record<string, unknown>): Promise<TradelockerCredentials> {
  if (!isTradelockerEnvironment(row.tradelocker_environment)) throw new Error("This TradeLocker account has no environment")
  const password = await decryptMtPassword(String(row.tradelocker_password_encrypted ?? ""), Deno.env)
  const email = String(row.tradelocker_email ?? "").trim()
  const server = String(row.tradelocker_server ?? "").trim()
  if (!password || !email || !server) throw new Error("TradeLocker login could not be read")
  return { environment: row.tradelocker_environment, server, email, password }
}

function refOf(row: Record<string, unknown>): TradelockerAccountRef {
  const accountId = String(row.tradelocker_account_ref ?? "").trim()
  const accNum = Number(row.tradelocker_acc_num)
  if (!accountId || !Number.isFinite(accNum)) throw new Error("This TradeLocker account has no account reference")
  return { accountId, accNum }
}

function unhealthyStatus() {
  return {
    status: "disconnected",
    terminal: { alive: false },
    broker: { connected: false },
    account: { loggedIn: false, tradeAllowed: false },
    bridge: { tradeEaReady: false, symbolsSynced: false },
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const authHeader = req.headers.get("Authorization")
  if (!authHeader) return bad(401, "Missing authorization")

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user }, error: authError } = await authClient.auth.getUser()
  if (authError || !user) return bad(401, "Unauthorized")
  const userId = user.id

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
    if (action === "link") {
      const environment = String(body.environment ?? "").trim().toLowerCase()
      if (!isTradelockerEnvironment(environment)) return bad(400, "Choose Demo or Live")
      const server = String(body.server ?? "").trim()
      const email = String(body.email ?? "").trim()
      const password = String(body.password ?? "")
      const label = String(body.label ?? "").trim()
      const requestedId = String(body.account_id_ref ?? "").trim()
      if (!server) return bad(400, "Enter the broker server name shown on the TradeLocker login")
      if (!email || !password) return bad(400, "Enter your TradeLocker email and password")
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(400, "Enter a valid TradeLocker email")
      if (server.length > 100 || email.length > 200 || password.length > 256) return bad(400, "That login is too long")
      if (/[\u0000-\u001f\u007f]/.test(server)) return bad(400, "That server name is not valid")

      const creds: TradelockerCredentials = { environment, server, email, password }

      const sub = await loadUserSubscription(supabase, userId)
      const limitDenied = await assertBrokerAccountLimit(supabase, userId, sub)
      if (limitDenied) {
        const payload = await limitDenied.json().catch(() => ({ error: "Broker account limit reached" })) as { error?: string }
        return bad(limitDenied.status, payload.error ?? "Broker account limit reached")
      }

      let accounts
      try {
        accounts = await tradelockerAccounts(creds)
      } catch (error) {
        return bad(400, friendlyTradelockerError(error))
      }
      if (!accounts.length) return bad(400, "This TradeLocker login has no trading accounts")

      let chosen = requestedId ? accounts.find(item => item.accountId === requestedId) : undefined
      if (requestedId && !chosen) {
        return bad(400, `Account ${requestedId} was not found on this login. Available: ${accounts.map(item => item.accountId).join(", ")}`)
      }
      if (!chosen) {
        if (accounts.length > 1) {
          return bad(400, `This login has several accounts (${accounts.map(item => `#${item.accountId}`).join(", ")}). Enter the account number to link.`)
        }
        chosen = accounts[0]
      }
      if (chosen.status && chosen.status !== "ACTIVE") {
        return bad(400, `This TradeLocker account is ${chosen.status.toLowerCase().replace(/_/g, " ")} and cannot open trades.`)
      }

      const fingerprint = await tradelockerFingerprint(environment, server, email, chosen.accountId)
      const { data: existing } = await supabase
        .from("broker_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("tradelocker_account_id", fingerprint)
        .maybeSingle()
      if (existing?.id) return bad(409, "This TradeLocker account is already linked")

      const ref: TradelockerAccountRef = { accountId: chosen.accountId, accNum: chosen.accNum }
      let snapshot
      try {
        snapshot = await tradelockerSnapshot(creds, ref)
      } catch (error) {
        return bad(400, friendlyTradelockerError(error))
      }

      const passwordEncrypted = await encryptMtPasswordRequired(password, Deno.env)
      const now = new Date().toISOString()
      const baseline = resolvePerformanceBaselineBalance(null, {
        balance: snapshot.balance,
        equity: snapshot.equity,
      })
      const { data: inserted, error } = await supabase
        .from("broker_accounts")
        .insert({
          user_id: userId,
          label: label || `TradeLocker #${chosen.accountId}`,
          platform: "TradeLocker",
          provider: "tradelocker",
          tradelocker_account_id: fingerprint,
          tradelocker_environment: environment,
          tradelocker_server: server,
          tradelocker_email: email,
          tradelocker_password_encrypted: passwordEncrypted,
          tradelocker_account_ref: chosen.accountId,
          tradelocker_acc_num: chosen.accNum,
          // The Account column and the assistant read account_login, so show the TradeLocker account number there.
          account_login: chosen.accountId,
          tradelocker_status: "connected",
          broker_name: server,
          connection_status: "connected",
          terminal_connected: true,
          trade_allowed: snapshot.canTrade,
          last_balance: snapshot.balance ?? null,
          last_equity: snapshot.equity ?? null,
          last_currency: snapshot.currency,
          last_synced_at: now,
          last_activated_at: now,
          performance_baseline_balance: baseline,
          performance_baseline_captured_at: baseline == null ? null : now,
          is_active: true,
          linked_account_type: environment === "demo" ? "Demo" : "Live",
        })
        .select("*")
        .single()
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return bad(409, "This TradeLocker account is already linked")
        return bad(500, error.message)
      }
      return Response.json({
        ok: true,
        account: stripSecrets(inserted as Record<string, unknown>),
        status: snapshot.status,
        healthy: snapshot.canTrade,
      }, { headers: corsHeaders })
    }

    if (action === "trades") {
      const brokerId = String(body.broker_id ?? body.account_id ?? "").trim()
      const scope = String(body.scope ?? "all")
      const historyFrom = String(body.history_from ?? "")
      const historyTo = String(body.history_to ?? "")
      const accounts: Array<Record<string, unknown>> = []
      if (brokerId) {
        const listed = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("id", brokerId)
          .eq("user_id", userId)
          .maybeSingle()
        if (listed.error) return bad(500, listed.error.message)
        if (!listed.data || listed.data.provider !== "tradelocker") {
          return bad(400, "This account is not a TradeLocker account.")
        }
        accounts.push(listed.data as Record<string, unknown>)
      } else {
        const listed = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("user_id", userId)
          .eq("provider", "tradelocker")
          .eq("is_active", true)
        if (listed.error) return bad(500, listed.error.message)
        for (const account of listed.data ?? []) accounts.push(account as Record<string, unknown>)
      }
      const trades = []
      for (const account of accounts) {
        if (!account?.tradelocker_account_id) continue
        const creds = await credsForRow(account)
        const book = await tradelockerAccountTrades({
          creds,
          ref: refOf(account),
          brokerId: String(account.id),
          brokerLabel: String(account.label ?? account.broker_name ?? "TradeLocker"),
          brokerName: account.broker_name == null ? null : String(account.broker_name),
          historyFrom,
          historyTo,
          scope,
        })
        trades.push(...book)
      }
      return Response.json({ ok: true, trades }, { headers: corsHeaders })
    }

    const accountRowId = String(body.account_id ?? "").trim()
    if (!accountRowId) return bad(400, "account_id required")
    const row = await loadTradelockerRow(supabase, userId, accountRowId)
    if (!row) return bad(404, "TradeLocker account not found")

    if (action === "delete") {
      const { error } = await supabase
        .from("broker_accounts")
        .delete()
        .eq("id", accountRowId)
        .eq("user_id", userId)
      if (error) return bad(500, error.message)
      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    if (action === "broker_status" || action === "refresh_summary") {
      try {
        const creds = await credsForRow(row as Record<string, unknown>)
        const snapshot = await tradelockerSnapshot(creds, refOf(row as Record<string, unknown>))
        const now = new Date().toISOString()
        const patch: Record<string, unknown> = {
          tradelocker_status: "connected",
          connection_status: "connected",
          terminal_connected: true,
          trade_allowed: snapshot.canTrade,
          last_balance: snapshot.balance ?? row.last_balance,
          last_equity: snapshot.equity ?? row.last_equity,
          last_currency: snapshot.currency,
          last_synced_at: now,
          connection_error: null,
        }
        const baseline = resolvePerformanceBaselineBalance(row.performance_baseline_balance, {
          balance: snapshot.balance,
          equity: snapshot.equity,
        })
        if (baseline != null) {
          patch.performance_baseline_balance = baseline
          patch.performance_baseline_captured_at = now
        }
        const { data: updated, error } = await supabase
          .from("broker_accounts")
          .update(patch)
          .eq("id", accountRowId)
          .eq("user_id", userId)
          .select("*")
          .single()
        if (error) return bad(500, error.message)
        const account = stripSecrets(updated as Record<string, unknown>)
        if (action === "refresh_summary") {
          return Response.json({
            ok: true,
            account,
            summary: {
              balance: snapshot.balance,
              equity: snapshot.equity,
              profit: snapshot.profit,
              margin: snapshot.margin,
              free_margin: snapshot.freeMargin,
              currency: snapshot.currency,
              open_trades: snapshot.openTrades,
              synced: true,
            },
          }, { headers: corsHeaders })
        }
        return Response.json({
          ok: true,
          account,
          healthy: snapshot.canTrade,
          status: snapshot.status,
        }, { headers: corsHeaders })
      } catch (error) {
        const message = friendlyTradelockerError(error)
        await supabase
          .from("broker_accounts")
          .update({
            tradelocker_status: "error",
            terminal_connected: false,
            trade_allowed: false,
            connection_error: message,
          })
          .eq("id", accountRowId)
          .eq("user_id", userId)
        const { data: updated } = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("id", accountRowId)
          .eq("user_id", userId)
          .maybeSingle()
        const account = stripSecrets((updated ?? row) as Record<string, unknown>)
        if (action === "refresh_summary") {
          return Response.json({ ok: true, account, error: message }, { headers: corsHeaders })
        }
        return Response.json({
          ok: true,
          account,
          healthy: false,
          status: unhealthyStatus(),
        }, { headers: corsHeaders })
      }
    }

    if (action === "quote") {
      const creds = await credsForRow(row as Record<string, unknown>)
      const quote = await tradelockerQuote(creds, refOf(row as Record<string, unknown>), String(body.symbol ?? "EURUSD"))
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const creds = await credsForRow(row as Record<string, unknown>)
      const book = await tradelockerLiveBook(creds, refOf(row as Record<string, unknown>))
      return Response.json({
        ok: true,
        summary: {
          balance: book.balance,
          equity: book.equity,
          profit: book.profit,
          currency: book.currency,
          open_trades: book.openTrades,
          synced: true,
        },
      }, { headers: corsHeaders })
    }

    if (action === "opened_orders") {
      const creds = await credsForRow(row as Record<string, unknown>)
      const orders = await tradelockerOpenedOrders(creds, refOf(row as Record<string, unknown>))
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (error) {
    if (error instanceof BrokerCredentialEncryptionError) return bad(503, error.message)
    const message = friendlyTradelockerError(error)
    console.error("[tradelocker-broker]", message)
    return bad(500, message)
  }
})
