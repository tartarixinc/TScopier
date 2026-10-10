import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2"
import { parseTradingViewAlert } from "../_shared/tradingViewAlert.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const MAX_WEBHOOKS_PER_USER = 20
const RATE_LIMIT_PER_MINUTE = 60

type WebhookRow = {
  id: string
  user_id: string
  channel_id: string
  name: string
  is_active: boolean
}

function json(status: number, body: Record<string, unknown>, extraHeaders?: HeadersInit) {
  return Response.json(body, { status, headers: { ...corsHeaders, ...extraHeaders } })
}

function pathToken(req: Request): string | null {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean)
  const last = parts[parts.length - 1] ?? ""
  if (!last || last === "tradingview-webhook") return null
  return last
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function shardForUserId(userId: string, shardCount: number): number {
  let h = 0
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0
  }
  return Math.abs(h) % Math.max(1, shardCount)
}

function parseUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw.split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean)
}

function tradeWorkerUrl(action: string, userId: string): string | null {
  const entryShards = parseUrls(Deno.env.get("TRADE_WORKER_SHARD_URLS"))
  const mgmtShards = parseUrls(Deno.env.get("TRADE_MGMT_WORKER_SHARD_URLS"))
  const entryUrl = (Deno.env.get("TRADE_WORKER_URL") ?? Deno.env.get("WORKER_URL") ?? "").trim().replace(/\/$/, "")
  const mgmtUrl = (Deno.env.get("TRADE_MGMT_WORKER_URL") ?? "").trim().replace(/\/$/, "")
  const mgmt = action === "close"

  if (mgmt && mgmtShards.length > 1) return mgmtShards[shardForUserId(userId, mgmtShards.length)] ?? null
  if (mgmt && mgmtShards.length === 1) return mgmtShards[0] ?? null
  if (mgmt && mgmtUrl) return mgmtUrl

  if (entryShards.length > 1) return entryShards[shardForUserId(userId, entryShards.length)] ?? null
  if (entryShards.length === 1) return entryShards[0] ?? null
  return entryUrl || null
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? ""
  return forwarded.split(",")[0]?.trim() ?? ""
}

function ipAllowed(req: Request): boolean {
  const allow = (Deno.env.get("TRADINGVIEW_WEBHOOK_IPS") ?? "").trim()
  if (!allow) return true
  const ip = clientIp(req)
  if (!ip) return false
  return allow.split(",").map(s => s.trim()).filter(Boolean).includes(ip)
}

async function requireUser(supabase: SupabaseClient, req: Request): Promise<string | null> {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

async function createWebhook(supabase: SupabaseClient, userId: string, name: string) {
  const { count } = await supabase
    .from("tradingview_webhooks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
  if ((count ?? 0) >= MAX_WEBHOOKS_PER_USER) {
    return json(400, { error: "webhook_limit" })
  }

  const label = name.trim().slice(0, 80) || "TradingView"
  const channelKey = `tv:${crypto.randomUUID()}`
  const { data: channel, error: channelErr } = await supabase
    .from("telegram_channels")
    .insert({
      user_id: userId,
      channel_id: channelKey,
      channel_username: "",
      display_name: label,
      is_active: true,
      source_kind: "tradingview",
    })
    .select("id")
    .single()
  if (channelErr || !channel) {
    console.warn(`[tradingview-webhook] channel insert failed user=${userId}: ${channelErr?.message ?? "null"}`)
    return json(500, { error: "create_failed" })
  }

  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const { data: webhook, error: webhookErr } = await supabase
    .from("tradingview_webhooks")
    .insert({
      user_id: userId,
      channel_id: channel.id,
      name: label,
      token_hash: tokenHash,
      token,
      is_active: true,
    })
    .select("id, channel_id, name, token, is_active, created_at")
    .single()
  if (webhookErr || !webhook) {
    await supabase.from("telegram_channels").delete().eq("id", channel.id).eq("user_id", userId)
    console.warn(`[tradingview-webhook] webhook insert failed user=${userId}: ${webhookErr?.message ?? "null"}`)
    return json(500, { error: "create_failed" })
  }
  return json(200, { webhook })
}

async function ownedWebhook(supabase: SupabaseClient, userId: string, id: string) {
  const { data } = await supabase
    .from("tradingview_webhooks")
    .select("id, user_id, channel_id, name, is_active")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle()
  return (data ?? null) as WebhookRow | null
}

async function unlinkChannelFromBrokers(supabase: SupabaseClient, userId: string, channelId: string) {
  const { data: brokers } = await supabase
    .from("broker_accounts")
    .select("id, signal_channel_ids")
    .eq("user_id", userId)
  for (const broker of brokers ?? []) {
    const ids = Array.isArray(broker.signal_channel_ids) ? broker.signal_channel_ids as string[] : []
    const next = ids.filter(id => id.toLowerCase() !== channelId.toLowerCase())
    if (next.length === ids.length) continue
    await supabase
      .from("broker_accounts")
      .update({ signal_channel_ids: next, enforce_signal_channel_filter: next.length > 0 })
      .eq("id", broker.id)
      .eq("user_id", userId)
  }
}

async function handleManage(supabase: SupabaseClient, req: Request): Promise<Response> {
  const userId = await requireUser(supabase, req)
  if (!userId) return json(401, { error: "unauthorized" })

  let body: { action?: string; id?: string; name?: string; is_active?: boolean }
  try {
    body = await req.json() as typeof body
  } catch {
    return json(400, { error: "invalid_json" })
  }

  if (body.action === "create") {
    return createWebhook(supabase, userId, String(body.name ?? ""))
  }

  const id = String(body.id ?? "").trim()
  if (!id) return json(400, { error: "id_required" })
  const webhook = await ownedWebhook(supabase, userId, id)
  if (!webhook) return json(404, { error: "not_found" })

  if (body.action === "rename") {
    const name = String(body.name ?? "").trim().slice(0, 80)
    if (!name) return json(400, { error: "name_required" })
    const { error } = await supabase
      .from("tradingview_webhooks")
      .update({ name, updated_at: new Date().toISOString() })
      .eq("id", webhook.id)
      .eq("user_id", userId)
    if (error) return json(500, { error: "rename_failed" })
    await supabase
      .from("telegram_channels")
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq("id", webhook.channel_id)
      .eq("user_id", userId)
    return json(200, { ok: true })
  }

  if (body.action === "set_active") {
    const isActive = body.is_active === true
    const { error } = await supabase
      .from("tradingview_webhooks")
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq("id", webhook.id)
      .eq("user_id", userId)
    if (error) return json(500, { error: "update_failed" })
    return json(200, { ok: true, is_active: isActive })
  }

  if (body.action === "rotate") {
    const token = randomToken()
    const tokenHash = await sha256Hex(token)
    const { error } = await supabase
      .from("tradingview_webhooks")
      .update({ token, token_hash: tokenHash, updated_at: new Date().toISOString() })
      .eq("id", webhook.id)
      .eq("user_id", userId)
    if (error) return json(500, { error: "rotate_failed" })
    return json(200, { ok: true, token })
  }

  if (body.action === "delete") {
    await unlinkChannelFromBrokers(supabase, userId, webhook.channel_id)
    const { error } = await supabase
      .from("telegram_channels")
      .delete()
      .eq("id", webhook.channel_id)
      .eq("user_id", userId)
    if (error) return json(500, { error: "delete_failed" })
    return json(200, { ok: true })
  }

  return json(400, { error: "unknown_action" })
}

async function recordDelivery(
  supabase: SupabaseClient,
  webhook: WebhookRow,
  status: "accepted" | "skipped" | "error" | "duplicate",
  idempotencyKey: string,
  skipReason: string | null,
  signalId: string | null,
): Promise<"inserted" | "duplicate"> {
  const { error } = await supabase.from("tradingview_webhook_deliveries").insert({
    webhook_id: webhook.id,
    user_id: webhook.user_id,
    signal_id: signalId,
    status,
    skip_reason: skipReason,
    idempotency_key: idempotencyKey,
  })
  if (!error) return "inserted"
  if (error.code === "23505") return "duplicate"
  console.warn(`[tradingview-webhook] delivery insert failed webhook=${webhook.id}: ${error.message}`)
  return "inserted"
}

async function pushSignal(
  webhook: WebhookRow,
  signal: {
    id: string
    parsed_data: Record<string, unknown>
    status: string
    telegram_message_id: string
    created_at: string
  },
): Promise<void> {
  const token = (Deno.env.get("WORKER_INTERNAL_TOKEN") ?? "").trim()
  const action = String(signal.parsed_data.action ?? "")
  const baseUrl = tradeWorkerUrl(action, webhook.user_id)
  if (!token || !baseUrl) {
    console.warn(`[tradingview-webhook] trade worker not configured user=${webhook.user_id}`)
    return
  }
  const res = await fetch(`${baseUrl}/internal/dispatch-signal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({
      signal: {
        id: signal.id,
        user_id: webhook.user_id,
        channel_id: webhook.channel_id,
        parsed_data: signal.parsed_data,
        status: signal.status,
        parent_signal_id: null,
        is_modification: false,
        telegram_message_id: signal.telegram_message_id,
        reply_to_message_id: null,
        created_at: signal.created_at,
        dispatch_source: "tradingview_webhook",
      },
      priority: action === "close" ? "high" : "normal",
      source: "tradingview_webhook",
      await: false,
    }),
  })
  if (!res.ok) {
    console.warn(`[tradingview-webhook] dispatch failed status=${res.status} user=${webhook.user_id}`)
  }
}

async function handleIngest(supabase: SupabaseClient, req: Request, token: string): Promise<Response> {
  if (!ipAllowed(req)) return json(403, { ok: false, status: "error" })

  const tokenHash = await sha256Hex(token)
  const { data } = await supabase
    .from("tradingview_webhooks")
    .select("id, user_id, channel_id, name, is_active")
    .eq("token_hash", tokenHash)
    .maybeSingle()
  const webhook = (data ?? null) as WebhookRow | null
  if (!webhook) return json(404, { ok: false })

  const since = new Date(Date.now() - 60_000).toISOString()
  const { count } = await supabase
    .from("tradingview_webhook_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("webhook_id", webhook.id)
    .gte("created_at", since)
  if ((count ?? 0) >= RATE_LIMIT_PER_MINUTE) {
    return json(429, { ok: false, status: "error" })
  }

  const raw = await req.text()
  const bodyHash = await sha256Hex(raw)
  if (!webhook.is_active) {
    await recordDelivery(supabase, webhook, "skipped", `inactive:${bodyHash}`, "inactive", null)
    return json(200, { ok: false, status: "skipped" })
  }

  const parsed = parseTradingViewAlert(raw)
  const idempotencyKey = parsed.ok && parsed.alert.idempotencyId
    ? parsed.alert.idempotencyId
    : bodyHash

  const { data: existing } = await supabase
    .from("tradingview_webhook_deliveries")
    .select("id")
    .eq("webhook_id", webhook.id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()
  if (existing) return json(200, { ok: true, status: "duplicate" })

  if (!parsed.ok) {
    await recordDelivery(supabase, webhook, parsed.reason === "unknown_action" ? "skipped" : "error", idempotencyKey, parsed.reason, null)
    return json(200, { ok: false, status: parsed.reason === "unknown_action" ? "skipped" : "error" })
  }

  const createdAt = new Date().toISOString()
  const signalId = crypto.randomUUID()
  const { error: signalErr } = await supabase.from("signals").insert({
    id: signalId,
    user_id: webhook.user_id,
    channel_id: webhook.channel_id,
    raw_message: raw.slice(0, 8_000),
    parsed_data: parsed.alert.parsed,
    status: "parsed",
    skip_reason: null,
    telegram_message_id: idempotencyKey,
    is_modification: false,
    created_at: createdAt,
  })
  if (signalErr) {
    if (signalErr.code === "23505") return json(200, { ok: true, status: "duplicate" })
    console.warn(`[tradingview-webhook] signal insert failed webhook=${webhook.id}: ${signalErr.message}`)
    await recordDelivery(supabase, webhook, "error", idempotencyKey, "signal_insert_failed", null)
    return json(200, { ok: false, status: "error" })
  }

  const recorded = await recordDelivery(supabase, webhook, "accepted", idempotencyKey, null, signalId)
  if (recorded === "duplicate") return json(200, { ok: true, status: "duplicate" })

  await pushSignal(webhook, {
    id: signalId,
    parsed_data: parsed.alert.parsed,
    status: "parsed",
    telegram_message_id: idempotencyKey,
    created_at: createdAt,
  })
  return json(200, { ok: true, status: "accepted" })
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" })

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  )
  const token = pathToken(req)
  if (token) return handleIngest(supabase, req, token)
  return handleManage(supabase, req)
})
