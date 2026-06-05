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
 *
 * Same ladder discipline as the worker: at most one leg fires per
 * (signal, broker, symbol) per invocation — shallowest triggered rung with no
 * shallower pending/claimed row.
 *
 * Expired TTL rows and successful fires set `status` to `expired` / `fired`
 * (rows are retained for ladder history — same as the worker).
 */

// @ts-ignore - Deno runtime resolves these
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4"
// @ts-ignore - Deno-only import
import { makeClientFromEnv, MetatraderApiClient, type MtPlatform } from "../_shared/metatraderapi.ts"
import { tryApplyBasketFollowUpToNewFill } from "../_shared/basketModFollowUp.ts"
import { shouldBlockVirtualLegFire } from "../_shared/rangePendingFireGuard.ts"
import {
  loadRangeLayerTillCloseForSignal,
  stopRangeLayeringUnlessEnabled,
} from "../_shared/rangeLayerTillClose.ts"

function mtClient(env: { get(name: string): string | undefined }, platform: string): MetatraderApiClient {
  const p: MtPlatform = platform === "MT4" ? "MT4" : "MT5"
  return makeClientFromEnv(env, p)
}

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

interface BasketOpenTpRow {
  signal_id: string
  broker_account_id: string
  user_id: string
  direction: string
  tp: number | null
}

function isTriggeredSweep(leg: PendingRow, bid: number, ask: number): boolean {
  const t = leg.trigger_price
  if (!Number.isFinite(t) || t <= 0) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false
  return leg.is_buy ? bid <= t : ask >= t
}

function isBlockedByShallowerSweep(
  leg: PendingRow,
  activeStepsByBasket: Map<string, Set<number>>,
): boolean {
  const bk = `${leg.signal_id}|${leg.broker_account_id}`
  const steps = activeStepsByBasket.get(bk)
  if (!steps) return false
  for (const s of steps) {
    if (s < leg.step_idx) return true
  }
  return false
}

async function detectAndLockTpTouchedBasketsSweep(
  // deno-lint-ignore no-explicit-any
  sb: any,
  legs: PendingRow[],
  bid: number,
  ask: number,
): Promise<Set<string>> {
  const touched = new Set<string>()
  if (!legs.length) return touched

  const signalIds = [...new Set(legs.map(l => l.signal_id))]
  const brokerIds = [...new Set(legs.map(l => l.broker_account_id))]
  const symbol = legs[0]?.symbol ?? null
  if (!symbol) return touched

  const { data, error } = await sb
    .from("trades")
    .select("signal_id,broker_account_id,user_id,direction,tp")
    .in("signal_id", signalIds)
    .in("broker_account_id", brokerIds)
    .eq("symbol", symbol)
    .eq("status", "open")
    .not("tp", "is", null)
  if (error) {
    console.warn(`[range-pending-sweep] tp-touch scan failed: ${error.message}`)
    return touched
  }

  const byBasket = new Map<string, BasketOpenTpRow[]>()
  for (const row of (data ?? []) as BasketOpenTpRow[]) {
    const tp = Number(row.tp)
    if (!Number.isFinite(tp) || tp <= 0) continue
    const basketKey = `${row.signal_id}|${row.broker_account_id}`
    const arr = byBasket.get(basketKey) ?? []
    arr.push({ ...row, tp })
    byBasket.set(basketKey, arr)
  }

  for (const [basketKey, rows] of byBasket) {
    const direction = String(rows[0]?.direction ?? "").toLowerCase()
    const tps = rows
      .map(r => Number(r.tp))
      .filter(tp => Number.isFinite(tp) && tp > 0)
    if (!tps.length) continue

    let touchedNow = false
    let triggerPrice: number | null = null
    let triggerSide: "bid" | "ask" | null = null
    if (direction === "buy") {
      triggerPrice = Math.min(...tps)
      touchedNow = bid >= triggerPrice
      triggerSide = "bid"
    } else if (direction === "sell") {
      triggerPrice = Math.max(...tps)
      touchedNow = ask <= triggerPrice
      triggerSide = "ask"
    }
    if (!touchedNow) continue

    const [signalId, brokerAccountId] = basketKey.split("|")
    if (!signalId || !brokerAccountId) continue
    const userId = rows[0]?.user_id
    if (!userId) continue

    const layerTillClose = await loadRangeLayerTillCloseForSignal(sb, signalId, brokerAccountId)
    if (layerTillClose) continue

    const { stopped, deleted } = await stopRangeLayeringUnlessEnabled(
      sb,
      { signalId, brokerAccountId, symbol, userId },
      "tp_touched",
    )
    if (!stopped) continue
    touched.add(basketKey)
    try {
      await sb.from("trade_execution_logs").insert({
        user_id: userId,
        signal_id: signalId,
        broker_account_id: brokerAccountId,
        action: "virtual_pending_tp_lock",
        status: "info",
        request_payload: {
          symbol,
          direction,
          trigger_price: triggerPrice,
          trigger_side: triggerSide,
          bid,
          ask,
          deleted_rows: deleted,
          lock_reason: "layering_stopped",
          claimed_by: CLAIMED_BY,
        },
      })
    } catch {
      /* best-effort */
    }
  }

  return touched
}

async function fetchShallowActiveStepsSweep(
  // deno-lint-ignore no-explicit-any
  sb: any,
  metaapiAccountId: string,
  symbol: string,
  signalIds: string[],
): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>()
  if (!signalIds.length) return out
  const { data, error } = await sb
    .from("range_pending_legs")
    .select("signal_id, broker_account_id, step_idx")
    .eq("metaapi_account_id", metaapiAccountId)
    .eq("symbol", symbol)
    .in("signal_id", signalIds)
    .in("status", ["pending", "claimed"])
    .not("comment", "ilike", "%:strictEntry%")
    .not("comment", "ilike", "%:strictEntryAgg%")
  if (error) {
    console.warn(`[range-pending-sweep] fetchShallowActiveSteps failed: ${error.message}`)
    return out
  }
  for (const r of (data ?? []) as Array<{ signal_id: string; broker_account_id: string; step_idx: number }>) {
    const bk = `${r.signal_id}|${r.broker_account_id}`
    const s = out.get(bk) ?? new Set<number>()
    s.add(r.step_idx)
    out.set(bk, s)
  }
  return out
}

Deno.serve(async (_req: Request) => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "missing Supabase env" }), { status: 500 })
  }
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  // Expire stale rows first so we don't bother quoting them.
  const nowIso = new Date().toISOString()
  await sb
    .from("range_pending_legs")
    .update({ status: "expired", error_message: "pending_expiry" })
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
    .not("comment", "ilike", "%:strictEntry%")
    .not("comment", "ilike", "%:strictEntryAgg%")
    .limit(MAX_ROWS_PER_SWEEP)
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
  const rows = (data ?? []) as PendingRow[]
  if (!rows.length) {
    return new Response(JSON.stringify({ rows: 0, triggered: 0, fired: 0 }), { status: 200 })
  }

  const accountIds = [...new Set(rows.map((r) => r.metaapi_account_id).filter(Boolean))]
  const { data: brokerPlatforms } = await sb
    .from("broker_accounts")
    .select("metaapi_account_id,platform")
    .in("metaapi_account_id", accountIds)
  const platformByUuid = new Map<string, MtPlatform>()
  for (const row of brokerPlatforms ?? []) {
    const id = String((row as { metaapi_account_id?: string }).metaapi_account_id ?? "").trim()
    if (!id) continue
    const plat = String((row as { platform?: string }).platform ?? "MT5")
    platformByUuid.set(id, plat === "MT4" ? "MT4" : "MT5")
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
    const api = mtClient(Deno.env, platformByUuid.get(uuid) ?? "MT5")
    let q: { bid: number; ask: number }
    try {
      q = await api.quote(uuid, symbol)
    } catch (err) {
      console.warn(`[range-pending-sweep] /Quote failed for ${symbol}: ${(err as Error).message}`)
      continue
    }
    const tpTouchedBaskets = await detectAndLockTpTouchedBasketsSweep(sb, legs, q.bid, q.ask)
    const triggeredInGroup: PendingRow[] = []
    for (const leg of legs) {
      const basketKey = `${leg.signal_id}|${leg.broker_account_id}`
      if (tpTouchedBaskets.has(basketKey)) continue
      if (isTriggeredSweep(leg, q.bid, q.ask)) triggeredInGroup.push(leg)
    }

    const cancelledStaleIds = new Set<string>()
    for (const leg of triggeredInGroup) {
      const staleEarly = await getStaleLegReason(sb, leg)
      if (!staleEarly) continue
      const { data: dropped } = await sb
        .from("range_pending_legs")
        .update({ status: "cancelled", error_message: staleEarly })
        .eq("id", leg.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle()
      if (dropped) {
        cancelledStaleIds.add(leg.id)
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
              reason: staleEarly,
              phase: "pre_claim_stale",
              claimed_by: CLAIMED_BY,
            },
          })
        } catch {
          /* best-effort */
        }
      }
    }

    const signalIds = [...new Set(legs.map((l) => l.signal_id))]
    const activeStepsByBasket = await fetchShallowActiveStepsSweep(sb, uuid, symbol, signalIds)

    const byBasket = new Map<string, PendingRow[]>()
    for (const leg of triggeredInGroup) {
      if (cancelledStaleIds.has(leg.id)) continue
      if (!isTriggeredSweep(leg, q.bid, q.ask)) continue
      if (isBlockedByShallowerSweep(leg, activeStepsByBasket)) continue
      const bk = `${leg.signal_id}|${leg.broker_account_id}`
      const arr = byBasket.get(bk) ?? []
      arr.push(leg)
      byBasket.set(bk, arr)
    }

    for (const [, arr] of byBasket) {
      arr.sort((a, b) => a.step_idx - b.step_idx || a.id.localeCompare(b.id))
      const winner = arr[0]
      if (!winner) continue
      triggered += 1
      const ok = await fireLeg(sb, api, winner, q.bid, q.ask)
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
  const layerTillClose = await loadRangeLayerTillCloseForSignal(
    sb,
    leg.signal_id,
    leg.broker_account_id,
  )
  const block = await shouldBlockVirtualLegFire(sb, leg, { layerTillClose })
  if (block.block) {
    console.log(
      `[range-pending-sweep] skip fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: ${block.reason ?? "blocked"}`,
    )
    return false
  }

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
    await sb
      .from("range_pending_legs")
      .update({
        status: "fired",
        fired_at: new Date().toISOString(),
        ticket: result.ticket != null ? String(result.ticket) : null,
        claimed_at: null,
        claimed_by: null,
      })
      .eq("id", leg.id)
    const entryPx = result.openPrice ?? refPrice ?? null
    const { data: insTrade, error: insErr } = await sb.from("trades").insert({
      user_id: leg.user_id,
      signal_id: leg.signal_id,
      broker_account_id: leg.broker_account_id,
      metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
      symbol: leg.symbol,
      direction: leg.is_buy ? "buy" : "sell",
      entry_price: entryPx,
      sl: result.stopLoss ?? sl,
      tp: result.takeProfit ?? tp,
      lot_size: result.lots ?? leg.volume,
      status: "open",
      opened_at: new Date().toISOString(),
    }).select("id").maybeSingle()
    if (insErr) {
      console.warn(`[range-pending-sweep] trades insert failed leg=${leg.id}: ${insErr.message}`)
    }
    const ticketNum = result.ticket != null ? Number(result.ticket) : NaN
    const tradeRowId = (insTrade as { id?: string } | null)?.id ?? null
    if (tradeRowId && Number.isFinite(ticketNum) && ticketNum > 0) {
      try {
        await tryApplyBasketFollowUpToNewFill(sb, api, {
          userId: leg.user_id,
          basketSignalId: leg.signal_id,
          brokerAccountId: leg.broker_account_id,
          metaUuid: leg.metaapi_account_id,
          symbol: leg.symbol,
          ticket: ticketNum,
          tradeRowId,
          entryPrice: entryPx,
          existingSl: result.stopLoss ?? sl ?? null,
          existingTp: result.takeProfit ?? tp ?? null,
        })
      } catch (hookErr) {
        console.warn(`[range-pending-sweep] basket follow-up leg=${leg.id}:`, hookErr)
      }
    }
    try {
      await sb.from("trade_execution_logs").insert({
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        action: "virtual_pending_fired",
        status: "success",
        request_payload: { leg_id: leg.id, step_idx: leg.step_idx, trigger_price: leg.trigger_price, ref_price: refPrice, claimed_by: CLAIMED_BY },
        response_payload: { ticket: result.ticket },
      })
    } catch {
      /* best-effort */
    }
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
