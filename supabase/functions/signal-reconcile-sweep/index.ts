/**
 * signal-reconcile-sweep — cron backup for Telegram signal text reconciliation.
 *
 * Worker UserListener runs reconcile every 60s (primary). This edge function runs
 * every 2 minutes and POSTs to the listener worker for users with open trades.
 */

// @ts-ignore Deno runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"

// @ts-ignore Deno globals
declare const Deno: {
  env: { get(name: string): string | undefined }
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const WORKER_URL = (
  Deno.env.get("TELEGRAM_LISTENER_URL") ?? Deno.env.get("WORKER_URL") ?? ""
).replace(/\/+$/, "")
const WORKER_INTERNAL_TOKEN = Deno.env.get("WORKER_INTERNAL_TOKEN") ?? ""
const LOOKBACK_HOURS = 24
const MAX_USERS = 40

Deno.serve(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "missing supabase env" }), { status: 500 })
  }
  if (!WORKER_URL || !WORKER_INTERNAL_TOKEN) {
    return new Response(JSON.stringify({ error: "WORKER_URL or WORKER_INTERNAL_TOKEN not configured" }), {
      status: 503,
    })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()

  const { data: openTrades, error: tradesErr } = await supabase
    .from("trades")
    .select("user_id")
    .eq("status", "open")
    .gte("opened_at", since)
    .limit(500)

  if (tradesErr) {
    return new Response(JSON.stringify({ error: tradesErr.message }), { status: 500 })
  }

  const userIds = [...new Set(
    (openTrades ?? [])
      .map((r) => String((r as { user_id?: string }).user_id ?? ""))
      .filter(Boolean),
  )].slice(0, MAX_USERS)

  let triggered = 0
  let skipped = 0
  const results: Array<Record<string, unknown>> = []

  for (const userId of userIds) {
    try {
      const res = await fetch(`${WORKER_URL}/internal/reconcile-signals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": WORKER_INTERNAL_TOKEN,
        },
        body: JSON.stringify({ user_id: userId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok !== false) {
        triggered += 1
        results.push({ user_id: userId, ok: true, stats: data?.stats ?? null })
      } else {
        skipped += 1
        results.push({ user_id: userId, ok: false, reason: data?.reason ?? data?.error ?? res.status })
      }
    } catch (err) {
      skipped += 1
      results.push({
        user_id: userId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return new Response(
    JSON.stringify({
      users_considered: userIds.length,
      triggered,
      skipped,
      results,
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
