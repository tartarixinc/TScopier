import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import {
  corsHeaders,
  isMetatraderConfigured,
  type ParsedSignal,
  runExecuteTradeFromPayload,
} from "../_shared/trade_execution.ts"

/** With verify_jwt=false on this function: require service role secret (new keys use apikey header, not Bearer). */
function authorizeExecuteCaller(req: Request): boolean {
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!svc) return false
  const apikey = req.headers.get("apikey") ?? ""
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^\s*Bearer\s+/i, "").trim()
  return apikey === svc || bearer === svc
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  if (!authorizeExecuteCaller(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
  }

  if (!isMetatraderConfigured()) {
    return Response.json({ error: "METATRADERAPI_KEY is not configured" }, { status: 503, headers: corsHeaders })
  }

  try {
    const body = await req.json() as { signal_id?: string; parsed?: ParsedSignal }
    return await runExecuteTradeFromPayload({
      signal_id: String(body.signal_id ?? ""),
      parsed: body.parsed as ParsedSignal,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("execute-trade error:", message)
    return Response.json({ error: message }, { status: 400, headers: corsHeaders })
  }
})
