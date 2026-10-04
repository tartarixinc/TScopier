import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import {
  effectivePlan,
  loadUserIsAdmin,
  loadUserSubscription,
} from "../_shared/subscriptionAccess.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const LAYERING_KEYS = [
  "layering_mode",
  "range_layering_type",
  "static_layer_count",
  "dynamic_step_pips",
  "dynamic_max_layers",
  "layering_optimization_strategy",
] as const

type LayeringMode = "legacy" | "static" | "dynamic"
type LayeringMechanism = "auto" | "pending_order"
type LayeringOptimizationStrategy = "adjust_percent" | "reduce_layers" | "widen_step"

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders })
}

function flag(name: string, defaultValue: boolean): boolean {
  const raw = (Deno.env.get(name) ?? "").trim().toLowerCase()
  if (!raw) return defaultValue
  if (raw === "1" || raw === "true" || raw === "yes") return true
  if (raw === "0" || raw === "false" || raw === "no") return false
  return defaultValue
}

function allowlist(): Set<string> {
  return new Set(
    (Deno.env.get("LAYERING_MODES_ACCOUNT_ALLOWLIST") ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{8,64}$/i.test(s)),
  )
}

function nativePendingCapability(row: Record<string, unknown>) {
  const platformRaw = String(row.platform ?? "").toUpperCase()
  const platform = platformRaw === "MT4" ? "mt4" : platformRaw === "MT5" ? "mt5" : "unknown"
  const provider = String(row.provider ?? "fxsocket").trim()
  const linked = provider === "fxsocket"
    && typeof row.fxsocket_account_id === "string"
    && row.fxsocket_account_id.trim().length > 0
  const connected = row.connection_status === "connected" || row.terminal_connected === true
  const tradeAllowed = row.trade_allowed !== false
  if (!linked) return { supported: false, provider: provider === "mtapi" ? "mtapi" : "unknown", platform, canPlace: false, canReconcile: false, canCancel: false, reason: "provider_unsupported" }
  if (platform !== "mt4" && platform !== "mt5") return { supported: false, provider: "fxsocket", platform, canPlace: true, canReconcile: true, canCancel: true, reason: "platform_unsupported" }
  if (!connected || !tradeAllowed) return { supported: false, provider: "fxsocket", platform, canPlace: true, canReconcile: true, canCancel: true, reason: "connection_not_ready" }
  return { supported: true, provider: "fxsocket", platform, canPlace: true, canReconcile: true, canCancel: true, reason: "supported" }
}

function normalizeMode(value: unknown): LayeringMode | null {
  return value === "legacy" || value === "static" || value === "dynamic" ? value : null
}

function normalizeMechanism(value: unknown): LayeringMechanism | null {
  return value === "auto" || value === "pending_order" ? value : null
}

function normalizeOptimizationStrategy(value: unknown): LayeringOptimizationStrategy {
  return value === "reduce_layers" || value === "widen_step" || value === "adjust_percent" ? value : "adjust_percent"
}

function integerInRange(value: unknown, min: number, max: number): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

function positiveFinite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function configurationAllowed(args: {
  mode: Exclude<LayeringMode, "legacy">
  accountId: string
  advancedAllowed: boolean
}) {
  const allowlistSet = allowlist()
  const listed = allowlistSet.size === 0 || allowlistSet.has(args.accountId)
  return args.advancedAllowed && listed
}

function mergeLayeringSettings(existing: Record<string, unknown>, next: {
  layering_mode: LayeringMode
  range_layering_type: LayeringMechanism
  static_layer_count: number
  dynamic_step_pips: number
  dynamic_max_layers: number
  layering_optimization_strategy: LayeringOptimizationStrategy
}) {
  const merged = { ...existing }
  for (const key of LAYERING_KEYS) delete merged[key]
  return { ...merged, ...next }
}

function mergeChannelConfigMap(
  existing: unknown,
  channelId: string,
  manual: Record<string, unknown>,
) {
  const map = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {}
  const current = map[channelId] && typeof map[channelId] === "object" && !Array.isArray(map[channelId])
    ? { ...(map[channelId] as Record<string, unknown>) }
    : {}
  map[channelId] = {
    ...current,
    copier_mode: current.copier_mode === "ai" ? "ai" : "manual",
    manual_settings: manual,
  }
  return map
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== "POST") return bad(405, "Method not allowed")

  try {
    const auth = req.headers.get("Authorization") ?? ""
    const token = auth.replace(/^Bearer\s+/i, "").trim()
    if (!token) return bad(401, "Unauthorized")

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )
    const { data: authData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !authData.user) return bad(401, "Unauthorized")

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const brokerAccountId = String(body.broker_account_id ?? "").trim()
    const channelId = typeof body.channel_id === "string" && body.channel_id.trim() ? body.channel_id.trim() : null
    if (!brokerAccountId) return bad(400, "broker_account_id is required")

    const mode = normalizeMode(body.layering_mode)
    const mechanism = normalizeMechanism(body.range_layering_type)
    const staticLayerCount = integerInRange(body.static_layer_count, 1, 20)
    const dynamicStepPips = positiveFinite(body.dynamic_step_pips)
    const dynamicMaxLayers = integerInRange(body.dynamic_max_layers, 1, 20)
    const optimizationStrategy = normalizeOptimizationStrategy(body.layering_optimization_strategy)
    if (!mode || !mechanism) return bad(400, "Invalid layering mode or execution mechanism")
    if (staticLayerCount == null) return bad(400, "Static layer count must be an integer from 1 to 20")
    if (dynamicStepPips == null) return bad(400, "Dynamic step pips must be greater than zero")
    if (dynamicMaxLayers == null) return bad(400, "Dynamic max layers must be an integer from 1 to 20")

    const { data: broker, error: brokerError } = await supabase
      .from("broker_accounts")
      .select("id,user_id,provider,platform,fxsocket_account_id,connection_status,terminal_connected,trade_allowed,manual_settings,channel_trading_configs,copier_mode")
      .eq("id", brokerAccountId)
      .eq("user_id", authData.user.id)
      .maybeSingle()
    if (brokerError) throw new Error(brokerError.message)
    if (!broker) return bad(404, "Broker account not found")

    const sub = await loadUserSubscription(supabase, authData.user.id)
    const isAdmin = await loadUserIsAdmin(supabase, authData.user.id)
    const plan = effectivePlan(sub?.plan, sub?.status, sub?.trial_ends_at)
    const advancedAllowed = isAdmin || plan === "advanced"
    const pendingCapability = nativePendingCapability(broker as Record<string, unknown>)

    if (mode !== "legacy") {
      if (!configurationAllowed({ mode, accountId: brokerAccountId, advancedAllowed })) {
        return bad(403, "Layering mode is not configurable for this account")
      }
      if (mechanism === "pending_order" && !pendingCapability.supported) {
        return bad(400, "Broker pending orders are unsupported for this account")
      }
    }

    const normalized = {
      layering_mode: mode,
      range_layering_type: mechanism,
      static_layer_count: staticLayerCount,
      dynamic_step_pips: dynamicStepPips,
      dynamic_max_layers: dynamicMaxLayers,
      layering_optimization_strategy: optimizationStrategy,
    }

    if (channelId) {
      const { data: existing, error: existingError } = await supabase
        .from("broker_channel_trading_configs")
        .select("manual_settings,copier_mode,ai_settings")
        .eq("broker_account_id", brokerAccountId)
        .eq("channel_id", channelId)
        .maybeSingle()
      if (existingError) throw new Error(existingError.message)
      const manual = mergeLayeringSettings(
        ((existing?.manual_settings ?? broker.manual_settings ?? {}) as Record<string, unknown>),
        normalized,
      )
      const { error: upsertError } = await supabase
        .from("broker_channel_trading_configs")
        .upsert({
          user_id: authData.user.id,
          broker_account_id: brokerAccountId,
          channel_id: channelId,
          copier_mode: existing?.copier_mode === "ai" ? "ai" : "manual",
          manual_settings: manual,
          ai_settings: existing?.ai_settings ?? {},
        }, { onConflict: "broker_account_id,channel_id" })
      if (upsertError) throw new Error(upsertError.message)
      const channelConfigs = mergeChannelConfigMap(broker.channel_trading_configs, channelId, manual)
      const { error: mirrorError } = await supabase
        .from("broker_accounts")
        .update({ channel_trading_configs: channelConfigs })
        .eq("id", brokerAccountId)
        .eq("user_id", authData.user.id)
      if (mirrorError) throw new Error(mirrorError.message)
    } else {
      const manual = mergeLayeringSettings((broker.manual_settings ?? {}) as Record<string, unknown>, normalized)
      const { error: updateError } = await supabase
        .from("broker_accounts")
        .update({ manual_settings: manual })
        .eq("id", brokerAccountId)
        .eq("user_id", authData.user.id)
      if (updateError) throw new Error(updateError.message)
    }

    return Response.json({
      settings: normalized,
      capability: {
        prepareOnly: flag("LAYERING_MODES_PREPARE_ONLY", true),
        brokerNativePending: pendingCapability,
      },
    }, { headers: corsHeaders })
  } catch {
    return bad(500, "Layering settings update failed")
  }
})
