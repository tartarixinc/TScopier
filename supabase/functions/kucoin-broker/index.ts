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
  friendlyKucoinError,
  kucoinAccount,
  kucoinAccountTrades,
  kucoinFingerprint,
  kucoinLiveBook,
  kucoinOpenedOrders,
  kucoinQuote,
  type KucoinKeys,
} from "../_shared/kucoinFutures.ts"

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
    bybit_api_key_encrypted: _byKey,
    bybit_api_secret_encrypted: _bySecret,
    kucoin_api_key_encrypted: _apiKey,
    kucoin_api_secret_encrypted: _apiSecret,
    kucoin_passphrase_encrypted: _passphrase,
    dxtrade_password_encrypted: _dxPassword,
    tradelocker_password_encrypted: _tlPassword,
    ...safe
  } = row
  return safe
}

type ServiceClient = ReturnType<typeof createClient>

async function loadKucoinRow(supabase: ServiceClient, userId: string, rowId: string) {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", rowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.provider !== "kucoin") return null
  return data
}

async function keysForRow(row: Record<string, unknown>): Promise<KucoinKeys> {
  const apiKey = await decryptMtPassword(String(row.kucoin_api_key_encrypted ?? ""), Deno.env)
  const apiSecret = await decryptMtPassword(String(row.kucoin_api_secret_encrypted ?? ""), Deno.env)
  const passphrase = await decryptMtPassword(String(row.kucoin_passphrase_encrypted ?? ""), Deno.env)
  if (!apiKey || !apiSecret || !passphrase) throw new Error("KuCoin API key could not be read")
  return { apiKey, apiSecret, passphrase }
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

type Settings = { marginUsdt: number; leverage: number; marginMode: "isolated" | "cross" }

/** Margin mode is chosen here and applied to each symbol by the worker before an order. */
function readSettings(body: Record<string, unknown>, fallback?: Partial<Settings>): Settings | string {
  const marginUsdt = body.margin_usdt === undefined ? fallback?.marginUsdt : Number(body.margin_usdt)
  const leverage = body.leverage === undefined ? fallback?.leverage : Math.round(Number(body.leverage))
  if (marginUsdt == null || !Number.isFinite(marginUsdt) || marginUsdt <= 0) return "Enter a margin above 0 USDT"
  if (marginUsdt > 10_000_000) return "Margin is too large"
  if (leverage == null || !Number.isFinite(leverage) || leverage < 1 || leverage > 125) return "Leverage must be between 1 and 125"
  const rawMode = body.margin_mode === undefined ? fallback?.marginMode : String(body.margin_mode).trim().toLowerCase()
  if (rawMode !== "isolated" && rawMode !== "cross") return "Choose isolated or cross margin"
  return { marginUsdt, leverage, marginMode: rawMode }
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
      const passphrase = String(body.passphrase ?? "").trim()
      const label = String(body.label ?? "").trim()
      if (!apiKey || !apiSecret || !passphrase) return bad(400, "Enter your KuCoin API key, secret and passphrase")
      const settings = readSettings(body)
      if (typeof settings === "string") return bad(400, settings)
      const keys: KucoinKeys = { apiKey, apiSecret, passphrase }

      const accountId = await kucoinFingerprint(apiKey)
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
        .eq("kucoin_account_id", accountId)
        .maybeSingle()
      if (existing?.id) return bad(409, "This KuCoin account is already linked")

      let snapshot
      try {
        snapshot = await kucoinAccount(keys)
      } catch (error) {
        return bad(400, friendlyKucoinError(error))
      }
      if (!snapshot.canTrade) {
        return bad(400, "This KuCoin API key cannot trade futures. Enable the Futures permission on the key.")
      }

      const apiKeyEncrypted = await encryptMtPasswordRequired(apiKey, Deno.env)
      const apiSecretEncrypted = await encryptMtPasswordRequired(apiSecret, Deno.env)
      const passphraseEncrypted = await encryptMtPasswordRequired(passphrase, Deno.env)
      const now = new Date().toISOString()
      const baseline = resolvePerformanceBaselineBalance(null, {
        balance: snapshot.balance,
        equity: snapshot.equity,
      })
      const { data: inserted, error } = await supabase
        .from("broker_accounts")
        .insert({
          user_id: userId,
          label: label || "KuCoin Futures",
          platform: "KuCoin",
          provider: "kucoin",
          kucoin_account_id: accountId,
          kucoin_api_key_encrypted: apiKeyEncrypted,
          kucoin_api_secret_encrypted: apiSecretEncrypted,
          kucoin_passphrase_encrypted: passphraseEncrypted,
          kucoin_status: "connected",
          kucoin_margin_usdt: settings.marginUsdt,
          kucoin_leverage: settings.leverage,
          kucoin_margin_mode: settings.marginMode,
          broker_name: "KuCoin Futures",
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
          linked_account_type: "Live",
        })
        .select("*")
        .single()
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return bad(409, "This KuCoin account is already linked")
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
        if (!listed.data || listed.data.provider !== "kucoin") {
          return bad(400, "This account is not a KuCoin account.")
        }
        accounts.push(listed.data as Record<string, unknown>)
      } else {
        const listed = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("user_id", userId)
          .eq("provider", "kucoin")
          .eq("is_active", true)
        if (listed.error) return bad(500, listed.error.message)
        for (const account of listed.data ?? []) accounts.push(account as Record<string, unknown>)
      }
      const trades = []
      for (const account of accounts) {
        if (!account?.kucoin_account_id) continue
        const keys = await keysForRow(account)
        const book = await kucoinAccountTrades({
          keys,
          brokerId: String(account.id),
          brokerLabel: String(account.label ?? account.broker_name ?? "KuCoin"),
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
    const row = await loadKucoinRow(supabase, userId, accountRowId)
    if (!row) return bad(404, "KuCoin account not found")

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
        marginUsdt: Number(row.kucoin_margin_usdt),
        leverage: Number(row.kucoin_leverage),
        marginMode: String(row.kucoin_margin_mode ?? "isolated") === "cross" ? "cross" : "isolated",
      })
      if (typeof settings === "string") return bad(400, settings)
      const { data: updated, error } = await supabase
        .from("broker_accounts")
        .update({
          kucoin_margin_usdt: settings.marginUsdt,
          kucoin_leverage: settings.leverage,
          kucoin_margin_mode: settings.marginMode,
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
        const snapshot = await kucoinAccount(keys)
        const now = new Date().toISOString()
        const patch: Record<string, unknown> = {
          kucoin_status: "connected",
          connection_status: "connected",
          terminal_connected: true,
          trade_allowed: snapshot.canTrade,
          last_balance: snapshot.balance ?? row.last_balance,
          last_equity: snapshot.equity ?? row.last_equity,
          last_currency: snapshot.currency,
          last_synced_at: now,
          connection_error: null,
          linked_account_type: "Live",
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
        const message = friendlyKucoinError(error)
        await supabase
          .from("broker_accounts")
          .update({
            kucoin_status: "error",
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
      const quote = await kucoinQuote(keys, String(body.symbol ?? "BTCUSDT"))
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const keys = await keysForRow(row as Record<string, unknown>)
      const book = await kucoinLiveBook(keys)
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
      const orders = await kucoinOpenedOrders(keys)
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (error) {
    if (error instanceof BrokerCredentialEncryptionError) return bad(503, error.message)
    const message = friendlyKucoinError(error)
    console.error("[kucoin-broker]", message)
    return bad(500, message)
  }
})
