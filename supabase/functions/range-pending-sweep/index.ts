/**
 * range-pending-sweep — backup poller for `range_pending_legs`.
 *
 * The worker (worker/src/virtualPendingMonitor.ts) is the primary firer with a
 * 1.5s tick. This edge function runs every minute via pg_cron + net.http_post
 * (see supabase/migrations/20260512131000_range_pending_cron.sql) and only
 * touches rows the worker hasn't claimed for 45+ seconds — i.e. rows the
 * worker probably missed during a restart, deploy, or outage.
 *
 * Same trigger semantics as the worker:
 *   buy ladder  → fire when bid <= trigger_price
 *   sell ladder → fire when ask >= trigger_price
 *
 * Same CAS claim model: UPDATE status='pending' to 'claimed' wins exactly once.
 */

// @ts-ignore - Deno runtime resolves these
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
// @ts-ignore - Deno-only import
import { makeClientFromEnv, MetatraderApiClient } from "../_shared/metatraderapi.ts"

// @ts-ignore Deno globals
declare const Deno: { env: { get(name: string): string | undefined }; serve: (handler: (req: Request) => Response | Promise<Response>) => void }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const SWEEP_AGE_MS = 45_000
const MAX_ROWS_PER_SWEEP = 200
const CLAIMED_BY = "edge"

interface PendingRow {
  id: string
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  step_idx: number
  is_buy: boolean
  volume: number
  trigger_price: number
  stoploss: number | null
  takeprofit: number | null
  slippage: number
  comment: string | null
  expert_id: number | null
}

Deno.serve(async (_req: Request) => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "missing Supabase env" }), { status: 500 })
  }
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const api: MetatraderApiClient = makeClientFromEnv(Deno.env)

  // Expire stale rows first so we don't bother quoting them.
  const nowIso = new Date().toISOString()
  await sb
    .from("range_pending_legs")
    .update({ status: "expired" })
    .eq("status", "pending")
    .not("expires_at", "is", null)
    .lt("expires_at", nowIso)

  // Only sweep rows the worker has probably missed: untouched for SWEEP_AGE_MS+.
  const ageCut = new Date(Date.now() - SWEEP_AGE_MS).toISOString()
  const { data, error } = await sb
    .from("range_pending_legs")
    .select(
      "id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,step_idx,is_buy,volume,trigger_price,stoploss,takeprofit,slippage,comment,expert_id",
    )
    .eq("status", "pending")
    .lt("created_at", ageCut)
    .limit(MAX_ROWS_PER_SWEEP)
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
  const rows = (data ?? []) as PendingRow[]
  if (!rows.length) {
    return new Response(JSON.stringify({ rows: 0, triggered: 0, fired: 0 }), { status: 200 })
  }

  // Group by (account, symbol) to coalesce /Quote calls.
  const groups = new Map<string, PendingRow[]>()
  for (const r of rows) {
    const key = `${r.metaapi_account_id}|${r.symbol}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  let triggered = 0
  let firedOk = 0
  let firedErr = 0

  for (const [key, legs] of groups.entries()) {
    const [uuid, symbol] = key.split("|")
    if (!uuid || !symbol) continue
    let q: { bid: number; ask: number }
    try {
      q = await api.quote(uuid, symbol)
    } catch (err) {
      console.warn(`[range-pending-sweep] /Quote failed for ${symbol}: ${(err as Error).message}`)
      continue
    }
    for (const leg of legs) {
      const ref = leg.is_buy ? q.bid : q.ask
      const hit = leg.is_buy ? ref <= leg.trigger_price : ref >= leg.trigger_price
      if (!hit) continue
      triggered += 1
      const ok = await fireLeg(sb, api, leg, q.bid, q.ask)
      if (ok) firedOk += 1
      else firedErr += 1
    }
  }

  return new Response(JSON.stringify({ rows: rows.length, groups: groups.size, triggered, fired_ok: firedOk, fired_err: firedErr }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
})

async function fireLeg(
  // deno-lint-ignore no-explicit-any
  sb: any,
  api: MetatraderApiClient,
  leg: PendingRow,
  bid: number,
  ask: number,
): Promise<boolean> {
  // CAS claim — the worker monitor may grab it under us; that's fine.
  const { data: claimed, error: claimErr } = await sb
    .from("range_pending_legs")
    .update({ status: "claimed", claimed_at: new Date().toISOString(), claimed_by: CLAIMED_BY })
    .eq("id", leg.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle()
  if (claimErr) {
    console.warn(`[range-pending-sweep] claim error leg=${leg.id}: ${claimErr.message}`)
    return false
  }
  if (!claimed) return false
  const staleReason = await getStaleLegReason(sb, leg)
  if (staleReason) {
    await cancelClaimedLeg(sb, leg, staleReason)
    return true
  }

  // Last-second SL/TP clamp. The original anchor's clamp may be too tight if
  // freeze/stops_level widened in the meantime; pulling SymbolParams here keeps
  // us aligned with current broker constraints.
  let sl = leg.stoploss ?? 0
  let tp = leg.takeprofit ?? 0
  try {
    const params = await api.symbolParams(leg.metaapi_account_id, leg.symbol)
    const minLevel = Math.max(params.stopsLevel, params.freezeLevel)
    const minDist = (minLevel + 2) * params.point
    if (minDist > 0) {
      const ref = leg.is_buy ? ask : bid
      const digits = Math.max(0, Math.min(8, Math.floor(params.digits)))
      const round = (v: number) => Number(v.toFixed(digits))
      if (leg.is_buy) {
        if (sl > 0 && ref - sl < minDist) sl = round(ref - minDist)
        if (tp > 0 && tp - ref < minDist) tp = round(ref + minDist)
      } else {
        if (sl > 0 && sl - ref < minDist) sl = round(ref + minDist)
        if (tp > 0 && ref - tp < minDist) tp = round(ref - minDist)
      }
    }
  } catch { /* clamp is best-effort; if SymbolParams fails we fire as-is */ }

  const refPrice = leg.is_buy ? ask : bid
  try {
    const result = await api.orderSend(leg.metaapi_account_id, {
      symbol: leg.symbol,
      operation: leg.is_buy ? "Buy" : "Sell",
      volume: leg.volume,
      slippage: leg.slippage ?? 20,
      stoploss: sl,
      takeprofit: tp,
      comment: leg.comment ?? `TSCopier:rg${leg.step_idx}`,
      expertID: leg.expert_id ?? 909090,
    })
    await sb.from("range_pending_legs")
      .update({
        status: "fired",
        fired_at: new Date().toISOString(),
        ticket: result.ticket != null ? String(result.ticket) : null,
      })
      .eq("id", leg.id)
    await sb.from("trades").insert({
      user_id: leg.user_id,
      signal_id: leg.signal_id,
      broker_account_id: leg.broker_account_id,
      metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
      symbol: leg.symbol,
      direction: leg.is_buy ? "buy" : "sell",
      entry_price: result.openPrice ?? refPrice,
      sl: result.stopLoss ?? sl,
      tp: result.takeProfit ?? tp,
      lot_size: result.lots ?? leg.volume,
      status: "open",
      opened_at: new Date().toISOString(),
    })
    await sb.from("trade_execution_logs").insert({
      user_id: leg.user_id,
      signal_id: leg.signal_id,
      broker_account_id: leg.broker_account_id,
      action: "virtual_pending_fired",
      status: "success",
      request_payload: { leg_id: leg.id, step_idx: leg.step_idx, trigger_price: leg.trigger_price, ref_price: refPrice, claimed_by: CLAIMED_BY },
      response_payload: { ticket: result.ticket },
    })
    return true
  } catch (err) {
    const msg = (err as Error).message
    await sb.from("range_pending_legs")
      .update({ status: "failed", error_message: msg, fired_at: new Date().toISOString() })
      .eq("id", leg.id)
    await sb.from("trade_execution_logs").insert({
      user_id: leg.user_id,
      signal_id: leg.signal_id,
      broker_account_id: leg.broker_account_id,
      action: "virtual_pending_failed",
      status: "failed",
      request_payload: { leg_id: leg.id, step_idx: leg.step_idx, claimed_by: CLAIMED_BY },
      error_message: msg,
    })
    return false
  }
}

async function getStaleLegReason(
  // deno-lint-ignore no-explicit-any
  sb: any,
  leg: PendingRow,
): Promise<string | null> {
  const { data, error } = await sb
    .from("trades")
    .select("status")
    .eq("signal_id", leg.signal_id)
    .eq("broker_account_id", leg.broker_account_id)
    .eq("symbol", leg.symbol)
    .limit(200)
  if (error) {
    console.warn(`[range-pending-sweep] stale-check failed leg=${leg.id}: ${error.message}`)
    return null
  }
  const rows = (data ?? []) as Array<{ status: string | null }>
  if (!rows.length) return null
  const hasOpen = rows.some(r => r.status === "open" || r.status === "pending")
  return hasOpen ? null : "signal_closed"
}

async function cancelClaimedLeg(
  // deno-lint-ignore no-explicit-any
  sb: any,
  leg: PendingRow,
  reason: string,
): Promise<void> {
  await sb.from("range_pending_legs")
    .update({
      status: "cancelled",
      error_message: reason,
      fired_at: new Date().toISOString(),
    })
    .eq("id", leg.id)
    .eq("status", "claimed")
  try {
    await sb.from("trade_execution_logs").insert({
      user_id: leg.user_id,
      signal_id: leg.signal_id,
      broker_account_id: leg.broker_account_id,
      action: "virtual_pending_cancelled",
      status: "info",
      request_payload: {
        leg_id: leg.id,
        step_idx: leg.step_idx,
        symbol: leg.symbol,
        reason,
        claimed_by: CLAIMED_BY,
      },
    })
  } catch {
    // Logging failure is non-fatal.
  }
}
