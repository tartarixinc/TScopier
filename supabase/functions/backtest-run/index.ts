import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import {
  parseSimpleConfig,
  toBacktestRunConfig,
  type BacktestRunMode,
} from "../_shared/backtest/config.ts"
import { countStoredBacktestSignals } from "../_shared/backtest/countSignals.ts"
import { executeBacktestRun } from "../_shared/backtest/runner.ts"
import { syncBacktestSignalsViaWorker } from "../_shared/backtest/workerSync.ts"
import {
  MassiveApiError,
  MassiveClient,
  sanitizeMarketDataErrorMessage,
} from "../_shared/massiveApi.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function bad(status: number, msg: string) {
  return Response.json({ error: msg }, { status, headers: corsHeaders })
}

async function startBacktestRun(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  simple: ReturnType<typeof parseSimpleConfig>,
  mode: BacktestRunMode,
  opts: { forceSync?: boolean },
): Promise<Response> {
  const cfg = toBacktestRunConfig(simple, mode)
  const runLabel = mode === "tpsl" ? "TP/SL backtest" : "Trade simulation"
  const name = `${runLabel} ${cfg.dateFrom} → ${cfg.dateTo}`

  const { data: run, error: insErr } = await supabase
    .from("backtest_runs")
    .insert({
      user_id: userId,
      name,
      status: "pending",
      config: { ...cfg, runMode: mode },
    })
    .select("id")
    .single()
  if (insErr) return bad(500, insErr.message)

  const runId = run.id as string
  await supabase.from("backtest_run_channels").insert(
    simple.channelIds.map((channel_id) => ({ run_id: runId, channel_id })),
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

  const runPromise = (async () => {
    await supabase.from("backtest_runs").update({
      status: "running",
      started_at: new Date().toISOString(),
      progress_pct: 5,
      progress_message: "Loading stored signals…",
    }).eq("id", runId)

    const importWarnings: string[] = []
    const existing = await countStoredBacktestSignals(
      supabase,
      userId,
      simple.channelIds,
      cfg.dateFrom,
      cfg.dateTo,
    )
    const shouldSync = opts.forceSync === true || existing === 0

    if (shouldSync) {
      await supabase.from("backtest_runs").update({
        progress_pct: 8,
        progress_message: "Syncing Telegram signals…",
      }).eq("id", runId)

      const sync = await syncBacktestSignalsViaWorker(
        Deno.env,
        userId,
        simple.channelIds,
        cfg.dateFrom,
        cfg.dateTo,
        { runId },
      )

      if (sync.messages_scanned === 0 && sync.imported === 0) {
        importWarnings.push(
          "0 messages from Telegram — check session and channel access",
        )
      } else if (sync.imported > 0) {
        importWarnings.unshift(
          `Synced ${sync.imported} tradeable signal(s) from Telegram`,
        )
      }
      importWarnings.push(...sync.errors)
    } else {
      importWarnings.push(
        "Using signals already in backtest_channel_signals (skipped Telegram sync)",
      )
    }

    await supabase.from("backtest_runs").update({
      progress_pct: 14,
      progress_message: "Fetching Massive market data…",
    }).eq("id", runId)

    await executeBacktestRun(
      supabase,
      massive,
      runId,
      userId,
      cfg,
      { importWarnings, mode },
    )
  })()
    .catch(async (e) => {
      const msg = sanitizeMarketDataErrorMessage(
        e instanceof Error ? e.message : String(e),
      )
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

  return Response.json({ ok: true, run_id: runId, run_mode: mode }, { headers: corsHeaders })
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
    const action = String(body.action ?? "run")

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

    if (action === "sync") {
      const simple = parseSimpleConfig((body.config ?? {}) as Record<string, unknown>)
      if (simple.channelIds.length === 0) return bad(400, "At least one channel required")

      const sync = await syncBacktestSignalsViaWorker(
        Deno.env,
        userId,
        simple.channelIds,
        simple.dateFrom,
        simple.dateTo,
      )

      return Response.json({
        ok: true,
        ...sync,
        table: "backtest_channel_signals",
      }, { headers: corsHeaders })
    }

    const runActions = new Set(["run", "backtest_tpsl", "simulate_trades"])
    if (runActions.has(action)) {
      const simple = parseSimpleConfig((body.config ?? {}) as Record<string, unknown>)
      if (simple.channelIds.length === 0) return bad(400, "At least one channel required")

      const mode: BacktestRunMode = action === "backtest_tpsl" ? "tpsl" : "simulate"
      const forceSync = body.force_sync === true

      return await startBacktestRun(supabase, userId, simple, mode, { forceSync })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (e) {
    const status = e instanceof MassiveApiError ? e.status : 500
    const msg = sanitizeMarketDataErrorMessage(
      e instanceof Error ? e.message : "Internal error",
    )
    return Response.json({ error: msg }, { status, headers: corsHeaders })
  }
})
