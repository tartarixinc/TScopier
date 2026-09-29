import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { MtapiClient } from "../_shared/mtapiClient.ts"
import {
  ProviderTransitionError,
  transitionBrokerProvider,
  type BrokerProviderName,
  type ProviderTransitionRow,
} from "../_shared/providerTransition.ts"

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" })
  const serviceRoleKey = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  const supplied = String(req.headers.get("Authorization") ?? "").trim()
  if (!serviceRoleKey || !timingSafeEqual(supplied, `Bearer ${serviceRoleKey}`)) {
    return json(401, { error: "Unauthorized" })
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = String(body.action ?? "").trim()
  const brokerAccountId = String(body.broker_account_id ?? "").trim()
  const targetProvider: BrokerProviderName | null = action === "activate_mtapi"
    ? "mtapi"
    : action === "rollback_fxsocket" ? "fxsocket" : null
  if (!targetProvider) return json(400, { error: "Unsupported action" })

  const supabaseUrl = String(Deno.env.get("SUPABASE_URL") ?? "").trim()
  if (!supabaseUrl) return json(503, { error: "Transition service is not configured" })
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const mtapi = new MtapiClient({ env: Deno.env })

  try {
    const result = await transitionBrokerProvider(
      {
        brokerAccountId,
        targetProvider,
        drainTimeoutMs: Number(Deno.env.get("BROKER_WRITE_DRAIN_TIMEOUT_MS") ?? 150_000),
      },
      {
        async load(id) {
          const { data, error } = await supabase
            .from("broker_accounts")
            .select("id,provider,writer_epoch,provider_transition_state,provider_transition_target,mtapi_session_id,mtapi_status,broker_password_encrypted,fxsocket_account_id,metaapi_account_id,platform")
            .eq("id", id)
            .maybeSingle()
          if (error) throw new Error("BROKER_LOAD_FAILED")
          return (data ?? null) as ProviderTransitionRow | null
        },
        async verifyMtapi(sessionId, platform) {
          await mtapi.checkConnect(sessionId, platform)
          const summary = await mtapi.accountSummary(sessionId, platform)
          if (!summary || Object.keys(summary).length === 0) throw new Error("MTAPI_VERIFY_FAILED")
        },
        async begin(args) {
          const { data, error } = await supabase.rpc("begin_broker_provider_transition", {
            p_broker_account_id: args.brokerAccountId,
            p_expected_provider: args.expectedProvider,
            p_target_provider: args.targetProvider,
            p_expected_session_id: args.expectedSessionId,
            p_expected_writer_epoch: args.expectedWriterEpoch,
          })
          if (error || !Number.isSafeInteger(Number(data))) throw new Error("TRANSITION_BEGIN_FAILED")
          return Number(data)
        },
        async countOldLeases(id, epoch) {
          const { data, error } = await supabase.rpc("count_broker_write_leases", {
            p_broker_account_id: id,
            p_before_writer_epoch: epoch,
          })
          if (error || !Number.isFinite(Number(data))) throw new Error("LEASE_COUNT_FAILED")
          return Number(data)
        },
        async finish(args) {
          const { data, error } = await supabase.rpc("finish_broker_provider_transition", {
            p_broker_account_id: args.brokerAccountId,
            p_expected_provider: args.expectedProvider,
            p_target_provider: args.targetProvider,
            p_transition_writer_epoch: args.transitionWriterEpoch,
          })
          if (error || !Number.isSafeInteger(Number(data))) throw new Error("TRANSITION_FINISH_FAILED")
          return Number(data)
        },
        async abort(args) {
          const { data, error } = await supabase.rpc("abort_broker_provider_transition", {
            p_broker_account_id: args.brokerAccountId,
            p_expected_provider: args.expectedProvider,
            p_target_provider: args.targetProvider,
            p_transition_writer_epoch: args.transitionWriterEpoch,
          })
          return !error && data === true
        },
        sleep(ms) {
          return new Promise(resolve => setTimeout(resolve, ms))
        },
        log(event, fields) {
          console.info(JSON.stringify({ event, ...fields }))
        },
      },
    )
    return json(200, { ok: true, account: result })
  } catch (error) {
    if (error instanceof ProviderTransitionError) {
      return json(error.status, { error: error.message, code: error.code })
    }
    return json(500, { error: "Provider transition failed", code: "TRANSITION_FAILED" })
  }
})
