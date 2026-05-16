import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { executeBacktestRun } from "../_shared/backtest/runner.ts"
import type { BacktestRunConfig } from "../_shared/backtest/types.ts"
import { MassiveApiError, MassiveClient } from "../_shared/massiveApi.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

const DEFAULT_CONFIG: BacktestRunConfig = {
  channelIds: [],
  dateFrom: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
  dateTo: new Date().toISOString().slice(0, 10),
  timeframe: "1m",
  executionMode: "tick_quotes",
  initialBalance: 10_000,
  currency: "USD",
  sizingMode: "fixed_lot",
  fixedLot: 0.1,
  riskPercent: 1,
  strategy: {
    breakevenAfterTp: 1,
    partialClosePerTp: 0,
    intrabarPriority: "sl_first",
  },
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders })

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

    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const action = String(body.action ?? "create")

    if (action === "list") {
      const { data, error } = await supabase
        .from("backtest_runs")
        .select("id,name,status,progress_pct,progress_message,summary,created_at,completed_at,config")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(50)
      if (error) return bad(500, error.message)
      return Response.json({ ok: true, runs: data ?? [] }, { headers: corsHeaders })
    }

    if (action === "get") {
      const runId = String(body.run_id ?? "")
      if (!runId) return bad(400, "run_id required")
      const { data: run, error } = await supabase
        .from("backtest_runs")
        .select("*")
        .eq("id", runId)
        .eq("user_id", userId)
        .maybeSingle()
      if (error) return bad(500, error.message)
      if (!run) return bad(404, "Run not found")

      const [{ data: trades }, { data: equity }] = await Promise.all([
        supabase.from("backtest_trades").select("*").eq("run_id", runId).order("signal_at"),
        supabase.from("backtest_equity_points").select("*").eq("run_id", runId).order("ts"),
      ])

      return Response.json({
        ok: true,
        run,
        trades: trades ?? [],
        equity: equity ?? [],
      }, { headers: corsHeaders })
    }

    if (action === "create") {
      const cfg = { ...DEFAULT_CONFIG, ...(body.config as Partial<BacktestRunConfig> ?? {}) }
      const channelIds = Array.isArray(cfg.channelIds) ? cfg.channelIds.map(String).filter(Boolean) : []
      if (channelIds.length === 0) return bad(400, "At least one channel required")

      const name = String(body.name ?? `Backtest ${cfg.dateFrom} → ${cfg.dateTo}`).trim()

      const { data: run, error: insErr } = await supabase
        .from("backtest_runs")
        .insert({
          user_id: userId,
          name,
          status: "pending",
          config: cfg,
        })
        .select("id")
        .single()
      if (insErr) return bad(500, insErr.message)

      const runId = run.id as string
      await supabase.from("backtest_run_channels").insert(
        channelIds.map((channel_id) => ({ run_id: runId, channel_id })),
      )

      const massiveKey = Deno.env.get("MASSIVE_API_KEY") ?? Deno.env.get("POLYGON_API_KEY") ?? ""
      if (!massiveKey.trim()) {
        await supabase.from("backtest_runs").update({
          status: "failed",
          error_message: "MASSIVE_API_KEY not configured on server",
        }).eq("id", runId)
        return bad(503, "MASSIVE_API_KEY not configured")
      }

      const massive = MassiveClient.fromEnv(Deno.env)

      const runPromise = executeBacktestRun(supabase, massive, runId, userId, cfg as BacktestRunConfig)
        .catch(async (e) => {
          const msg = e instanceof Error ? e.message : String(e)
          await supabase.from("backtest_runs").update({
            status: "failed",
            error_message: msg,
            completed_at: new Date().toISOString(),
          }).eq("id", runId)
        })

      // @ts-ignore EdgeRuntime.waitUntil
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        EdgeRuntime.waitUntil(runPromise)
      } else {
        await runPromise
      }

      return Response.json({ ok: true, run_id: runId }, { headers: corsHeaders })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (e) {
    const status = e instanceof MassiveApiError ? e.status : 500
    const msg = e instanceof Error ? e.message : "Internal error"
    return Response.json({ error: msg }, { status, headers: corsHeaders })
  }
})
