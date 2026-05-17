import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { parseSimpleConfig, toBacktestRunConfig } from "../_shared/backtest/config.ts"
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

    if (action === "run") {
      const simple = parseSimpleConfig((body.config ?? {}) as Record<string, unknown>)
      if (simple.channelIds.length === 0) return bad(400, "At least one channel required")

      const cfg = toBacktestRunConfig(simple)
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
          progress_pct: 2,
          progress_message: "Syncing Telegram signals…",
        }).eq("id", runId)

        const sync = await syncBacktestSignalsViaWorker(
          Deno.env,
          userId,
          simple.channelIds,
          cfg.dateFrom,
          cfg.dateTo,
          {
            runId,
            onChannelStart: async (i, channelId) => {
              const n = simple.channelIds.length
              await supabase.from("backtest_runs").update({
                progress_message: n > 1
                  ? `Syncing Telegram (${i + 1}/${n} channels)…`
                  : "Syncing Telegram signals…",
                progress_pct: 2,
                updated_at: new Date().toISOString(),
              }).eq("id", runId)
              void channelId
            },
          },
        )

        await supabase.from("backtest_runs").update({
          progress_pct: 14,
          progress_message: sync.imported > 0
            ? `Stored ${sync.imported} signal(s) in backtest_channel_signals — loading for simulation…`
            : "No tradeable signals stored — check sync warnings",
          updated_at: new Date().toISOString(),
        }).eq("id", runId)

        const importWarnings = [...sync.errors]
        if (sync.messages_scanned === 0 && sync.imported === 0) {
          importWarnings.push(
            "0 messages from Telegram — check session and channel access",
          )
        } else if (sync.imported > 0) {
          importWarnings.unshift(
            `Synced ${sync.imported} tradeable signal(s) (${sync.candidates} candidates, ${sync.messages_scanned} Telegram messages scanned)`,
          )
        }

        await executeBacktestRun(
          supabase,
          massive,
          runId,
          userId,
          cfg,
          { importWarnings },
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

      return Response.json({ ok: true, run_id: runId }, { headers: corsHeaders })
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
