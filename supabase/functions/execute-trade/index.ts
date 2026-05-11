import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function authorize(req: Request): boolean {
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!svc) return false
  const apikey = req.headers.get("apikey") ?? ""
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^\s*Bearer\s+/i, "").trim()
  return apikey === svc || bearer === svc
}

/**
 * Legacy endpoint kept for worker compatibility. Broker execution was removed;
 * instructions are parsed in `parse-signal` only and stored on `signals.parsed_data`.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }
  if (!authorize(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
  }

  try {
    const body = await req.json() as { signal_id?: string }
    const signal_id = body.signal_id
    if (!signal_id) {
      return Response.json({ error: "signal_id required" }, { status: 400, headers: corsHeaders })
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const { data: signal } = await supabase
      .from("signals")
      .select("user_id")
      .eq("id", signal_id)
      .maybeSingle()

    if (signal?.user_id) {
      await supabase.from("trade_execution_logs").insert({
        user_id: signal.user_id as string,
        signal_id,
        broker_account_id: null,
        action: "execute_trade_stub",
        status: "success",
        request_payload: { note: "Broker layer removed; no order sent." },
        response_payload: null,
        error_message: null,
      })
    }

    return Response.json({
      executed: false,
      parsed_only: true,
      message: "Broker execution is disabled. Use signals.parsed_data from parse-signal.",
      results: [],
    }, { headers: corsHeaders })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
