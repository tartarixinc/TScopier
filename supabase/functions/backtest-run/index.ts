import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import {
  parseSimpleConfig,
  toBacktestRunConfig,
  type BacktestRunMode,
} from "../_shared/backtest/config.ts"
import { sanitizeMarketDataErrorMessage } from "../_shared/backtest/fxsocketMarketData.ts"
import { executeBacktestRun } from "../_shared/backtest/runner.ts"
import {
  deleteBacktestTrade,
  resimulateBacktestTrade,
} from "../_shared/backtest/resimulateTrade.ts"
import {
  BacktestBrokerNotFoundError,
  BacktestSymbolNotFoundError,
  resolveBacktestBroker,
} from "../_shared/backtest/resolveBacktestBroker.ts"
import { syncBacktestSignalsViaWorker } from "../_shared/backtest/workerSync.ts"
import {
  assertBacktestMonthlyLimit,
  loadUserSubscription,
} from "../_shared/subscriptionAccess.ts"
import {
  FxsocketApiError,
  FxsocketClient,
  isFxsocketConfigured,
} from "../_shared/fxsocketClient.ts"

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
  _opts: { forceSync?: boolean },
): Promise<Response> {
  const cfg = toBacktestRunConfig(simple, mode)
  const runLabel = mode === "tpsl" ? "TP/SL backtest" : "Trade simulation"
  const name = `${runLabel} ${cfg.dateFrom} → ${cfg.dateTo}`

  const symbolFilter = cfg.symbols ?? []
  if (symbolFilter.length === 0) {
    return bad(400, "Select a symbol to backtest (profile signals first).")
  }

  if (!isFxsocketConfigured(Deno.env)) {
    return bad(503, "FXSOCKET_API_KEY not configured")
  }

  const fx = new FxsocketClient(Deno.env)

  try {
    await resolveBacktestBroker(supabase, fx, userId, symbolFilter[0]!)
  } catch (e) {
    if (e instanceof BacktestBrokerNotFoundError) {
      return bad(400, e.message)
    }
    if (e instanceof BacktestSymbolNotFoundError) {
      return bad(400, e.message)
    }
    throw e
  }

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

  const runPromise = (async () => {
    const importWarnings: string[] = []

    await supabase.from("backtest_runs").update({
      status: "running",
      started_at: new Date().toISOString(),
      progress_pct: 8,
      progress_message: `Backtesting ${symbolFilter.join(", ")}…`,
    }).eq("id", runId)

    await executeBacktestRun(
      supabase,
      fx,
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

      const { data: run, error: insErr } = await supabase
        .from("backtest_runs")
        .insert({
          user_id: userId,
          name: `Signal sync ${simple.dateFrom} → ${simple.dateTo}`,
          status: "running",
          progress_pct: 0,
          progress_message: "Pulling signals from Telegram…",
          config: { ...simple, syncOnly: true },
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      if (insErr) return bad(500, insErr.message)

      const runId = run.id as string

      const syncPromise = (async () => {
        try {
          const sync = await syncBacktestSignalsViaWorker(
            Deno.env,
            userId,
            simple.channelIds,
            simple.dateFrom,
            simple.dateTo,
            {
              runId,
              onChannelStart: async (index) => {
                const pct = simple.channelIds.length > 0
                  ? Math.max(1, Math.floor((index / simple.channelIds.length) * 4))
                  : 1
                await supabase.from("backtest_runs").update({
                  progress_pct: pct,
                  progress_message: `Pulling signals from Telegram (channel ${index + 1}/${simple.channelIds.length})…`,
                  updated_at: new Date().toISOString(),
                }).eq("id", runId).eq("user_id", userId)
              },
            },
          )
          const progressMsg = sync.imported > 0
            ? `Imported ${sync.imported} signal(s) from ${sync.messages_scanned} messages`
            : `Scanned ${sync.messages_scanned} message(s)`
          await supabase.from("backtest_runs").update({
            status: "completed",
            progress_pct: 100,
            progress_message: progressMsg,
            summary: sync,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", runId)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          await supabase.from("backtest_runs").update({
            status: "failed",
            error_message: msg,
            progress_pct: 100,
            progress_message: msg,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", runId)
        }
      })()

      // @ts-ignore EdgeRuntime.waitUntil
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        EdgeRuntime.waitUntil(syncPromise)
      } else {
        await syncPromise
      }

      return Response.json({
        ok: true,
        sync_run_id: runId,
        table: "backtest_channel_signals",
      }, { headers: corsHeaders })
    }

    if (action === "simulate_trades") {
      return bad(400, "Trade simulation is disabled. Use backtest_tpsl for TP/SL and pip analysis.")
    }

    if (action === "resimulate_trade") {
      const tradeId = String(body.trade_id ?? "")
      if (!tradeId) return bad(400, "trade_id required")

      const direction = body.direction != null
        ? (String(body.direction).toLowerCase() === "sell" ? "sell" : "buy")
        : undefined
      const entryRaw = body.entry_price
      const entry_price = entryRaw != null && entryRaw !== ""
        ? Number(entryRaw)
        : undefined
      const slRaw = body.sl
      const sl = slRaw === null || slRaw === ""
        ? null
        : slRaw !== undefined
          ? Number(slRaw)
          : undefined
      const tp_levels = Array.isArray(body.tp_levels)
        ? body.tp_levels.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0)
        : undefined

      if (entry_price !== undefined && !(entry_price > 0)) {
        return bad(400, "entry_price must be a positive number")
      }
      if (sl !== undefined && sl !== null && !(sl > 0)) {
        return bad(400, "sl must be a positive number or empty")
      }

      if (!isFxsocketConfigured(Deno.env)) {
        return bad(503, "FXSOCKET_API_KEY not configured")
      }
      const fx = new FxsocketClient(Deno.env)

      const trade = await resimulateBacktestTrade(supabase, fx, userId, tradeId, {
        direction,
        entry_price,
        sl,
        tp_levels,
      })

      const { data: run } = await supabase
        .from("backtest_runs")
        .select("*")
        .eq("id", trade.run_id)
        .eq("user_id", userId)
        .maybeSingle()

      return Response.json({ ok: true, trade, run }, { headers: corsHeaders })
    }

    if (action === "delete_trade") {
      const tradeId = String(body.trade_id ?? "")
      if (!tradeId) return bad(400, "trade_id required")

      const { run_id } = await deleteBacktestTrade(supabase, userId, tradeId)
      const { data: run } = await supabase
        .from("backtest_runs")
        .select("*")
        .eq("id", run_id)
        .eq("user_id", userId)
        .maybeSingle()

      return Response.json({ ok: true, run_id, run }, { headers: corsHeaders })
    }

    if (action === "backtest_tpsl" || action === "run") {
      const simple = parseSimpleConfig((body.config ?? {}) as Record<string, unknown>)
      if (simple.channelIds.length === 0) return bad(400, "At least one channel required")

      const sub = await loadUserSubscription(supabase, userId)
      const denied = await assertBacktestMonthlyLimit(supabase, userId, sub)
      if (denied) {
        const payload = await denied.json() as { error?: string }
        return bad(denied.status, String(payload.error ?? "Forbidden"))
      }

      return await startBacktestRun(supabase, userId, simple, "tpsl", { forceSync: false })
    }

    return bad(400, `Unknown action: ${action}`)
  } catch (e) {
    const status = e instanceof FxsocketApiError ? e.status
      : e instanceof BacktestBrokerNotFoundError || e instanceof BacktestSymbolNotFoundError ? 400
      : 500
    const msg = sanitizeMarketDataErrorMessage(
      e instanceof Error ? e.message : "Internal error",
    )
    return Response.json({ error: msg }, { status, headers: corsHeaders })
  }
})
