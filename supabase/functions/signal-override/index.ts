import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

function positiveLevel(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeTpLevels(tp: unknown): number[] {
  if (!Array.isArray(tp)) return []
  return tp.filter((t): t is number => positiveLevel(t) != null) as number[]
}

async function upsertChannelActiveTradeParams(
  supabase: ReturnType<typeof createClient>,
  args: {
    userId: string
    channelId: string
    symbol: string
    stoploss: number | null
    tpLevels: number[]
  },
): Promise<void> {
  const { userId, channelId, symbol, stoploss, tpLevels } = args
  if (stoploss == null && tpLevels.length === 0) return
  const now = new Date().toISOString()
  const row = {
    user_id: userId,
    channel_id: channelId,
    symbol: symbol.trim().toUpperCase(),
    stoploss,
    tp_levels: tpLevels,
    updated_at: now,
  }
  const { error } = await supabase
    .from("channel_active_trade_params")
    .upsert(row, { onConflict: "user_id,channel_id,symbol" })
  if (error) console.warn(`[signal-override] channel params upsert failed: ${error.message}`)
}

/** Stable per-user shard hash — must match worker `shardForUserId`. */
function shardForUserId(userId: string, shardCount: number): number {
  let h = 0
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0
  }
  return Math.abs(h) % Math.max(1, shardCount)
}

function parseShardUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw.split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean)
}

/**
 * Pick the worker URL for a user, mirroring `pickTradeWorkerUrl` for management
 * actions. Override apply is management-style (modifies open legs), so prefer the
 * mgmt fleet and shard by user so we hit the worker that owns this user's session.
 */
function pickWorkerUrl(userId: string): string {
  const mgmtShardUrls = parseShardUrls(Deno.env.get("TRADE_MGMT_WORKER_SHARD_URLS"))
  if (mgmtShardUrls.length > 1) {
    return mgmtShardUrls[shardForUserId(userId, mgmtShardUrls.length)] ?? ""
  }
  if (mgmtShardUrls.length === 1) return mgmtShardUrls[0]!

  const mgmtUrl = (Deno.env.get("TRADE_MGMT_WORKER_URL") ?? "").trim().replace(/\/+$/, "")
  const shardUrls = parseShardUrls(Deno.env.get("TRADE_WORKER_SHARD_URLS"))
  if (shardUrls.length > 1) {
    if (mgmtUrl) return mgmtUrl
    return shardUrls[shardForUserId(userId, shardUrls.length)] ?? ""
  }
  if (mgmtUrl) return mgmtUrl
  if (shardUrls.length === 1) return shardUrls[0]!

  return (
    Deno.env.get("TRADE_WORKER_URL")
    ?? Deno.env.get("WORKER_URL")
    ?? Deno.env.get("WORKER_PUBLIC_URL")
    ?? ""
  ).trim().replace(/\/+$/, "")
}

type BrokerOutcome = { broker_id: string; applied: number; skipped: number; failed: number }

function scheduleBackgroundTask(promise: Promise<unknown>): void {
  const runtime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil(task: Promise<unknown>): void }
  }).EdgeRuntime
  if (runtime?.waitUntil) {
    runtime.waitUntil(promise)
    return
  }
  void promise
}

async function callWorkerApply(args: {
  userId: string
  signalId: string
  forceApply?: boolean
}): Promise<{
  applied_legs: number
  failed_legs?: number
  errors?: string[]
  brokers?: BrokerOutcome[]
  brokers_missing?: string[]
  queued?: boolean
}> {
  const workerUrl = pickWorkerUrl(args.userId)
  const token = (Deno.env.get("WORKER_INTERNAL_TOKEN") ?? "").trim()
  if (!workerUrl || !token) {
    return { applied_legs: 0, errors: ["WORKER_URL not configured"] }
  }

  const res = await fetch(`${workerUrl}/internal/apply-signal-override`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({
      user_id: args.userId,
      signal_id: args.signalId,
      ...(args.forceApply ? { force_apply: true } : {}),
    }),
  })
  const data = await res.json().catch(() => ({})) as {
    applied_legs?: number
    failed_legs?: number
    error?: string
    errors?: string[]
    brokers?: BrokerOutcome[]
    brokers_missing?: string[]
    queued?: boolean
    accepted?: boolean
  }
  if (!res.ok) {
    return { applied_legs: 0, failed_legs: 0, errors: [data.error ?? `Worker apply failed (${res.status})`] }
  }
  return {
    applied_legs: Number(data.applied_legs ?? 0),
    failed_legs: Number(data.failed_legs ?? 0),
    errors: data.errors,
    brokers: data.brokers,
    brokers_missing: data.brokers_missing,
    queued: data.queued === true || data.accepted === true,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== "POST") return bad(405, "Method not allowed")

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

    let body: {
      signal_id?: string
      sl?: number | null
      tp_levels?: number[]
      force_apply?: boolean
    }
    try {
      body = await req.json() as typeof body
    } catch {
      return bad(400, "Invalid JSON body")
    }

    const signalId = body.signal_id?.trim()
    if (!signalId) return bad(400, "signal_id is required")

    const sl = body.sl === null || body.sl === undefined ? null : positiveLevel(body.sl)
    const tpLevels = normalizeTpLevels(body.tp_levels ?? [])
    const forceApply = body.force_apply === true
    if (sl !== null && !(sl > 0)) return bad(400, "Invalid SL level")
    if (tpLevels.some(n => !(n > 0))) return bad(400, "Invalid TP levels")
    if (sl === null && tpLevels.length === 0) {
      return bad(400, "At least one of SL or TP is required")
    }

    const { data: signal, error: sigErr } = await supabase
      .from("signals")
      .select("id,user_id,channel_id,parsed_data")
      .eq("id", signalId)
      .eq("user_id", userId)
      .maybeSingle()
    if (sigErr) return bad(500, sigErr.message)
    if (!signal) return bad(404, "Signal not found")

    const parsed = (signal.parsed_data ?? {}) as Record<string, unknown>
    const action = String(parsed.action ?? "").toLowerCase()
    if (action !== "buy" && action !== "sell") {
      return bad(400, "Only buy/sell entry signals can be overridden")
    }
    if (!signal.channel_id) return bad(400, "Signal has no channel")

    const userOverride = {
      sl,
      tp: tpLevels,
      updated_at: new Date().toISOString(),
    }

    const { error: updErr } = await supabase
      .from("signals")
      .update({ user_override: userOverride })
      .eq("id", signalId)
      .eq("user_id", userId)
    if (updErr) return bad(500, updErr.message)

    const symbol = String(parsed.symbol ?? "").trim()
    if (symbol) {
      await upsertChannelActiveTradeParams(supabase, {
        userId,
        channelId: signal.channel_id,
        symbol,
        stoploss: sl,
        tpLevels,
      })
    }

    const { count: signalOpenCount } = await supabase
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("signal_id", signalId)
      .eq("status", "open")

    const open = (signalOpenCount ?? 0) > 0

    // Kick the worker apply without blocking the HTTP response — OrderModify
    // across many legs can take tens of seconds and was freezing the modal.
    scheduleBackgroundTask(
      callWorkerApply({ userId, signalId, forceApply }).then((workerResult) => {
        if (workerResult.errors?.length) {
          console.warn(`[signal-override] worker apply warnings: ${workerResult.errors.join("; ")}`)
        }
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[signal-override] background worker apply failed: ${msg}`)
      }),
    )

    return Response.json(
      {
        ok: true,
        queued: true,
        applied_legs: 0,
        failed_legs: 0,
        open,
        brokers: [] as BrokerOutcome[],
        brokers_missing: [] as string[],
        brokers_total: 0,
        brokers_updated: 0,
      },
      { status: 200, headers: corsHeaders },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[signal-override]", msg)
    return bad(500, msg)
  }
})
