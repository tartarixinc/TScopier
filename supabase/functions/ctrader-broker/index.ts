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
  CTRADER_NOT_CONFIGURED,
  allowedCtraderRedirect,
  ctraderAppFromEnv,
  ctraderAuthorizeUrl,
  ctraderAccountTrades,
  ctraderLiveBook,
  ctraderOpenedOrders,
  ctraderQuote,
  ctraderStatusFromTrader,
  ctraderTrader,
  exchangeCtraderCode,
  listCtraderAccounts,
  refreshCtraderToken,
  signCtraderState,
  verifyCtraderState,
  type CtraderEnvironment,
  type CtraderTokens,
  type CtraderTradingAccount,
} from "../_shared/ctraderOpenApi.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

function stripSecrets(row: Record<string, unknown>) {
  const {
    broker_password_encrypted: _password,
    mtapi_session_id: _session,
    ctrader_access_token_encrypted: _access,
    ctrader_refresh_token_encrypted: _refresh,
    ctrader_token_expires_at: _expires,
    ctrader_client_id_encrypted: _clientId,
    ctrader_client_secret_encrypted: _clientSecret,
    binance_api_key_encrypted: _bnKey,
    binance_api_secret_encrypted: _bnSecret,
    bybit_api_key_encrypted: _byKey,
    bybit_api_secret_encrypted: _bySecret,
    kucoin_api_key_encrypted: _kcKey,
    kucoin_api_secret_encrypted: _kcSecret,
    kucoin_passphrase_encrypted: _kcPass,
    dxtrade_password_encrypted: _dxPassword,
    ...safe
  } = row
  return safe
}

async function encryptedAppCredentials(): Promise<Record<string, string> | null> {
  const app = ctraderAppFromEnv()
  if (!app) return null
  return {
    ctrader_client_id_encrypted: await encryptMtPasswordRequired(app.clientId, Deno.env),
    ctrader_client_secret_encrypted: await encryptMtPasswordRequired(app.clientSecret, Deno.env),
  }
}

function environmentOf(value: unknown): CtraderEnvironment {
  return String(value ?? "").trim().toLowerCase() === "live" ? "live" : "demo"
}

type ServiceClient = ReturnType<typeof createClient>

async function loadCtraderRow(supabase: ServiceClient, userId: string, rowId: string) {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", rowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.provider !== "ctrader") return null
  return data
}

async function tokensForRow(
  supabase: ServiceClient,
  row: Record<string, unknown>,
): Promise<{ accessToken: string; environment: CtraderEnvironment }> {
  const app = ctraderAppFromEnv()
  if (!app) throw new Error(CTRADER_NOT_CONFIGURED)
  const accessToken = await decryptMtPassword(String(row.ctrader_access_token_encrypted ?? ""), Deno.env)
  const refreshToken = await decryptMtPassword(String(row.ctrader_refresh_token_encrypted ?? ""), Deno.env)
  if (!accessToken) throw new Error("cTrader access token is missing")
  const expiresAt = Date.parse(String(row.ctrader_token_expires_at ?? ""))
  if (!refreshToken || !Number.isFinite(expiresAt) || expiresAt - Date.now() > 60_000) {
    return { accessToken, environment: environmentOf(row.ctrader_environment) }
  }
  const refreshed = await refreshCtraderToken({ app, refreshToken })
  const accessEncrypted = await encryptMtPasswordRequired(refreshed.accessToken, Deno.env)
  const refreshEncrypted = refreshed.refreshToken
    ? await encryptMtPasswordRequired(refreshed.refreshToken, Deno.env)
    : row.ctrader_refresh_token_encrypted
  const appCredentials = await encryptedAppCredentials()
  await supabase
    .from("broker_accounts")
    .update({
      ctrader_access_token_encrypted: accessEncrypted,
      ctrader_refresh_token_encrypted: refreshEncrypted,
      ctrader_token_expires_at: refreshed.expiresAt,
      ...(appCredentials ?? {}),
    })
    .eq("id", row.id)
    .eq("user_id", row.user_id)
  return { accessToken: refreshed.accessToken, environment: environmentOf(row.ctrader_environment) }
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
    const app = ctraderAppFromEnv()

    if (action === "start") {
      if (!app) return bad(503, CTRADER_NOT_CONFIGURED)
      const redirectUri = String(body.redirect_uri ?? "").trim()
      if (!allowedCtraderRedirect(redirectUri)) return bad(400, "Invalid cTrader redirect")
      const state = await signCtraderState(userId, app.clientSecret)
      return Response.json({
        authorize_url: ctraderAuthorizeUrl({ clientId: app.clientId, redirectUri, state }),
        state,
      }, { headers: corsHeaders })
    }

    if (action === "exchange") {
      if (!app) return bad(503, CTRADER_NOT_CONFIGURED)
      const code = String(body.code ?? "").trim()
      const redirectUri = String(body.redirect_uri ?? "").trim()
      const state = String(body.state ?? "").trim()
      if (!code) return bad(400, "cTrader code is missing")
      if (!allowedCtraderRedirect(redirectUri)) return bad(400, "Invalid cTrader redirect")
      if (state && !(await verifyCtraderState(state, userId, app.clientSecret))) {
        return bad(400, "cTrader sign-in expired. Start again.")
      }
      const tokens = await exchangeCtraderCode({ app, code, redirectUri })
      const accounts = await listCtraderAccounts(app, tokens.accessToken)
      if (accounts.length === 0) return bad(404, "No cTrader trading accounts were found")
      const handoff = await encryptMtPasswordRequired(JSON.stringify({ tokens, accounts }), Deno.env)
      return Response.json({ handoff, accounts }, { headers: corsHeaders })
    }

    if (action === "link") {
      if (!app) return bad(503, CTRADER_NOT_CONFIGURED)
      const handoff = String(body.handoff ?? "").trim()
      const accountId = String(body.account_id ?? "").trim()
      const label = String(body.label ?? "").trim()
      if (!handoff || !accountId) return bad(400, "Choose a cTrader account")
      const plain = await decryptMtPassword(handoff, Deno.env)
      if (!plain) return bad(400, "cTrader sign-in expired. Start again.")
      const parsed = JSON.parse(plain) as { tokens?: CtraderTokens; accounts?: CtraderTradingAccount[] }
      const account = (parsed.accounts ?? []).find(row => row.accountId === accountId)
      const tokens = parsed.tokens
      if (!account || !tokens?.accessToken) return bad(400, "Choose a cTrader account")

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
        .eq("ctrader_account_id", account.accountId)
        .maybeSingle()
      if (existing?.id) return bad(409, "This cTrader account is already linked")

      let trader: Record<string, unknown> = {}
      try {
        trader = await ctraderTrader({
          app,
          environment: account.environment,
          accountId: account.accountId,
          accessToken: tokens.accessToken,
        })
      } catch (error) {
        console.warn(`[ctrader-broker] trader snapshot failed: ${error instanceof Error ? error.message : error}`)
      }
      const snapshot = ctraderStatusFromTrader(trader, account.environment)
      const accessEncrypted = await encryptMtPasswordRequired(tokens.accessToken, Deno.env)
      const refreshEncrypted = tokens.refreshToken
        ? await encryptMtPasswordRequired(tokens.refreshToken, Deno.env)
        : null
      const appCredentials = await encryptedAppCredentials()
      const now = new Date().toISOString()
      const baseline = resolvePerformanceBaselineBalance(null, {
        balance: snapshot.balance,
        equity: snapshot.equity,
      })
      const { data: inserted, error } = await supabase
        .from("broker_accounts")
        .insert({
          user_id: userId,
          label: label || account.brokerName || `cTrader ${account.accountNumber ?? account.accountId}`,
          platform: "cTrader",
          provider: "ctrader",
          ctrader_account_id: account.accountId,
          ctrader_environment: account.environment,
          ctrader_access_token_encrypted: accessEncrypted,
          ctrader_refresh_token_encrypted: refreshEncrypted,
          ctrader_token_expires_at: tokens.expiresAt,
          ...(appCredentials ?? {}),
          ctrader_status: "connected",
          account_login: account.accountNumber,
          broker_name: account.brokerName,
          connection_status: "connected",
          terminal_connected: true,
          trade_allowed: snapshot.tradeAllowed,
          last_balance: snapshot.balance ?? null,
          last_equity: snapshot.equity ?? null,
          last_currency: snapshot.currency ?? null,
          last_synced_at: now,
          last_activated_at: now,
          performance_baseline_balance: baseline,
          performance_baseline_captured_at: baseline == null ? null : now,
          is_active: true,
          linked_account_type: account.live ? "Live" : "Demo",
        })
        .select("*")
        .single()
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return bad(409, "This cTrader account is already linked")
        return bad(500, error.message)
      }
      return Response.json({
        ok: true,
        account: stripSecrets(inserted as Record<string, unknown>),
        status: snapshot.status,
        healthy: snapshot.healthy,
      }, { headers: corsHeaders })
    }

    if (action === "trades") {
      if (!app) return bad(503, CTRADER_NOT_CONFIGURED)
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
        if (!listed.data || listed.data.provider !== "ctrader") {
          return bad(400, "This account is not a cTrader account.")
        }
        accounts.push(listed.data as Record<string, unknown>)
      } else {
        const listed = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("user_id", userId)
          .eq("provider", "ctrader")
          .eq("is_active", true)
        if (listed.error) return bad(500, listed.error.message)
        for (const account of listed.data ?? []) accounts.push(account as Record<string, unknown>)
      }
      const trades = []
      for (const account of accounts) {
        if (!account?.ctrader_account_id) continue
        const tokens = await tokensForRow(supabase, account as Record<string, unknown>)
        const book = await ctraderAccountTrades({
          app,
          environment: tokens.environment,
          accountId: String(account.ctrader_account_id),
          accessToken: tokens.accessToken,
          brokerId: String(account.id),
          brokerLabel: String(account.label ?? account.broker_name ?? "cTrader"),
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
    const row = await loadCtraderRow(supabase, userId, accountRowId)
    if (!row) return bad(404, "cTrader account not found")

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
        const tokens = await tokensForRow(supabase, row as Record<string, unknown>)
        const trader = await ctraderTrader({
          app: app!,
          environment: tokens.environment,
          accountId: String(row.ctrader_account_id ?? ""),
          accessToken: tokens.accessToken,
        })
        const snapshot = ctraderStatusFromTrader(trader, tokens.environment)
        const now = new Date().toISOString()
        const appCredentials = await encryptedAppCredentials()
        const patch: Record<string, unknown> = {
          ...(appCredentials ?? {}),
          ctrader_status: "connected",
          connection_status: "connected",
          terminal_connected: true,
          trade_allowed: snapshot.tradeAllowed,
          last_balance: snapshot.balance ?? row.last_balance,
          last_equity: snapshot.equity ?? row.last_equity,
          last_currency: snapshot.currency ?? row.last_currency,
          last_synced_at: now,
          connection_error: null,
          linked_account_type: tokens.environment === "live" ? "Live" : "Demo",
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
              synced: true,
            },
          }, { headers: corsHeaders })
        }
        return Response.json({
          ok: true,
          account,
          healthy: snapshot.healthy,
          status: snapshot.status,
        }, { headers: corsHeaders })
      } catch (error) {
        const message = error instanceof Error ? error.message : "cTrader status failed"
        await supabase
          .from("broker_accounts")
          .update({
            ctrader_status: "error",
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
      const tokens = await tokensForRow(supabase, row as Record<string, unknown>)
      const quote = await ctraderQuote({
        app: app!,
        environment: tokens.environment,
        accountId: String(row.ctrader_account_id ?? ""),
        accessToken: tokens.accessToken,
        symbol: String(body.symbol ?? "EURUSD"),
      })
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const tokens = await tokensForRow(supabase, row as Record<string, unknown>)
      const book = await ctraderLiveBook({
        app: app!,
        environment: tokens.environment,
        accountId: String(row.ctrader_account_id ?? ""),
        accessToken: tokens.accessToken,
      })
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
      const tokens = await tokensForRow(supabase, row as Record<string, unknown>)
      const orders = await ctraderOpenedOrders({
        app: app!,
        environment: tokens.environment,
        accountId: String(row.ctrader_account_id ?? ""),
        accessToken: tokens.accessToken,
      })
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (error) {
    if (error instanceof BrokerCredentialEncryptionError) return bad(503, error.message)
    const message = error instanceof Error ? error.message : "Internal error"
    console.error("[ctrader-broker]", message)
    const status = message === CTRADER_NOT_CONFIGURED ? 503 : 500
    return bad(status, message)
  }
})
