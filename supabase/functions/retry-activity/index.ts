import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

const RETRY_ELIGIBLE_ACTIONS = new Set([
  "mgmt_breakeven",
  "mgmt_close",
  "mgmt_close_worse_entries",
  "mgmt_modify",
  "mgmt_partial_breakeven",
  "mgmt_partial_profit",
  "merge_modify_summary",
  "merge_routed_modify_only",
  "cwe_close",
  "auto_be",
  "trailing_stop",
  "order_send",
  "virtual_pending_fired",
  "virtual_pending_inserted",
  "signal_entry_pending_filled",
  "opposite_signal_close",
  "partial_tp_fired",
  "basket_leg_modify",
])

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

async function callWorkerRetry(args: {
  userId: string
  logId: string
}): Promise<{ ok: boolean; accepted?: boolean; reason?: string; error?: string }> {
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

  const res = await fetch(`${workerUrl}/internal/retry-activity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({
      user_id: args.userId,
      log_id: args.logId,
    }),
  })
  const data = await res.json().catch(() => ({})) as {
    ok?: boolean
    accepted?: boolean
    reason?: string
    error?: string
  }
  if (!res.ok) {
    return { ok: false, error: data.error ?? `Worker retry failed (${res.status})` }
  }
  return {
    ok: data.ok === true,
    accepted: data.accepted,
    reason: data.reason,
    error: data.error,
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

    let body: { log_id?: string; log_ids?: string[] }
    try {
      body = await req.json() as typeof body
    } catch {
      return bad(400, "Invalid JSON body")
    }

    const logIds = [
      ...(body.log_id?.trim() ? [body.log_id.trim()] : []),
      ...(Array.isArray(body.log_ids) ? body.log_ids.map(id => id?.trim()).filter(Boolean) as string[] : []),
    ]
    const uniqueLogIds = [...new Set(logIds)]
    if (!uniqueLogIds.length) return bad(400, "log_id or log_ids is required")

    const { data: logs, error: logsErr } = await supabase
      .from("trade_execution_logs")
      .select("id,action,status,signal_id")
      .eq("user_id", userId)
      .in("id", uniqueLogIds)
    if (logsErr) return bad(500, logsErr.message)

    const byId = new Map((logs ?? []).map(row => [row.id as string, row]))
    const results: Array<{ log_id: string; ok: boolean; reason?: string; error?: string }> = []

    for (const logId of uniqueLogIds) {
      const log = byId.get(logId)
      if (!log) {
        results.push({ log_id: logId, ok: false, reason: "activity_not_found" })
        continue
      }
      if (String(log.status).toLowerCase() !== "failed") {
        results.push({ log_id: logId, ok: false, reason: "activity_not_failed" })
        continue
      }
      if (!RETRY_ELIGIBLE_ACTIONS.has(String(log.action ?? "").toLowerCase())) {
        results.push({ log_id: logId, ok: false, reason: "not_retry_eligible" })
        continue
      }
      if (!log.signal_id) {
        results.push({ log_id: logId, ok: false, reason: "missing_signal_id" })
        continue
      }

      const workerResult = await callWorkerRetry({ userId, logId })
      if (workerResult.error) {
        results.push({ log_id: logId, ok: false, error: workerResult.error })
        continue
      }
      results.push({
        log_id: logId,
        ok: workerResult.ok,
        reason: workerResult.ok ? undefined : workerResult.reason,
      })
    }

    const okCount = results.filter(r => r.ok).length
    return Response.json(
      {
        ok: okCount > 0,
        retried: okCount,
        failed: results.length - okCount,
        results,
      },
      { status: 200, headers: corsHeaders },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[retry-activity]", msg)
    return bad(500, msg)
  }
})
