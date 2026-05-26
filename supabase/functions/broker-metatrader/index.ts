import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { inferBrokerLabel } from "../_shared/brokerLabel.ts"
import { accountTodaysProfitFromBalance, resolveDayStartBalance } from "../_shared/dayStartBalance.ts"
import {
  clearStoredMtPassword,
  isLegacyBrokerLink,
  keepBrokerSessionAlive,
  makeMtClient,
  markBrokerConnectionError,
  parseBrokerSessionId,
  reconnectBrokerSession,
  stripBrokerSecretFields,
} from "../_shared/brokerSession.ts"
import { encryptMtPassword } from "../_shared/brokerCredentialsCrypto.ts"
import { friendlyBrokerConnectError, isMtBridgeGlitchMessage, isSessionDropMessage } from "../_shared/brokerConnectError.ts"
import { withMtServerSessionLock } from "../_shared/mtServerSessionLock.ts"
import {
  isMtApiAuthConfigured,
  makeClientFromEnv,
  MetatraderApiError,
  type MtPlatform,
} from "../_shared/metatraderapi.ts"
import {
  adjustMtTradesPositionDirection,
  flattenMtOrder,
  pickMtField,
  reconcileTradeDirectionWithStops,
  resolveMtDealProfit,
  resolveMtLots,
  type MtHistoryProfile,
} from "../_shared/mtTradeFields.ts"
import {
  assertBrokerAccountLimit,
  loadUserSubscription,
} from "../_shared/subscriptionAccess.ts"

function mtClient(env: { get(name: string): string | undefined }, platform: string): ReturnType<typeof makeClientFromEnv> {
  const p: MtPlatform = platform === "MT4" ? "MT4" : "MT5"
  return makeClientFromEnv(env, p)
}

function parseCalendarDay(raw: unknown): string | null {
  const s = String(raw ?? "").trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function parseTimezoneOffsetMinutes(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const PLATFORMS = new Set(["MT4", "MT5"])

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

function ensureMtApiConfigured(env: { get(name: string): string | undefined }): void {
  if (!isMtApiAuthConfigured(env)) {
    throw new MetatraderApiError(
      "MT API is not configured on the server. Set MT4API_BASIC_USER + MT4API_BASIC_PASSWORD (plain text from support) in Supabase Edge secrets, then redeploy broker-metatrader.",
      503,
    )
  }
}

/** Turn mt4api.dev HTTP statuses into actionable UI copy. */
function friendlyMtApiError(e: MetatraderApiError): MetatraderApiError {
  const raw = e.message.trim()
  if (e.status === 401 || /^unauthorized$/i.test(raw)) {
    return new MetatraderApiError(
      "MT API rejected the request (missing or invalid Basic Auth). Set MT4API_BASIC_USER and MT4API_BASIC_PASSWORD in Supabase Edge secrets — these are your mt4api.dev API credentials, not your MT5 login.",
      e.status,
      e.code,
    )
  }
  if (e.status === 403 || /^forbidden$/i.test(raw)) {
    return new MetatraderApiError(
      "MT API rejected the API credentials (Forbidden). Check MT4API_BASIC_USER and MT4API_BASIC_PASSWORD in Supabase Edge secrets match what mt4api.dev support gave you. Do not use your MT5 account login here, and do not use the old METATRADERAPI_KEY.",
      e.status,
      e.code,
    )
  }
  return e
}

/**
 * Account lifecycle for MetatraderAPI. Trade execution is NOT here — it lives in the
 * worker process for minimum latency. This function only runs for the rare UI-driven
 * register / delete / refresh balance / check connection calls, plus the trades read
 * for the Trades page.
 */
const BUILD_TAG = "broker-metatrader@summary-stale-v2"

type SummaryBrokerRow = {
  last_balance?: number | null
  last_equity?: number | null
  last_currency?: string | null
  performance_baseline_balance?: number | null
  day_start_balance?: number | null
  day_start_balance_on?: string | null
  last_synced_at?: string | null
  connection_status?: string | null
}

function staleSummaryResponse(
  broker: SummaryBrokerRow,
  calendarDay: string,
  msg: string,
): Response {
  const friendly = friendlyBrokerConnectError(msg)
  return Response.json(
    {
      ok: false,
      stale: true,
      summary: {
        balance: broker.last_balance ?? undefined,
        equity: broker.last_equity ?? undefined,
        currency: broker.last_currency ?? undefined,
      },
      open_positions: null,
      performance_baseline_balance: broker.performance_baseline_balance ?? null,
      day_start_balance: broker.day_start_balance ?? null,
      day_start_balance_on: broker.day_start_balance_on ?? null,
      todays_profit_from_balance: null,
      connection_status: broker.connection_status ?? "connected",
      message: friendly,
    },
    { status: 200, headers: corsHeaders },
  )
}

function shouldReturnStaleSummary(msg: string): boolean {
  return isSessionDropMessage(msg)
    || isMtBridgeGlitchMessage(msg)
    || /accountsummary returned no data/i.test(msg)
}

function shouldMarkSummaryConnectionError(msg: string): boolean {
  if (isMtBridgeGlitchMessage(msg)) return false
  return isSessionDropMessage(msg)
    || /not connected|session expired|broker session/i.test(msg)
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
    const action = String((body as Record<string, unknown>).action ?? "")
    if (!action) return bad(400, "action required")

    if (action === "register") {
      ensureMtApiConfigured(Deno.env)
      const platform = String((body as Record<string, unknown>).platform ?? "MT5").toUpperCase()
      if (!PLATFORMS.has(platform)) return bad(400, "platform must be MT4 or MT5")
      const client = mtClient(Deno.env, platform)
      const server = String((body as Record<string, unknown>).server ?? "").trim()
      const login = String((body as Record<string, unknown>).login ?? "").trim()
      const password = String((body as Record<string, unknown>).password ?? "")
      const label = String((body as Record<string, unknown>).label ?? "").trim()
      const channelIds = Array.isArray((body as Record<string, unknown>).signal_channel_ids)
        ? ((body as Record<string, unknown>).signal_channel_ids as unknown[]).map(String)
        : []

      if (!server) return bad(400, "server required")
      if (!login) return bad(400, "login required")
      if (!password) return bad(400, "password required")
      const rememberPassword = Boolean((body as Record<string, unknown>).remember_password)

      const { data: duplicateLogin } = await supabase
        .from("broker_accounts")
        .select("id,label")
        .eq("user_id", userId)
        .eq("account_login", login)
        .eq("broker_server", server)
        .maybeSingle()
      if (duplicateLogin) {
        return bad(
          409,
          `This MT login is already linked as "${duplicateLogin.label}". Remove that account first or use Reconnect — linking the same login twice causes session conflicts.`,
        )
      }

      const sub = await loadUserSubscription(supabase, userId)
      const denied = await assertBrokerAccountLimit(supabase, userId, sub)
      if (denied) {
        const payload = await denied.json() as { error?: string }
        return bad(denied.status, String(payload.error ?? "Forbidden"))
      }

      const brokerName = inferBrokerLabel(server)
      const displayLabel = label || `${platform} • ${login}`
      const sessionId = crypto.randomUUID()
      let uuid: string
      try {
        uuid = await withMtServerSessionLock(platform, server, () =>
          client.connectEx({
            id: sessionId,
            server,
            login,
            password,
          })
        )
      } catch (e) {
        const raw = e instanceof MetatraderApiError ? e.message : e instanceof Error ? e.message : "Connect failed"
        return bad(400, friendlyBrokerConnectError(raw))
      }
      if (!uuid) return bad(502, "MetatraderAPI did not return a session id")

      // After ConnectEx the session needs a moment to authenticate
      // before /AccountSummary returns real numbers. CheckConnect both
      // waits for the connection and triggers a reconnect if needed, and
      // we retry the summary a few times with backoff in case the first
      // call lands before the broker server replies with account state.
      let summary: Awaited<ReturnType<typeof client.accountSummary>> | null = null
      try { await client.checkConnect(uuid) } catch { /* swallow */ }
      for (let i = 0; i < 5; i++) {
        try {
          const s = await client.accountSummary(uuid)
          if (s && (s.balance != null || s.equity != null || s.currency)) {
            summary = s
            break
          }
        } catch { /* swallow and retry */ }
        await new Promise(r => setTimeout(r, 600 + i * 400))
      }

      const insertPayload: Record<string, unknown> = {
        user_id: userId,
        label: displayLabel,
        platform,
        metaapi_account_id: uuid,
        broker_server: server,
        account_login: login,
        broker_name: brokerName,
        connection_status: "connected" as const,
        copier_mode: "manual" as const,
        signal_channel_ids: channelIds,
        enforce_signal_channel_filter: channelIds.length > 0,
        ai_settings: {},
        manual_settings: {},
        default_lot_size: 0.01,
        pip_tolerance: 20,
        max_trades_per_zone: 1,
        is_active: true,
        last_balance: summary?.balance ?? null,
        last_equity: summary?.equity ?? null,
        last_currency: summary?.currency ?? null,
        last_synced_at: summary ? new Date().toISOString() : null,
        performance_baseline_balance: summary?.balance ?? null,
        day_start_balance: summary?.balance ?? null,
        day_start_balance_on: summary?.balance != null
          ? new Date().toISOString().slice(0, 10)
          : null,
      }
      if (rememberPassword) {
        const enc = await encryptMtPassword(password, Deno.env)
        if (enc) {
          insertPayload.mt_password_encrypted = enc
          insertPayload.auto_reconnect_enabled = true
          insertPayload.password_updated_at = new Date().toISOString()
        }
      }

      const { data: row, error: insErr } = await supabase
        .from("broker_accounts")
        .insert(insertPayload)
        .select("*")
        .single()
      if (insErr) {
        // Roll back the MetatraderAPI side so we don't orphan accounts.
        try { await client.deleteAccount(uuid) } catch { /* swallow */ }
        return bad(500, insErr.message)
      }

      // Make sure the server we just used is remembered for the typeahead next time.
      try {
        await supabase
          .from("mt_servers")
          .upsert(
            {
              server_name: server,
              platform,
              source: "learned",
              broker_label: brokerName || null,
              is_active: true,
            },
            { onConflict: "server_name_normalized" },
          )
      } catch { /* non-fatal */ }

      return Response.json(
        { ok: true, broker: stripBrokerSecretFields(row as Record<string, unknown>), summary },
        { headers: corsHeaders },
      )
    }

    if (action === "delete") {
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")

      const { data: broker } = await supabase
        .from("broker_accounts")
        .select("id,user_id,metaapi_account_id,platform")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")

      const uuid = String(broker.metaapi_account_id ?? "").trim()
      const platform = String(broker.platform ?? "MT5")

      // Remove the row first so the UI/realtime updates immediately; MT disconnect
      // can hang on a dead session and must not block account removal.
      const { error: delErr } = await supabase
        .from("broker_accounts")
        .delete()
        .eq("id", brokerId)
        .eq("user_id", userId)
      if (delErr) return bad(500, delErr.message)

      if (uuid && !uuid.includes("|")) {
        const client = mtClient(Deno.env, platform)
        void Promise.race([
          client.disconnect(uuid),
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error("disconnect timeout")), 8_000)
          }),
        ]).catch(() => { /* best-effort */ })
      }

      return Response.json({ ok: true }, { headers: corsHeaders })
    }

    if (action === "summary") {
      ensureMtApiConfigured(Deno.env)
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")
      const calendarDay =
        parseCalendarDay((body as Record<string, unknown>).calendar_day) ??
        new Date().toISOString().slice(0, 10)
      const timezoneOffsetMinutes = parseTimezoneOffsetMinutes(
        (body as Record<string, unknown>).timezone_offset_minutes,
      )
      const { data: broker } = await supabase
        .from("broker_accounts")
        .select(
          "id,metaapi_account_id,performance_baseline_balance,platform,last_balance,last_equity,last_currency,connection_status,day_start_balance,day_start_balance_on,last_synced_at",
        )
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")
      const uuid = parseBrokerSessionId(broker.metaapi_account_id)
      if (!uuid) {
        return bad(
          400,
          isLegacyBrokerLink(broker.metaapi_account_id)
            ? "This account uses the legacy link format. Remove it and connect again with your MT login and password."
            : "Broker is not linked to MetatraderAPI yet",
        )
      }
      const client = mtClient(Deno.env, String(broker.platform ?? "MT5"))

      try {
        const alive = await keepBrokerSessionAlive(client, uuid)
        if (!alive) {
          return staleSummaryResponse(broker, calendarDay, "Broker session is not connected")
        }
        let summary: Awaited<ReturnType<typeof client.accountSummary>> | null = null
        let lastErr: unknown = null
        for (let i = 0; i < 3; i++) {
          try {
            const s = await client.accountSummary(uuid)
            if (s && (s.balance != null || s.equity != null || s.currency)) {
              summary = s
              break
            }
          } catch (err) { lastErr = err }
          await new Promise(r => setTimeout(r, 400 + i * 400))
        }
        if (!summary) {
          const failMsg = lastErr instanceof Error
            ? lastErr.message
            : lastErr instanceof MetatraderApiError
              ? lastErr.message
              : "AccountSummary returned no data"
          if (shouldReturnStaleSummary(failMsg)) {
            return staleSummaryResponse(broker, calendarDay, failMsg)
          }
          if (lastErr instanceof MetatraderApiError) throw lastErr
          throw new Error(failMsg)
        }
        let openPositions: number | null = null
        try {
          const orders = await client.openedOrders(uuid)
          openPositions = Array.isArray(orders) ? orders.length : 0
        } catch {
          openPositions = null
        }
        const updatePayload: Record<string, unknown> = {
          last_balance: summary?.balance ?? null,
          last_equity: summary?.equity ?? null,
          last_currency: summary?.currency ?? null,
          last_synced_at: new Date().toISOString(),
          connection_status: "connected",
        }
        if (
          broker?.performance_baseline_balance == null &&
          summary?.balance != null &&
          Number.isFinite(summary.balance)
        ) {
          updatePayload.performance_baseline_balance = summary.balance
        }
        let dayStartBalance =
          broker?.day_start_balance != null ? Number(broker.day_start_balance) : null
        let dayStartOn = broker?.day_start_balance_on
          ? String(broker.day_start_balance_on).slice(0, 10)
          : null
        if (summary?.balance != null && Number.isFinite(summary.balance)) {
          const roll = resolveDayStartBalance({
            calendarDay,
            currentBalance: summary.balance,
            storedDay: dayStartOn,
            storedStart: dayStartBalance,
            lastBalance: broker?.last_balance != null ? Number(broker.last_balance) : null,
            lastSyncedAt: broker?.last_synced_at ?? null,
            timezoneOffsetMinutes,
          })
          if (roll.rolled) {
            updatePayload.day_start_balance = roll.dayStartBalance
            updatePayload.day_start_balance_on = roll.dayStartOn
          }
          dayStartBalance = roll.dayStartBalance
          dayStartOn = roll.dayStartOn
        }
        const { data: updatedRow, error: updErr } = await supabase
          .from("broker_accounts")
          .update(updatePayload)
          .eq("id", brokerId)
          .eq("user_id", userId)
          .select("performance_baseline_balance,day_start_balance,day_start_balance_on")
          .maybeSingle()
        if (updErr) throw new Error(updErr.message)
        const resolvedDayStart =
          updatedRow?.day_start_balance != null
            ? Number(updatedRow.day_start_balance)
            : dayStartBalance
        const resolvedDayOn = updatedRow?.day_start_balance_on
          ? String(updatedRow.day_start_balance_on).slice(0, 10)
          : dayStartOn
        const todaysProfitFromBalance = accountTodaysProfitFromBalance(
          summary?.balance ?? null,
          resolvedDayStart,
          resolvedDayOn,
          calendarDay,
        )
        return Response.json(
          {
            ok: true,
            summary,
            open_positions: openPositions,
            performance_baseline_balance: updatedRow?.performance_baseline_balance ?? null,
            day_start_balance: resolvedDayStart,
            day_start_balance_on: resolvedDayOn,
            todays_profit_from_balance: todaysProfitFromBalance,
          },
          { headers: corsHeaders },
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : "AccountSummary failed"
        if (shouldMarkSummaryConnectionError(msg)) {
          await markBrokerConnectionError(supabase, { id: brokerId, user_id: userId }, msg)
        }
        if (shouldReturnStaleSummary(msg)) {
          return staleSummaryResponse(broker, calendarDay, msg)
        }
        const status = e instanceof MetatraderApiError ? e.status : 502
        return bad(
          status >= 400 && status < 600 ? status : 502,
          friendlyBrokerConnectError(msg),
        )
      }
    }

    if (action === "reconnect") {
      ensureMtApiConfigured(Deno.env)
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")
      const password = String((body as Record<string, unknown>).password ?? "").trim()
      const rememberPasswordRaw = (body as Record<string, unknown>).remember_password
      const rememberPassword = rememberPasswordRaw === undefined
        ? undefined
        : Boolean(rememberPasswordRaw)
      const { data: broker } = await supabase
        .from("broker_accounts")
        .select("id,user_id,metaapi_account_id,platform,account_login,broker_server,performance_baseline_balance,auto_reconnect_enabled,mt_password_encrypted")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")
      const client = makeMtClient(Deno.env, String(broker.platform ?? "MT5"))
      const result = await reconnectBrokerSession(client, supabase, broker, {
        password: password || undefined,
        remember_password: rememberPassword,
        env: Deno.env,
      })
      if (!result.ok) {
        return Response.json(
          { ok: false, ...result },
          { status: 200, headers: corsHeaders },
        )
      }
      return Response.json({ ok: true, ...result }, { headers: corsHeaders })
    }

    if (action === "clear_stored_credentials") {
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")
      const { data: broker } = await supabase
        .from("broker_accounts")
        .select("id")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")
      await clearStoredMtPassword(supabase, brokerId, userId)
      const { data: row } = await supabase
        .from("broker_accounts")
        .select("*")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      return Response.json(
        { ok: true, broker: row ? stripBrokerSecretFields(row as Record<string, unknown>) : null },
        { headers: corsHeaders },
      )
    }

    if (action === "check") {
      ensureMtApiConfigured(Deno.env)
      const brokerId = String((body as Record<string, unknown>).broker_id ?? "")
      if (!brokerId) return bad(400, "broker_id required")
      const { data: broker } = await supabase
        .from("broker_accounts")
        .select("id,metaapi_account_id,platform")
        .eq("id", brokerId)
        .eq("user_id", userId)
        .maybeSingle()
      if (!broker) return bad(404, "Broker account not found")
      const uuid = parseBrokerSessionId(broker.metaapi_account_id)
      if (!uuid) {
        return bad(
          400,
          isLegacyBrokerLink(broker.metaapi_account_id)
            ? "This account uses the legacy link format. Remove it and connect again with your MT login and password."
            : "Broker is not linked to MetatraderAPI yet",
        )
      }
      const client = mtClient(Deno.env, String(broker.platform ?? "MT5"))

      try {
        const alive = await keepBrokerSessionAlive(client, uuid)
        if (!alive) {
          return Response.json(
            {
              ok: false,
              result: "disconnected",
              message: "Broker session is not connected",
            },
            { status: 200, headers: corsHeaders },
          )
        }
        return Response.json({ ok: true, result: "connected" }, { headers: corsHeaders })
      } catch (e) {
        const msg = e instanceof Error ? e.message : "CheckConnect failed"
        if (isSessionDropMessage(msg)) {
          return Response.json(
            {
              ok: false,
              result: "disconnected",
              message: friendlyBrokerConnectError(msg),
            },
            { status: 200, headers: corsHeaders },
          )
        }
        const status = e instanceof MetatraderApiError ? e.status : 502
        if (status === 502 || status === 503 || status === 504) {
          return Response.json(
            {
              ok: false,
              result: "disconnected",
              message: friendlyBrokerConnectError(msg),
            },
            { status: 200, headers: corsHeaders },
          )
        }
        return bad(status >= 400 && status < 600 ? status : 502, friendlyBrokerConnectError(msg))
      }
    }

    if (action === "trades") {
      const bodyRec = body as Record<string, unknown>
      const brokerId = String(bodyRec.broker_id ?? "").trim()
      const scope = String(bodyRec.scope ?? "all").toLowerCase()
      const wantOpen = scope === "all" || scope === "open"
      const wantClosed = scope === "all" || scope === "closed"
      const formatMtDt = (d: Date) => d.toISOString().slice(0, 19)
      const historyTo = typeof bodyRec.history_to === "string" && bodyRec.history_to.trim()
        ? String(bodyRec.history_to).trim()
        : formatMtDt(new Date())
      const defaultHistoryFrom = new Date()
      defaultHistoryFrom.setDate(defaultHistoryFrom.getDate() - 90)
      const historyFrom = typeof bodyRec.history_from === "string" && bodyRec.history_from.trim()
        ? String(bodyRec.history_from).trim()
        : formatMtDt(defaultHistoryFrom)
      const historyProfile: MtHistoryProfile =
        bodyRec.history_profile === "trades" ? "trades" : "dashboard"
      const limitRaw = Number(bodyRec.limit ?? 0)
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(Math.floor(limitRaw), 500)
          : 0
      let effectiveHistoryFrom = historyFrom
      if (limit > 0) {
        const cap = new Date()
        cap.setDate(cap.getDate() - 7)
        const capStr = formatMtDt(cap)
        if (effectiveHistoryFrom < capStr) effectiveHistoryFrom = capStr
      } else if (historyProfile === "dashboard") {
        const cap = new Date()
        cap.setDate(cap.getDate() - 120)
        const capStr = formatMtDt(cap)
        if (effectiveHistoryFrom < capStr) effectiveHistoryFrom = capStr
      }
      const brokerTradesTimeoutMs = limit > 0 ? 18_000 : 45_000
      type RawOrder = Record<string, unknown>

      let brokers: { id: string; label: string; metaapi_account_id: string; broker_name: string | null; platform: string }[] = []
      if (brokerId) {
        const { data } = await supabase
          .from("broker_accounts")
          .select("id,label,metaapi_account_id,broker_name,platform")
          .eq("id", brokerId)
          .eq("user_id", userId)
          .maybeSingle()
        if (!data) return bad(404, "Broker account not found")
        brokers = [data as typeof brokers[number]]
      } else {
        const { data } = await supabase
          .from("broker_accounts")
          .select("id,label,metaapi_account_id,broker_name,platform")
          .eq("user_id", userId)
          .eq("is_active", true)
        brokers = ((data ?? []) as typeof brokers)
      }

      const num = (v: unknown): number | null => {
        if (v === null || v === undefined) return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }

      const pick = (order: RawOrder, ...keys: string[]): unknown =>
        pickMtField(order, historyProfile, ...keys)

      // MT order code → direction + label. MT4 CMD 6 = balance; MT5 OrderType 6 = buy stop limit.
      const codeMapMt5: Record<number, { direction: "buy" | "sell" | ""; label: string }> = {
        0: { direction: "buy", label: "Buy" },
        1: { direction: "sell", label: "Sell" },
        2: { direction: "buy", label: "Buy Limit" },
        3: { direction: "sell", label: "Sell Limit" },
        4: { direction: "buy", label: "Buy Stop" },
        5: { direction: "sell", label: "Sell Stop" },
        6: { direction: "buy", label: "Buy Stop Limit" },
        7: { direction: "sell", label: "Sell Stop Limit" },
        8: { direction: "", label: "Close By" },
      }
      const codeMapMt4: Record<number, { direction: "buy" | "sell" | ""; label: string }> = {
        ...codeMapMt5,
        6: { direction: "", label: "Balance" },
      }

      const fromString = (raw: string): { direction: "buy" | "sell" | ""; label: string } | null => {
        const cleaned = raw.replace(/^(OrderType_|DealType_|DEAL_TYPE_|ORDER_TYPE_)/i, "").trim()
        if (!cleaned) return null
        const lower = cleaned.toLowerCase()
        const direction: "buy" | "sell" | "" =
          lower.startsWith("buy") ? "buy" : lower.startsWith("sell") ? "sell" : ""
        const label = cleaned.replace(/([a-z])([A-Z])/g, "$1 $2")
        return { direction, label }
      }

      const resolveDirection = (
        order: RawOrder,
        platform: string,
      ): { direction: "buy" | "sell" | ""; type_label: string } => {
        // Try every known string-typed field name first.
        const stringCandidate = pick(
          order,
          "type", "Type",
          "orderType", "OrderType",
          "dealType", "DealType",
          "cmdString",
          "action", "Action",
        )
        if (typeof stringCandidate === "string" && stringCandidate.trim()) {
          const parsed = fromString(stringCandidate)
          if (parsed) return { direction: parsed.direction, type_label: parsed.label }
        }
        // Then try numeric-typed fields and any nested 'ex.cmd'.
        const ex = order.ex as Record<string, unknown> | undefined
        const numericCandidate = pick(
          order,
          "type", "Type",
          "orderType", "OrderType",
          "dealType", "DealType",
          "cmd", "Cmd",
        )
        const numericFromEx = ex ? pick(ex, "cmd", "Cmd", "OrderType", "orderType") : undefined
        const candidate =
          typeof numericCandidate === "number"
            ? numericCandidate
            : typeof numericFromEx === "number"
              ? numericFromEx
              : undefined
        const codeMap = platform.toUpperCase() === "MT4" ? codeMapMt4 : codeMapMt5
        if (typeof candidate === "number" && codeMap[candidate]) {
          const m = codeMap[candidate]
          return { direction: m.direction, type_label: m.label }
        }
        return { direction: "", type_label: "" }
      }

      const isNonTradeEntry = (direction: string, typeLabel: string, lotSize: number): boolean => {
        const type = typeLabel.toLowerCase()
        if (
          type.includes("balance") ||
          type.includes("credit") ||
          type.includes("deposit") ||
          type.includes("withdraw") ||
          type.includes("correction") ||
          type.includes("transfer")
        ) {
          return true
        }
        return direction === "" && lotSize <= 0
      }

      const normalize = (
        order: RawOrder,
        broker: typeof brokers[number],
        status: "open" | "closed",
      ) => {
        const row = historyProfile === "trades" ? flattenMtOrder(order, "trades") : order
        const ticket = Number(pick(row, "ticket", "Ticket") ?? 0)
        const platform = String(broker.platform ?? "MT5")
        const resolved = resolveDirection(row, platform)
        const adjusted =
          status === "closed" && historyProfile === "trades"
            ? adjustMtTradesPositionDirection(order, historyProfile, resolved)
            : resolved
        const lot_size = resolveMtLots(row, historyProfile)
        const entry_price = num(pick(row, "openPrice", "OpenPrice", "price"))
        const sl = num(pick(row, "stopLoss", "StopLoss", "sl"))
        const tp = num(pick(row, "takeProfit", "TakeProfit", "tp"))
        const { direction, type_label } = reconcileTradeDirectionWithStops(
          adjusted.direction,
          entry_price,
          sl,
          tp,
        )
        const openTime = pick(
          row,
          "openTime", "OpenTime", "open_time", "timeOpen", "TimeOpen",
        ) as string | undefined
        const closeTime = pick(
          row,
          "closeTime", "CloseTime", "close_time", "timeClose", "TimeClose", "doneTime", "DoneTime",
        ) as string | undefined
        return {
          id: `${broker.id}:${ticket}`,
          broker_id: broker.id,
          broker_label: broker.label,
          broker_name: broker.broker_name,
          ticket,
          symbol: String(pick(row, "symbol", "Symbol") ?? ""),
          direction,
          type: type_label,
          lot_size,
          entry_price,
          sl,
          tp,
          close_price: num(pick(row, "closePrice", "ClosePrice")),
          profit: isNonTradeEntry(direction, type_label, lot_size)
            ? null
            : resolveMtDealProfit(row, historyProfile),
          swap: num(pick(row, "swap", "Swap")),
          commission: num(pick(row, "commission", "Commission")),
          comment: (pick(row, "comment", "Comment") as string | undefined) ?? null,
          magic: num(pick(row, "magicNumber", "MagicNumber", "magic", "Magic", "expertId", "ExpertId")),
          opened_at: openTime ?? null,
          closed_at: closeTime ?? null,
          state: (pick(row, "state", "State") as string | undefined) ?? null,
          status,
        }
      }

      let firstRawSample: RawOrder | null = null
      const fetchBrokerTrades = async (b: typeof brokers[number]): Promise<ReturnType<typeof normalize>[]> => {
        const uuid = String(b.metaapi_account_id ?? "").trim()
        if (!uuid || uuid.includes("|")) return []
        const bClient = mtClient(Deno.env, String(b.platform ?? "MT5"))
        try { await bClient.keepSessionAlive(uuid) } catch { /* best-effort */ }
        const closedHistory = limit > 0
          ? bClient.closedOrdersHistoryLite(uuid, effectiveHistoryFrom, historyTo, historyProfile, 2, 200)
          : bClient.closedOrdersHistory(uuid, effectiveHistoryFrom, historyTo, historyProfile)
        const [openedRes, closedRes] = await Promise.allSettled([
          wantOpen ? bClient.openedOrders(uuid) : Promise.resolve([] as unknown[]),
          wantClosed ? closedHistory : Promise.resolve([] as unknown[]),
        ])
        const out: ReturnType<typeof normalize>[] = []
        if (openedRes.status === "fulfilled" && Array.isArray(openedRes.value)) {
          for (const o of openedRes.value as RawOrder[]) {
            if (!firstRawSample) firstRawSample = o
            out.push(normalize(o, b, "open"))
          }
        }
        if (closedRes.status === "fulfilled" && Array.isArray(closedRes.value)) {
          for (const o of closedRes.value as RawOrder[]) {
            if (!firstRawSample) firstRawSample = o
            out.push(normalize(o, b, "closed"))
          }
        }
        return out
      }

      const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
        Promise.race([
          promise,
          new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
        ])

      const tradesByBroker = await Promise.all(
        brokers.map((b) => withTimeout(fetchBrokerTrades(b), brokerTradesTimeoutMs, [])),
      )
      const trades = tradesByBroker.flat().sort((a, b) => {
        const at = a.status === "closed" ? (a.closed_at ?? a.opened_at) : a.opened_at
        const bt = b.status === "closed" ? (b.closed_at ?? b.opened_at) : b.opened_at
        const av = at ? Date.parse(at) : 0
        const bv = bt ? Date.parse(bt) : 0
        return bv - av
      }).slice(0, limit > 0 ? limit : undefined)
      // When at least one trade is missing direction, echo back the raw shape so the
      // client can show the diagnostic and we can extend the parser if needed.
      const hasMissingDirection = trades.some((t) => !t.direction)
      const hasSparseClosed = trades.some(
        (t) =>
          t.status === "closed" &&
          Boolean(t.symbol?.trim()) &&
          t.lot_size <= 0 &&
          (t.profit === 0 || t.profit === null),
      )
      const debug = (hasMissingDirection || hasSparseClosed) && firstRawSample
        ? { raw_sample_keys: Object.keys(firstRawSample), raw_sample: firstRawSample }
        : undefined
      return Response.json({ ok: true, trades, debug }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action} (${BUILD_TAG})`)
  } catch (e: unknown) {
    const apiErr = e instanceof MetatraderApiError ? friendlyMtApiError(e) : null
    let msg = apiErr?.message ?? (e instanceof Error ? e.message : "Internal server error")
    if (/invalid dns name/i.test(msg)) {
      msg =
        "Invalid MT API host URL (DNS error). Check Supabase secrets MT4API_MT4_BASE_URL / MT4API_MT5_BASE_URL — use exactly https://mt4.mt4api.dev or https://mt5.mt4api.dev with no trailing slash or parentheses."
    }
    const status = apiErr?.status ?? (e instanceof MetatraderApiError ? e.status : 500)
    return Response.json({ error: msg }, { status: status >= 400 && status < 600 ? status : 500, headers: corsHeaders })
  }
})
