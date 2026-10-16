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
  bybitAccount,
  bybitAccountTrades,
  bybitEnvironmentOf,
  bybitFingerprint,
  bybitLiveBook,
  bybitOpenedOrders,
  bybitQuote,
  friendlyBybitError,
  type BybitKeys,
} from "../_shared/bybitV5.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

/** Keys and every other secret column stay on the server. */
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
    bybit_api_key_encrypted: _apiKey,
    bybit_api_secret_encrypted: _apiSecret,
    kucoin_api_key_encrypted: _kcKey,
    kucoin_api_secret_encrypted: _kcSecret,
    kucoin_passphrase_encrypted: _kcPass,
    ...safe
  } = row
  return safe
}

type ServiceClient = ReturnType<typeof createClient>

async function loadBybitRow(supabase: ServiceClient, userId: string, rowId: string) {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", rowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.provider !== "bybit") return null
  return data
}

async function keysForRow(row: Record<string, unknown>): Promise<BybitKeys> {
  const apiKey = await decryptMtPassword(String(row.bybit_api_key_encrypted ?? ""), Deno.env)
  const apiSecret = await decryptMtPassword(String(row.bybit_api_secret_encrypted ?? ""), Deno.env)
  if (!apiKey || !apiSecret) throw new Error("Bybit API key could not be read")
  return { apiKey, apiSecret, environment: bybitEnvironmentOf(row.bybit_environment) }
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

type Settings = { marginUsdt: number; leverage: number }

/** Margin mode is account-wide on Bybit and is read from the exchange, never set here. */
function readSettings(body: Record<string, unknown>, fallback?: Partial<Settings>): Settings | string {
  const marginUsdt = body.margin_usdt === undefined ? fallback?.marginUsdt : Number(body.margin_usdt)
  const leverage = body.leverage === undefined ? fallback?.leverage : Math.round(Number(body.leverage))
  if (marginUsdt == null || !Number.isFinite(marginUsdt) || marginUsdt <= 0) return "Enter a margin above 0 USDT"
  if (marginUsdt > 10_000_000) return "Margin is too large"
  if (leverage == null || !Number.isFinite(leverage) || leverage < 1 || leverage > 125) return "Leverage must be between 1 and 125"
  return { marginUsdt, leverage }
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
      const apiKey = String(body.api_key ?? "").trim()
      const apiSecret = String(body.api_secret ?? "").trim()
      const environment = bybitEnvironmentOf(body.environment)
      const label = String(body.label ?? "").trim()
      if (!apiKey || !apiSecret) return bad(400, "Enter your Bybit API key and secret")
      const settings = readSettings(body)
      if (typeof settings === "string") return bad(400, settings)
      const keys: BybitKeys = { apiKey, apiSecret, environment }

      const accountId = await bybitFingerprint(apiKey)
      const sub = await loadUserSubscription(supabase, userId)
      const limitDenied = await assertBrokerAccountLimit(supabase, userId, sub)
      if (limitDenied) {
        const payload = await limitDenied.json().catch(() => ({ error: "Broker account limit reached" })) as { error?: string }
        return bad(limitDenied.status, payload.error ?? "Broker account limit reached")
      }

      const { data: existing } = await supabase
        .from("broker_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("bybit_account_id", accountId)
        .maybeSingle()
      if (existing?.id) return bad(409, "This Bybit account is already linked")

      let snapshot
      try {
        snapshot = await bybitAccount(keys)
      } catch (error) {
        return bad(400, friendlyBybitError(error))
      }
      if (!snapshot.canTrade) {
        return bad(400, "This Bybit API key cannot trade. Enable Contract Trade (Orders and Positions) and turn off read-only.")
      }

      const apiKeyEncrypted = await encryptMtPasswordRequired(apiKey, Deno.env)
      const apiSecretEncrypted = await encryptMtPasswordRequired(apiSecret, Deno.env)
      const now = new Date().toISOString()
      const baseline = resolvePerformanceBaselineBalance(null, {
        balance: snapshot.balance,
        equity: snapshot.equity,
      })
      const { data: inserted, error } = await supabase
        .from("broker_accounts")
        .insert({
          user_id: userId,
          label: label || `Bybit Futures${environment === "demo" ? " Demo" : ""}`,
          platform: "Bybit",
          provider: "bybit",
          bybit_account_id: accountId,
          bybit_environment: environment,
          bybit_api_key_encrypted: apiKeyEncrypted,
          bybit_api_secret_encrypted: apiSecretEncrypted,
          bybit_status: "connected",
          bybit_margin_usdt: settings.marginUsdt,
          bybit_leverage: settings.leverage,
          broker_name: "Bybit Futures",
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
          linked_account_type: environment === "live" ? "Live" : "Demo",
        })
        .select("*")
        .single()
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return bad(409, "This Bybit account is already linked")
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
        if (!listed.data || listed.data.provider !== "bybit") {
          return bad(400, "This account is not a Bybit account.")
        }
        accounts.push(listed.data as Record<string, unknown>)
      } else {
        const listed = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("user_id", userId)
          .eq("provider", "bybit")
          .eq("is_active", true)
        if (listed.error) return bad(500, listed.error.message)
        for (const account of listed.data ?? []) accounts.push(account as Record<string, unknown>)
      }
      const trades = []
      for (const account of accounts) {
        if (!account?.bybit_account_id) continue
        const keys = await keysForRow(account)
        const book = await bybitAccountTrades({
          keys,
          brokerId: String(account.id),
          brokerLabel: String(account.label ?? account.broker_name ?? "Bybit"),
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
    const row = await loadBybitRow(supabase, userId, accountRowId)
    if (!row) return bad(404, "Bybit account not found")

    if (action === "delete") {
      const { error } = await supabase
        .from("broker_accounts")
        .delete()
        .eq("id", accountRowId)
        .eq("user_id", userId)
      if (error) return bad(500, error.message)
      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    if (action === "update_settings") {
      const settings = readSettings(body, {
        marginUsdt: Number(row.bybit_margin_usdt),
        leverage: Number(row.bybit_leverage),
      })
      if (typeof settings === "string") return bad(400, settings)
      const { data: updated, error } = await supabase
        .from("broker_accounts")
        .update({
          bybit_margin_usdt: settings.marginUsdt,
          bybit_leverage: settings.leverage,
        })
        .eq("id", accountRowId)
        .eq("user_id", userId)
        .select("*")
        .single()
      if (error) return bad(500, error.message)
      return Response.json({ ok: true, account: stripSecrets(updated as Record<string, unknown>) }, { headers: corsHeaders })
    }

    if (action === "broker_status" || action === "refresh_summary") {
      try {
        const keys = await keysForRow(row as Record<string, unknown>)
        const snapshot = await bybitAccount(keys)
        const now = new Date().toISOString()
        const patch: Record<string, unknown> = {
          bybit_status: "connected",
          connection_status: "connected",
          terminal_connected: true,
          trade_allowed: snapshot.canTrade,
          last_balance: snapshot.balance ?? row.last_balance,
          last_equity: snapshot.equity ?? row.last_equity,
          last_currency: snapshot.currency,
          last_synced_at: now,
          connection_error: null,
          linked_account_type: keys.environment === "live" ? "Live" : "Demo",
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
              currency: snapshot.currency,
              open_trades: snapshot.openTrades,
              margin_mode: snapshot.marginMode,
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
        const message = friendlyBybitError(error)
        await supabase
          .from("broker_accounts")
          .update({
            bybit_status: "error",
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
      const keys = await keysForRow(row as Record<string, unknown>)
      const quote = await bybitQuote(keys, String(body.symbol ?? "BTCUSDT"))
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const keys = await keysForRow(row as Record<string, unknown>)
      const book = await bybitLiveBook(keys)
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
      const keys = await keysForRow(row as Record<string, unknown>)
      const orders = await bybitOpenedOrders(keys)
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (error) {
    if (error instanceof BrokerCredentialEncryptionError) return bad(503, error.message)
    const message = friendlyBybitError(error)
    console.error("[bybit-broker]", message)
    return bad(500, message)
  }
})
