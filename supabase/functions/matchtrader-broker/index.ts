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
  assertPublicMatchtraderHost,
  friendlyMatchtraderError,
  matchtraderAccounts,
  matchtraderAccountTrades,
  matchtraderFingerprint,
  matchtraderLiveBook,
  matchtraderOpenedOrders,
  matchtraderPlatformDetails,
  matchtraderQuote,
  matchtraderSnapshot,
  normalizeMatchtraderUrl,
  type MatchtraderAccountRef,
  type MatchtraderCredentials,
} from "../_shared/matchtraderApi.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

/** The Match-Trader password and every other broker's secret columns stay on the server. */
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

// deno-lint-ignore no-explicit-any
type ServiceClient = any

async function loadMatchtraderRow(supabase: ServiceClient, userId: string, rowId: string) {
  const { data, error } = await supabase
    .from("broker_accounts")
    .select("*")
    .eq("id", rowId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.provider !== "matchtrader") return null
  return data
}

async function credsForRow(row: Record<string, unknown>): Promise<MatchtraderCredentials> {
  const password = await decryptMtPassword(String(row.matchtrader_password_encrypted ?? ""), Deno.env)
  const email = String(row.matchtrader_email ?? "").trim()
  const brokerId = String(row.matchtrader_broker_id ?? "").trim()
  const stored = String(row.matchtrader_server_url ?? "").trim()
  if (!password || !email || !brokerId || !stored) throw new Error("Match-Trader login could not be read")
  // Re-validate on every use: the stored URL is user supplied.
  const normalized = normalizeMatchtraderUrl(stored)
  if (!normalized.ok) throw new Error(normalized.error)
  await assertPublicMatchtraderHost(normalized.url)
  return { serverUrl: normalized.url, brokerId, email, password }
}

function refOf(row: Record<string, unknown>): MatchtraderAccountRef {
  const tradingAccountUuid = String(row.matchtrader_trading_account_uuid ?? "").trim()
  const systemUuid = String(row.matchtrader_system_uuid ?? "").trim()
  if (!tradingAccountUuid || !systemUuid) throw new Error("This Match-Trader account has no account reference")
  return { tradingAccountUuid, systemUuid }
}

/** Signal comments the worker stored per order id (Match-Trader has no comment field). */
async function loadTags(supabase: ServiceClient, accountRowId: string): Promise<Map<string, string>> {
  const tags = new Map<string, string>()
  const { data } = await supabase
    .from("matchtrader_order_tags")
    .select("order_id, comment")
    .eq("broker_account_id", accountRowId)
    .order("created_at", { ascending: false })
    .limit(2000)
  for (const row of data ?? []) tags.set(String(row.order_id), String(row.comment ?? ""))
  return tags
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
      const normalized = normalizeMatchtraderUrl(String(body.server_url ?? ""))
      if (!normalized.ok) return bad(400, normalized.error)
      const serverUrl = normalized.url
      const email = String(body.email ?? "").trim()
      const password = String(body.password ?? "")
      const label = String(body.label ?? "").trim()
      const requestedId = String(body.account_id_ref ?? "").trim()
      let brokerId = String(body.broker_id ?? "").trim()
      if (!email || !password) return bad(400, "Enter your Match-Trader email and password")
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(400, "Enter a valid Match-Trader email")
      if (email.length > 200 || password.length > 256 || brokerId.length > 64 || requestedId.length > 100) {
        return bad(400, "That login is too long")
      }
      if (/[\u0000-\u001f\u007f]/.test(brokerId) || /[\u0000-\u001f\u007f]/.test(requestedId)) {
        return bad(400, "That broker id is not valid")
      }

      const sub = await loadUserSubscription(supabase, userId)
      const limitDenied = await assertBrokerAccountLimit(supabase, userId, sub)
      if (limitDenied) {
        const payload = await limitDenied.json().catch(() => ({ error: "Broker account limit reached" })) as { error?: string }
        return bad(limitDenied.status, payload.error ?? "Broker account limit reached")
      }

      let brokerName = ""
      try {
        await assertPublicMatchtraderHost(serverUrl)
        const details = await matchtraderPlatformDetails(serverUrl)
        brokerName = details.brokerName
        if (!brokerId) brokerId = details.brokerId
      } catch (error) {
        // An explicit broker id lets a platform that hides platform-details still link.
        if (!brokerId) return bad(400, friendlyMatchtraderError(error))
        try {
          await assertPublicMatchtraderHost(serverUrl)
        } catch (hostError) {
          return bad(400, friendlyMatchtraderError(hostError))
        }
      }

      const creds: MatchtraderCredentials = { serverUrl, brokerId, email, password }
      let accounts
      try {
        accounts = await matchtraderAccounts(creds)
      } catch (error) {
        return bad(400, friendlyMatchtraderError(error))
      }
      if (!accounts.length) return bad(400, "This Match-Trader login has no trading accounts")

      const describe = (item: { tradingAccountId: string; uuid: string }) => item.tradingAccountId || item.uuid
      let chosen = requestedId
        ? accounts.find(item => item.uuid === requestedId || item.tradingAccountId === requestedId)
        : undefined
      if (requestedId && !chosen) {
        return bad(400, `Account ${requestedId} was not found on this login. Available: ${accounts.map(describe).join(", ")}`)
      }
      if (!chosen) {
        if (accounts.length > 1) {
          return bad(400, `This login has several accounts (${accounts.map(item => `#${describe(item)}`).join(", ")}). Enter the account number to link.`)
        }
        chosen = accounts[0]
      }

      const fingerprint = await matchtraderFingerprint(serverUrl, brokerId, email, chosen.uuid)
      const { data: existing } = await supabase
        .from("broker_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("matchtrader_account_id", fingerprint)
        .maybeSingle()
      if (existing?.id) return bad(409, "This Match-Trader account is already linked")

      const ref: MatchtraderAccountRef = { tradingAccountUuid: chosen.uuid, systemUuid: chosen.systemUuid }
      let snapshot
      try {
        snapshot = await matchtraderSnapshot(creds, ref, { demo: chosen.demo, brokerName: brokerName || undefined })
      } catch (error) {
        return bad(400, friendlyMatchtraderError(error))
      }

      const passwordEncrypted = await encryptMtPasswordRequired(password, Deno.env)
      const now = new Date().toISOString()
      const baseline = resolvePerformanceBaselineBalance(null, {
        balance: snapshot.balance,
        equity: snapshot.equity,
      })
      const host = new URL(serverUrl).hostname
      const { data: inserted, error } = await supabase
        .from("broker_accounts")
        .insert({
          user_id: userId,
          label: label || `MatchTrader #${describe(chosen)}`,
          platform: "MatchTrader",
          provider: "matchtrader",
          matchtrader_account_id: fingerprint,
          matchtrader_server_url: serverUrl,
          matchtrader_broker_id: brokerId,
          matchtrader_email: email,
          matchtrader_password_encrypted: passwordEncrypted,
          matchtrader_trading_account_uuid: chosen.uuid,
          matchtrader_system_uuid: chosen.systemUuid,
          matchtrader_status: "connected",
          broker_name: brokerName || host,
          connection_status: "connected",
          terminal_connected: true,
          trade_allowed: snapshot.canTrade,
          last_balance: snapshot.balance ?? null,
          last_equity: snapshot.equity ?? null,
          last_currency: snapshot.currency || chosen.currency,
          last_synced_at: now,
          last_activated_at: now,
          performance_baseline_balance: baseline,
          performance_baseline_captured_at: baseline == null ? null : now,
          is_active: true,
          linked_account_type: chosen.demo ? "Demo" : "Live",
        })
        .select("*")
        .single()
      if (error) {
        if (/duplicate|unique/i.test(error.message)) return bad(409, "This Match-Trader account is already linked")
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
        if (!listed.data || listed.data.provider !== "matchtrader") {
          return bad(400, "This account is not a Match-Trader account.")
        }
        accounts.push(listed.data as Record<string, unknown>)
      } else {
        const listed = await supabase
          .from("broker_accounts")
          .select("*")
          .eq("user_id", userId)
          .eq("provider", "matchtrader")
          .eq("is_active", true)
        if (listed.error) return bad(500, listed.error.message)
        for (const account of listed.data ?? []) accounts.push(account as Record<string, unknown>)
      }
      const trades = []
      for (const account of accounts) {
        if (!account?.matchtrader_account_id) continue
        const creds = await credsForRow(account)
        const book = await matchtraderAccountTrades({
          creds,
          ref: refOf(account),
          brokerId: String(account.id),
          brokerLabel: String(account.label ?? account.broker_name ?? "MatchTrader"),
          brokerName: account.broker_name == null ? null : String(account.broker_name),
          historyFrom,
          historyTo,
          scope,
          tags: await loadTags(supabase, String(account.id)),
        })
        trades.push(...book)
      }
      return Response.json({ ok: true, trades }, { headers: corsHeaders })
    }

    const accountRowId = String(body.account_id ?? "").trim()
    if (!accountRowId) return bad(400, "account_id required")
    const row = await loadMatchtraderRow(supabase, userId, accountRowId)
    if (!row) return bad(404, "Match-Trader account not found")

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
        const snapshot = await matchtraderSnapshot(creds, refOf(row as Record<string, unknown>), {
          demo: row.linked_account_type === "Demo" ? true : row.linked_account_type === "Live" ? false : undefined,
          brokerName: row.broker_name == null ? undefined : String(row.broker_name),
        })
        const now = new Date().toISOString()
        const patch: Record<string, unknown> = {
          matchtrader_status: "connected",
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
        const message = friendlyMatchtraderError(error)
        await supabase
          .from("broker_accounts")
          .update({
            matchtrader_status: "error",
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
      const quote = await matchtraderQuote(creds, refOf(row as Record<string, unknown>), String(body.symbol ?? "EURUSD"))
      return Response.json({ ok: true, quote }, { headers: corsHeaders })
    }

    if (action === "live_snapshot") {
      const creds = await credsForRow(row as Record<string, unknown>)
      const book = await matchtraderLiveBook(creds, refOf(row as Record<string, unknown>))
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
      const orders = await matchtraderOpenedOrders(
        creds,
        refOf(row as Record<string, unknown>),
        await loadTags(supabase, accountRowId),
      )
      return Response.json({ ok: true, orders }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (error) {
    if (error instanceof BrokerCredentialEncryptionError) return bad(503, error.message)
    const message = friendlyMatchtraderError(error)
    console.error("[matchtrader-broker]", message)
    return bad(500, message)
  }
})
