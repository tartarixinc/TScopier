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

function normalizeChannelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map(id => String(id ?? "").trim()).filter(Boolean)
}

async function callWorkerForceClose(args: {
  userId: string
  brokerAccountId: string
  channelId?: string | null
}): Promise<Record<string, unknown>> {
  const workerUrl = (
    Deno.env.get("TRADE_WORKER_URL")
    ?? Deno.env.get("WORKER_URL")
    ?? Deno.env.get("WORKER_PUBLIC_URL")
    ?? ""
  ).trim().replace(/\/+$/, "")
  const token = (Deno.env.get("WORKER_INTERNAL_TOKEN") ?? "").trim()
  if (!workerUrl || !token) {
    return { ok: false, error: "WORKER_URL not configured" }
  }

  const res = await fetch(`${workerUrl}/internal/force-close-trades`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({
      user_id: args.userId,
      broker_account_id: args.brokerAccountId,
      channel_id: args.channelId ?? null,
    }),
  })
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    return { ok: false, error: String(data.error ?? `Worker force close failed (${res.status})`) }
  }
  return data
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

    let body: { broker_account_id?: string; channel_id?: string | null }
    try {
      body = await req.json() as typeof body
    } catch {
      return bad(400, "Invalid JSON body")
    }

    const brokerAccountId = body.broker_account_id?.trim()
    if (!brokerAccountId) return bad(400, "broker_account_id is required")

    const { data: broker, error: brokerErr } = await supabase
      .from("broker_accounts")
      .select("id,fxsocket_account_id,signal_channel_ids")
      .eq("id", brokerAccountId)
      .eq("user_id", userId)
      .maybeSingle()
    if (brokerErr) return bad(500, brokerErr.message)
    if (!broker) return bad(404, "Broker account not found")
    if (!String(broker.fxsocket_account_id ?? "").trim()) {
      return bad(400, "Broker has no FxSocket account linked")
    }

    const channelId = body.channel_id?.trim() || null
    if (channelId) {
      const { data: channel, error: chErr } = await supabase
        .from("telegram_channels")
        .select("id")
        .eq("id", channelId)
        .eq("user_id", userId)
        .maybeSingle()
      if (chErr) return bad(500, chErr.message)
      if (!channel) return bad(404, "Channel not found")

      const linked = normalizeChannelIds(broker.signal_channel_ids)
      if (
        linked.length > 0
        && !linked.some(id => id.toLowerCase() === channelId.toLowerCase())
      ) {
        return bad(400, "Channel is not linked to this broker account")
      }
    }

    const workerResult = await callWorkerForceClose({
      userId,
      brokerAccountId,
      channelId,
    })
    if (workerResult.error && workerResult.ok !== true) {
      return bad(503, String(workerResult.error))
    }

    return Response.json(workerResult, { status: 200, headers: corsHeaders })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[force-close-trades]", msg)
    return bad(500, msg)
  }
})
