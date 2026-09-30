import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { loadUserIsAdmin } from "../_shared/subscriptionAccess.ts"
import { makeFxsocketClientFromEnv, isFxsocketConfigured } from "../_shared/fxsocketClient.ts"
import { brokerIsAlreadyDisconnected, hasSubscriptionGraceElapsed } from "../_shared/subscriptionBrokerDisconnect.ts"
const headers = { "Content-Type": "application/json" }, BATCH_SIZE = 200, DISCONNECT_REASON = "subscription_expired_grace_elapsed"
function authorized(req: Request, key: string) { const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim(); return token === key || (req.headers.get("apikey") ?? "").trim() === key }
Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL") ?? "", key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!url || !key) return new Response(JSON.stringify({ error: "missing supabase env" }), { status: 500, headers })
  if (!authorized(req, key)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers })
  if (!isFxsocketConfigured(Deno.env)) return new Response(JSON.stringify({ error: "FXSocket not configured" }), { status: 500, headers })
  const supabase = createClient(url, key), fx = makeFxsocketClientFromEnv(Deno.env), now = new Date(), metrics = { scanned: 0, eligible: 0, disconnected: 0, already_disconnected: 0, skipped_renewed_active: 0, skipped_admin: 0, failed: 0 }
  const { data: subscriptions, error } = await supabase.from("subscriptions").select("user_id,status,trial_ends_at,current_period_end").limit(BATCH_SIZE)
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers })
  for (const subscription of subscriptions ?? []) {
    metrics.scanned += 1
    const userId = String(subscription.user_id ?? "")
    if (await loadUserIsAdmin(supabase, userId)) {
      metrics.skipped_admin += 1
      console.log("[expired-fxsocket-disconnect] skipped admin", { user_id: userId, reason: "active_admin_access" })
      continue
    }
    if (!hasSubscriptionGraceElapsed(subscription, now)) { if (subscription.status === "active" || subscription.status === "trialing") metrics.skipped_renewed_active += 1; continue }
    const { data: brokers, error: brokerError } = await supabase.from("broker_accounts").select("id,fxsocket_account_id,fxsocket_status,connection_status").eq("user_id", subscription.user_id).neq("fxsocket_account_id", "")
    if (brokerError) { metrics.failed += 1; console.error("[expired-fxsocket-disconnect] broker lookup failed", { user_id: subscription.user_id, error: brokerError.message }); continue }
    for (const broker of brokers ?? []) {
      if (brokerIsAlreadyDisconnected(broker)) { metrics.already_disconnected += 1; continue }
      metrics.eligible += 1
      try {
        await fx.deleteAccountStrict(String(broker.fxsocket_account_id))
        const { error: updateError } = await supabase.from("broker_accounts").update({ fxsocket_status: "disconnected", connection_status: "disconnected", terminal_connected: false, trade_allowed: false, connection_error: null, disconnect_reason: DISCONNECT_REASON, disconnected_at: now.toISOString() }).eq("id", broker.id).eq("user_id", subscription.user_id)
        if (updateError) throw new Error(updateError.message)
        metrics.disconnected += 1; console.log("[expired-fxsocket-disconnect] disconnected", { user_id: subscription.user_id, broker_id: broker.id, reason: DISCONNECT_REASON })
      } catch (cause) { metrics.failed += 1; console.error("[expired-fxsocket-disconnect] failed", { user_id: subscription.user_id, broker_id: broker.id, reason: DISCONNECT_REASON, error: cause instanceof Error ? cause.message : String(cause) }) }
    }
  }
  console.log("[expired-fxsocket-disconnect] completed", metrics)
  return new Response(JSON.stringify({ ok: true, ...metrics }), { headers })
})
