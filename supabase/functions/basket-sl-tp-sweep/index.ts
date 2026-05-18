/**
 * basket-sl-tp-sweep — backup for failed/partial basket SL/TP reconcile jobs.
 *
 * Worker BasketSlTpReconcileMonitor is primary (15s). This edge function runs
 * every 60s via pg_cron and only claims jobs the worker has not touched for 45s+.
 */

// @ts-ignore Deno runtime
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
// @ts-ignore Deno-only
import { makeClientFromEnv, type MtPlatform } from "../_shared/metatraderapi.ts"
import {
  fetchOpenBrokerTickets,
  loadOpenBasketLegs,
  parsePerLegTargets,
  reconcileBackoffMs,
  runEdgeBasketLegModifies,
} from "../_shared/basketSlTpReconcile.ts"

// @ts-ignore Deno globals
declare const Deno: {
  env: { get(name: string): string | undefined }
  serve: (handler: (req: Request) => Response | Promise<Response>) => void
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const STALE_MS = 45_000
const MAX_JOBS = 30
const CLAIMED_BY = "edge"

type JobRow = {
  id: string
  user_id: string
  broker_account_id: string
  anchor_signal_id: string
  source_signal_id: string
  symbol: string
  direction: "buy" | "sell"
  per_leg_targets: unknown
  n_imm_cwe: number
  override_tp: number | null
  attempts: number
  max_attempts: number
  locked_at: string | null
}

function mtClient(env: { get(name: string): string | undefined }, platform: string) {
  const p: MtPlatform = platform === "MT4" ? "MT4" : "MT5"
  return makeClientFromEnv(env, p)
}

Deno.serve(async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "missing supabase env" }), { status: 500 })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const staleCutoff = new Date(Date.now() - STALE_MS).toISOString()
  const now = new Date().toISOString()

  const { data: jobs, error } = await supabase
    .from("basket_reconcile_jobs")
    .select("*")
    .in("status", ["pending", "claimed"])
    .lte("next_run_at", now)
    .or(`locked_at.is.null,locked_at.lt.${staleCutoff}`)
    .order("next_run_at", { ascending: true })
    .limit(MAX_JOBS)

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  let processed = 0
  let done = 0

  for (const job of (jobs ?? []) as JobRow[]) {
    if (job.attempts >= job.max_attempts) continue
    if (job.locked_at && job.locked_at >= staleCutoff && job.attempts > 0) continue

    const { data: claimed } = await supabase
      .from("basket_reconcile_jobs")
      .update({
        status: "claimed",
        locked_at: now,
        locked_by: CLAIMED_BY,
        attempts: job.attempts + 1,
        updated_at: now,
      })
      .eq("id", job.id)
      .in("status", ["pending", "claimed"])
      .or(`locked_at.is.null,locked_at.lt.${staleCutoff}`)
      .select("*")
      .maybeSingle()

    if (!claimed) continue
    processed += 1

    const row = claimed as JobRow
    const { data: broker } = await supabase
      .from("broker_accounts")
      .select("metaapi_account_id,platform,default_lot_size")
      .eq("id", row.broker_account_id)
      .maybeSingle()

    const uuid = broker?.metaapi_account_id as string | undefined
    if (!uuid || uuid.includes("|")) {
      await release(supabase, row.id, "invalid broker uuid", row.attempts)
      continue
    }

    const api = mtClient(Deno.env, String(broker?.platform ?? "MT5"))
    try {
      const alive = await api.keepSessionAlive(uuid)
      if (!alive) continue
    } catch (err) {
      await release(supabase, row.id, (err as Error).message, row.attempts)
      continue
    }

    const familyTrades = await loadOpenBasketLegs(
      supabase,
      row.broker_account_id,
      row.anchor_signal_id,
      row.symbol,
    )
    if (!familyTrades.length) {
      await supabase.from("basket_reconcile_jobs").update({ status: "done", updated_at: now }).eq("id", row.id)
      await supabase.from("basket_reconcile_legs").delete().eq("job_id", row.id)
      done += 1
      continue
    }

    const perLegTargets = parsePerLegTargets(row.per_leg_targets)
    if (!perLegTargets.length) {
      await release(supabase, row.id, "empty per_leg_targets", row.attempts)
      continue
    }

    let sp = { stopsLevel: 0, freezeLevel: 0, point: 0.00001, digits: 5 }
    try {
      sp = await api.symbolParams(uuid, row.symbol)
    } catch { /* optional */ }

    const openedTickets = await fetchOpenBrokerTickets(api, uuid)
    const result = await runEdgeBasketLegModifies({
      supabase,
      api,
      uuid,
      symbol: row.symbol,
      direction: row.direction,
      baseLot: Number(broker?.default_lot_size ?? 0.01),
      signalId: row.source_signal_id,
      userId: row.user_id,
      brokerAccountId: row.broker_account_id,
      familyTrades,
      perLegTargets,
      nImmCwe: row.n_imm_cwe ?? 0,
      overrideTp: row.override_tp,
      openedTickets,
      stopsLevel: sp.stopsLevel,
      freezeLevel: sp.freezeLevel,
      point: sp.point,
      digits: sp.digits,
    })

    const mergeFailed = result.modified < result.openLegs
    if (!mergeFailed) {
      await supabase.from("basket_reconcile_jobs").update({ status: "done", updated_at: now }).eq("id", row.id)
      await supabase.from("basket_reconcile_legs").delete().eq("job_id", row.id)
      await supabase
        .from("signals")
        .update({ status: "executed" })
        .eq("id", row.source_signal_id)
        .eq("status", "parsed")
      done += 1
    } else if (row.attempts >= row.max_attempts) {
      await supabase
        .from("basket_reconcile_jobs")
        .update({
          status: "failed",
          last_error: `edge: ${result.modified}/${result.openLegs}`,
          locked_at: null,
          locked_by: null,
          updated_at: now,
        })
        .eq("id", row.id)
    } else {
      const backoff = reconcileBackoffMs(row.attempts)
      await supabase
        .from("basket_reconcile_jobs")
        .update({
          status: "pending",
          last_error: `edge: ${result.modified}/${result.openLegs}`,
          next_run_at: new Date(Date.now() + backoff).toISOString(),
          locked_at: null,
          locked_by: null,
          updated_at: now,
        })
        .eq("id", row.id)
    }
  }

  return new Response(JSON.stringify({ processed, done }), {
    headers: { "Content-Type": "application/json" },
  })
})

// deno-lint-ignore no-explicit-any
async function release(supabase: any, jobId: string, err: string, attempts: number): Promise<void> {
  const backoff = reconcileBackoffMs(attempts)
  await supabase
    .from("basket_reconcile_jobs")
    .update({
      status: "pending",
      last_error: err,
      next_run_at: new Date(Date.now() + backoff).toISOString(),
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
}
