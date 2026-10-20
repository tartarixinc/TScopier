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
  assertPublicDxtradeHost,
  dxtradeAccounts,
  dxtradeAccountTrades,
  dxtradeFingerprint,
  dxtradeLiveBook,
  dxtradeOpenedOrders,
  dxtradeQuote,
  dxtradeSnapshot,
  friendlyDxtradeError,
  normalizeDxtradeServerUrl,
  type DxtradeCredentials,
} from "../_shared/dxtradeApi.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

/** The DXtrade password and every other broker's secret columns stay on the server. */
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
    ...safe
  } = row
  return safe
}

type ServiceClient = ReturnType<typeof createClient>

async function loadDxtradeRow(supabase: ServiceClient, userId: string, rowId: string) {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", rowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.provider !== "dxtrade") return null
  return data
}

async function credsForRow(row: Record<string, unknown>): Promise<DxtradeCredentials> {
  const normalized = normalizeDxtradeServerUrl(String(row.dxtrade_server_url ?? ""))
  if (!normalized.ok) throw new Error(normalized.error)
  const password = await decryptMtPassword(String(row.dxtrade_password_encrypted ?? ""), Deno.env)
  const username = String(row.dxtrade_username ?? "").trim()
  if (!password || !username) throw new Error("DXtrade login could not be read")
  await assertPublicDxtradeHost(normalized.url)
  return {
    serverUrl: normalized.url,
    username,
    domain: String(row.dxtrade_domain ?? "default").trim() || "default",
    password,
  }
}

function accountCodeOf(row: Record<string, unknown>): string {
  const code = String(row.dxtrade_account_code ?? "").trim()
  if (!code) throw new Error("This DXtrade account has no account code")
  return code
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
      const normalized = normalizeDxtradeServerUrl(String(body.server_url ?? ""))
      if (!normalized.ok) return bad(400, normalized.error)
      const username = String(body.username ?? "").trim()
      const domain = String(body.domain ?? "").trim() || "default"
      const password = String(body.password ?? "")
      const label = String(body.label ?? "").trim()
      const requestedCode = String(body.account_code ?? "").trim()
      if (!username || !password) return bad(400, "Enter your DXtrade username and password")
      if (username.includes("@")) return bad(400, "Enter the username without @domain. Use the domain field for that part.")
      if (username.length > 128 || domain.length > 64 || password.length > 256) return bad(400, "That login is too long")

      try {
        await assertPublicDxtradeHost(normalized.url)
      } catch (error) {
        return bad(400, friendlyDxtradeError(error))
      }

      const creds: DxtradeCredentials = { serverUrl: normalized.url, username, domain, password }

      const sub = await loadUserSubscription(supabase, userId)
      const limitDenied = await assertBrokerAccountLimit(supabase, userId, sub)
      if (limitDenied) {
        const payload = await limitDenied.json().catch(() => ({ error: "Broker account limit reached" })) as { error?: string }
        return bad(limitDenied.status, payload.error ?? "Broker account limit reached")
      }

      let accounts
      try {
        accounts = await dxtradeAccounts(creds)
      } catch (error) {
        return bad(400, friendlyDxtradeError(error))
      }
      if (!accounts.length) return bad(400, "This DXtrade login has no trading accounts")

      let chosen = requestedCode ? accounts.find(item => item.account === requestedCode) : undefined
      if (requestedCode && !chosen) {
        return bad(400, `Account ${requestedCode} was not found on this login. Available: ${accounts.map(item => item.account).join(", ")}`)
      }
      if (!chosen) {
        if (accounts.length > 1) {
          return bad(400, `This login has several accounts (${accounts.map(item => item.account).join(", ")}). Enter the account code to link.`)
        }
        chosen = accounts[0]
      }
      if (chosen.isPositionBased !== true) {
        return bad(400, "This DXtrade account is net-based. TScopier needs a position-based (hedging) account so each trade keeps its own stop loss and take profit.")
      }
      if (chosen.status && chosen.status !== "FULL_TRADING") {
        return bad(400, `This DXtrade account is ${chosen.status.toLowerCase().replace(/_/g, " ")} and cannot open trades.`)
      }

      const accountId = await dxtradeFingerprint(normalized.url, username, domain, chosen.account)
      const { data: existing } = await supabase
        .from("broker_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("dxtrade_account_id", accountId)
        .maybeSingle()
      if (existing?.id) return bad(409, "This DXtrade account is already linked")

      let snapshot
      try {
        snapshot = await dxtradeSnapshot(creds, chosen.account)
      } catch (error) {
        return bad(400, friendlyDxtradeError(error))
      }

      const passwordEncrypted = await encryptMtPasswordRequired(password, Deno.env)
      const now = new Date().toISOString()
      const host = new URL(normalized.url).hostname
      const baseline = resolvePerformanceBaselineBalance(null, {
        balance: snapshot.balance,
        equity: snapshot.equity,
      })
      const { data: inserted, error } = await supabase
        .from("broker_accounts")
        .insert({
          user_id: userId,
          label: label || `DXtrade ${chosen.account}`,
          platform: "DXtrade",
          provider: "dxtrade",
          dxtrade_account_id: accountId,
          dxtrade_server_url: normalized.url,
          dxtrade_username: username,
          dxtrade_domain: domain,
          dxtrade_password_encrypted: passwordEncrypted,
          dxtrade_account_code: chosen.account,
          dxtrade_is_position_based: true,
          dxtrade_status: "connected",
          broker_name: host,
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
          linked_account_type: /^(demo|test|sandbox)\b|\.demo\.|-demo\./i.test(host) ? "Demo" : "Live",
        })
        .select("*")
        .single()
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return bad(409, "This DXtrade account is already linked")
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
        if (!listed.data || listed.data.provider !== "dxtrade") {
          return bad(400, "This account is not a DXtrade account.")
        }
        accounts.push(listed.data as Record<string, unknown>)
      } else {
        const listed = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("user_id", userId)
          .eq("provider", "dxtrade")
          .eq("is_active", true)
        if (listed.error) return bad(500, listed.error.message)
        for (const account of listed.data ?? []) accounts.push(account as Record<string, unknown>)
      }
      const trades = []
      for (const account of accounts) {
        if (!account?.dxtrade_account_id) continue
        const creds = await credsForRow(account)
        const book = await dxtradeAccountTrades({
          creds,
          account: accountCodeOf(account),
          brokerId: String(account.id),
          brokerLabel: String(account.label ?? account.broker_name ?? "DXtrade"),
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
    const row = await loadDxtradeRow(supabase, userId, accountRowId)
    if (!row) return bad(404, "DXtrade account not found")

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
        const snapshot = await dxtradeSnapshot(creds, accountCodeOf(row as Record<string, unknown>))
        const now = new Date().toISOString()
        const patch: Record<string, unknown> = {
          dxtrade_status: "connected",
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
        const message = friendlyDxtradeError(error)
        await supabase
          .from("broker_accounts")
          .update({
            dxtrade_status: "error",
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
      const quote = await dxtradeQuote(creds, accountCodeOf(row as Record<string, unknown>), String(body.symbol ?? "EURUSD"))
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const creds = await credsForRow(row as Record<string, unknown>)
      const book = await dxtradeLiveBook(creds, accountCodeOf(row as Record<string, unknown>))
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
      const orders = await dxtradeOpenedOrders(creds, accountCodeOf(row as Record<string, unknown>))
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (error) {
    if (error instanceof BrokerCredentialEncryptionError) return bad(503, error.message)
    const message = friendlyDxtradeError(error)
    console.error("[dxtrade-broker]", message)
    return bad(500, message)
  }
})
