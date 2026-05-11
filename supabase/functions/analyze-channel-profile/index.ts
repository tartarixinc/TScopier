import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

/** Channel profiling previously used OpenAI; Copier now relies on per-channel keywords only. */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? ""
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    const { data: authData, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !authData.user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
    const userId = authData.user.id

    const body = await req.json()
    const channelId = String(body?.channel_id ?? "")
    const lookbackDays = Math.max(1, Math.min(90, Number(body?.lookback_days ?? 30)))
    if (!channelId) return Response.json({ error: "channel_id required" }, { status: 400, headers: corsHeaders })

    const { data: channel } = await supabase
      .from("telegram_channels")
      .select("id,user_id,display_name")
      .eq("id", channelId)
      .eq("user_id", userId)
      .maybeSingle()
    if (!channel) return Response.json({ error: "Channel not found" }, { status: 404, headers: corsHeaders })

    const payload = {
      user_id: userId,
      channel_id: channelId,
      lookback_days: lookbackDays,
      sample_size: 0,
      signal_type: "unknown",
      tp_style: "mixed",
      sl_style: "mixed",
      entry_type: "mixed",
      most_traded_asset: null,
      estimated_tp_pips: null,
      estimated_sl_pips: null,
      analysis_summary:
        "AI profiling is turned off. Define BUY/SELL/CLOSE and TP/SL phrases under Copier Engine — parse-signal uses those keywords and prices only.",
      meta: { profiling: "disabled", keywords_only: true },
      analyzed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const { data: upserted, error: upsertErr } = await supabase
      .from("channel_signal_profiles")
      .upsert(payload, { onConflict: "channel_id" })
      .select("*")
      .single()
    if (upsertErr) return Response.json({ error: upsertErr.message }, { status: 500, headers: corsHeaders })

    return Response.json({ ok: true, profile: upserted }, { headers: corsHeaders })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal server error"
    return Response.json({ error: msg }, { status: 500, headers: corsHeaders })
  }
})
