import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"
import { importTelegramHistoryForBacktest } from "../_shared/backtest/importTelegramHistory.ts"
import { listBacktestSymbolsInRange, loadBacktestSignals } from "../_shared/backtest/loadSignals.ts"
import { normalizeSymbolFilter } from "../_shared/backtest/symbols.ts"
import { executeBacktestRun } from "../_shared/backtest/runner.ts"
import type { BacktestRunConfig } from "../_shared/backtest/types.ts"
import { MassiveApiError, MassiveClient, massiveCallsPerMinuteFromEnv } from "../_shared/massiveApi.ts"

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
  symbols: [],
  dateFrom: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
  dateTo: new Date().toISOString().slice(0, 10),
  timeframe: "1m",
  executionMode: "minute_bars",
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

    if (action === "preview") {
      const cfg = { ...DEFAULT_CONFIG, ...(body.config as Partial<BacktestRunConfig> ?? {}) }
      const channelIds = Array.isArray(cfg.channelIds) ? cfg.channelIds.map(String).filter(Boolean) : []
      if (channelIds.length === 0) return bad(400, "At least one channel required")

      const fromIso = new Date(cfg.dateFrom).toISOString()
      const toIso = new Date(cfg.dateTo + "T23:59:59.999Z").toISOString()

      const channelNames = new Map<string, string>()
      const { data: chMeta } = await supabase
        .from("telegram_channels")
        .select("id, display_name")
        .in("id", channelIds)
      for (const ch of chMeta ?? []) {
        channelNames.set(ch.id as string, (ch.display_name as string) || "Channel")
      }

      const symbolFilter = normalizeSymbolFilter(cfg.symbols)
      const availableSymbols = await listBacktestSymbolsInRange(
        supabase,
        userId,
        channelIds,
        fromIso,
        toIso,
      )

      const loaded = await loadBacktestSignals(
        supabase,
        userId,
        channelIds,
        fromIso,
        toIso,
        channelNames,
        symbolFilter,
      )

      const { count: storedCount } = await supabase
        .from("backtest_channel_signals")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .in("channel_id", channelIds)
        .gte("signal_at", fromIso)
        .lte("signal_at", toIso)

      const massiveKey = (Deno.env.get("MASSIVE_API_KEY") ?? Deno.env.get("POLYGON_API_KEY") ?? "").trim()
      const massiveConfigured = Boolean(massiveKey)

      const callsPerMinute = massiveCallsPerMinuteFromEnv(Deno.env)
      // Skip live probe on preview — it burns the 5/min quota on every config change.
      const runLiveProbe = body.probe_massive === true

      let massiveProbe: { ok: boolean; error?: string; bars?: number } | undefined
      if (massiveConfigured && runLiveProbe) {
        const massive = MassiveClient.fromEnv(Deno.env)
        massiveProbe = await massive.probeConnectivity()
      }

      return Response.json({
        ok: true,
        tradeable_count: loaded.signals.length,
        stored_count: storedCount ?? 0,
        available_symbols: availableSymbols,
        symbols_filter: symbolFilter,
        massive_configured: massiveConfigured,
        massive_calls_per_minute: callsPerMinute,
        massive_probe: massiveProbe,
        signal_source: "backtest_channel_signals",
        copier_isolated: true,
      }, { headers: corsHeaders })
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

      const runPromise = (async () => {
        await supabase.from("backtest_runs").update({
          progress_pct: 1,
          progress_message: "Importing Telegram signal history for selected dates…",
        }).eq("id", runId)

        const imp = await importTelegramHistoryForBacktest(
          supabase,
          Deno.env,
          userId,
          channelIds,
          cfg.dateFrom,
          cfg.dateTo,
        )
        if (imp.errors.length) {
          console.warn("[backtest-run] telegram import warnings:", imp.errors.join("; "))
        }

        await executeBacktestRun(
          supabase,
          massive,
          runId,
          userId,
          cfg as BacktestRunConfig,
          {
            importWarnings: [
              ...imp.errors,
              ...(imp.imported === 0 && imp.messages_scanned === 0
                ? ["Telegram import returned 0 messages — using any signals already in backtest_channel_signals"]
                : []),
            ],
          },
        )
      })()
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
