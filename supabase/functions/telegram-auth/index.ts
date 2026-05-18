import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

/**
 * Thin proxy in front of the worker's MTProto auth API.
 *
 * Why this is no longer an MTProto client itself:
 *   The previous version connected to Telegram directly from the Supabase
 *   Edge runtime. Each call (send_code / verify_code / list_channels) opened
 *   and closed a fresh TelegramClient from a Supabase egress IP, which was
 *   then handed off to the worker on a different cloud IP. That IP/DC churn
 *   is the strongest "userbot from datacenter" signal Telegram's anti-spam
 *   uses, and was the immediate cause of the previous account ban.
 *
 *   The worker is now the single owner of every MTProto socket. This edge
 *   function only authenticates the Supabase user and forwards the request.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

/** Base URL of the Railway worker (public). Accepts with or without https:// — fetch requires a scheme. */
function normalizeWorkerBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

const WORKER_URL = normalizeWorkerBaseUrl(Deno.env.get("WORKER_URL") ?? "")
const WORKER_INTERNAL_TOKEN = Deno.env.get("WORKER_INTERNAL_TOKEN") ?? ""

const ROUTES: Record<string, string> = {
  send_code: "/auth/send_code",
  verify_code: "/auth/verify_code",
  list_channels: "/auth/list_channels",
  backfill_channel_history: "/auth/backfill_channel_history",
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    }

    if (!WORKER_URL || !WORKER_INTERNAL_TOKEN) {
      console.error("telegram-auth: WORKER_URL or WORKER_INTERNAL_TOKEN not configured")
      return Response.json(
        { error: "Telegram service is not configured. Contact support." },
        { status: 503, headers: corsHeaders },
      )
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action ?? "")
    const path = ROUTES[action]
    if (!path) {
      return Response.json({ error: "Unknown action" }, { status: 400, headers: corsHeaders })
    }

    const { action: _omit, phone_code_hash: _omitHash, session_string: _omitSession, ...rest } = body

    const workerRes = await fetch(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": WORKER_INTERNAL_TOKEN,
      },
      body: JSON.stringify({ user_id: user.id, ...rest }),
    })

    const text = await workerRes.text()
    let payload: unknown = text
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { error: "Invalid response from Telegram service" }
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const rec = payload as Record<string, unknown>
      if (typeof rec.error === "string") {
        rec.error = String(rec.error).replace(/\s*\(caused by[\s\S]*$/i, "").trim()
      }
    }
    return new Response(JSON.stringify(payload), {
      status: workerRes.status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("telegram-auth proxy error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
