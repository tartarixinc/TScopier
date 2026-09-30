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

const LIMITS = {
  staticLayerCount: { min: 1, max: 20 },
  dynamicStepPips: { minExclusive: 0 },
  dynamicMaxLayers: { min: 1, max: 20 },
}

function flag(name: string, defaultValue: boolean): boolean {
  const raw = (Deno.env.get(name) ?? "").trim().toLowerCase()
  if (!raw) return defaultValue
  if (raw === "1" || raw === "true" || raw === "yes") return true
  if (raw === "0" || raw === "false" || raw === "no") return false
  return defaultValue
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

function allowlist(): Set<string> {
  return new Set(
    (Deno.env.get("LAYERING_MODES_ACCOUNT_ALLOWLIST") ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f-]{8,64}$/i.test(s)),
  )
}

function modeCapability(args: {
  mode: "static" | "dynamic"
  accountId: string
  advancedAllowed: boolean
  pendingCapability: ReturnType<typeof nativePendingCapability>
}) {
  const reasons: string[] = []
  const globalEnabled = flag("LAYERING_MODES_EXECUTION_ENABLED", false)
  const killSwitch = flag("LAYERING_MODES_KILL_SWITCH", true)
  const modeEnabled = args.mode === "static"
    ? flag("LAYERING_STATIC_EXECUTION_ENABLED", false)
    : flag("LAYERING_DYNAMIC_EXECUTION_ENABLED", false)
  const prepareOnly = flag("LAYERING_MODES_PREPARE_ONLY", true)
  const allowlistSet = allowlist()
  const listed = allowlistSet.size === 0 || allowlistSet.has(args.accountId)
  if (!args.advancedAllowed) reasons.push("advanced_plan_required")
  if (!globalEnabled) reasons.push("global_disabled")
  if (killSwitch) reasons.push("kill_switch_active")
  if (!modeEnabled) reasons.push("mode_disabled")
  if (!listed) reasons.push("account_not_allowlisted")
  if (prepareOnly) reasons.push("prepare_only")
  if (!args.pendingCapability.supported) reasons.push("broker_pending_unsupported")
  const configurable = args.advancedAllowed && listed
  const executionAvailable = configurable && globalEnabled && !prepareOnly
    && !killSwitch && modeEnabled
  return {
    available: configurable,
    configurable,
    preparationAvailable: configurable,
    executionAvailable,
    reasons,
    executionMechanisms: {
      auto: { configurable, executable: executionAvailable },
      pending_order: {
        configurable: configurable && args.pendingCapability.supported,
        executable: executionAvailable && args.pendingCapability.supported,
      },
    },
  }
}

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: corsHeaders })
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
    if (!brokerAccountId) return bad(400, "broker_account_id is required")

    const { data: broker, error: brokerError } = await supabase
      .from("broker_accounts")
      .select("id,user_id,provider,platform,fxsocket_account_id,connection_status,terminal_connected,trade_allowed")
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
    const prepareOnly = flag("LAYERING_MODES_PREPARE_ONLY", true)

    return Response.json({
      layeringModes: {
        legacy: { available: true },
        static: modeCapability({
          mode: "static",
          accountId: brokerAccountId,
          advancedAllowed,
          pendingCapability,
        }),
        dynamic: modeCapability({
          mode: "dynamic",
          accountId: brokerAccountId,
          advancedAllowed,
          pendingCapability,
        }),
      },
      limits: LIMITS,
      brokerNativePending: pendingCapability,
      rollout: { prepareOnly },
    }, { headers: corsHeaders })
  } catch {
    return bad(500, "Capability lookup failed")
  }
})
