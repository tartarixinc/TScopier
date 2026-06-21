/**
 * Basket SL/TP reconcile helpers for edge sweep. Keep in sync with worker/src/basketSlTpReconcile.ts.
 */

type BrokerTradingApi = {
  openedOrders(uuid: string): Promise<unknown[]>
  quote(uuid: string, symbol: string): Promise<{ bid?: number; ask?: number }>
  orderModify(uuid: string, payload: Record<string, unknown>): Promise<unknown>
}
import {
  expandPerLegTargetsToCount,
  type ManualTpLotLike,
  type PerLegStopTargetLike,
} from "./tpBucketDistribution.ts"

// deno-lint-ignore no-explicit-any
type SupabaseLike = any

export type PerLegStopTarget = { stoploss: number; takeprofit: number }

export type BasketOpenLeg = {
  id: string
  signal_id: string
  metaapi_order_id: string | null
  lot_size: number
  sl: number | null
  tp: number | null
  entry_price: number | null
  direction: string
  symbol: string
}

function symbolsCompatible(signalSym: string, brokerSym: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const a = norm(signalSym)
  const b = norm(brokerSym)
  if (!a.length || !b.length) return false
  return a === b || b.includes(a) || a.includes(b)
}

export function parsePerLegTargets(raw: unknown): PerLegStopTarget[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => {
      if (!row || typeof row !== "object") return null
      const o = row as Record<string, unknown>
      return { stoploss: Number(o.stoploss) || 0, takeprofit: Number(o.takeprofit) || 0 }
    })
    .filter((x): x is PerLegStopTarget => x != null)
}

export async function loadOpenBasketLegs(
  supabase: SupabaseLike,
  brokerAccountId: string,
  anchorSignalId: string,
  symbolHint: string,
): Promise<BasketOpenLeg[]> {
  const { data, error } = await supabase
    .from("trades")
    .select("id,signal_id,metaapi_order_id,lot_size,sl,tp,entry_price,direction,symbol")
    .eq("broker_account_id", brokerAccountId)
    .eq("signal_id", anchorSignalId)
    .eq("status", "open")
    .order("opened_at", { ascending: true })
    .limit(500)
  if (error) return []
  return ((data ?? []) as BasketOpenLeg[]).filter((tr) => symbolsCompatible(symbolHint, tr.symbol))
}

export async function fetchOpenBrokerTickets(api: BrokerTradingApi, uuid: string): Promise<Set<number>> {
  const tickets = new Set<number>()
  try {
    const orders = await api.openedOrders(uuid)
    for (const raw of orders ?? []) {
      if (!raw || typeof raw !== "object") continue
      const o = raw as Record<string, unknown>
      const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
      if (Number.isFinite(ticket) && ticket > 0) tickets.add(ticket)
    }
  } catch { /* optional */ }
  return tickets
}

function clampStops(
  ref: number,
  sl: number,
  tp: number,
  isBuy: boolean,
  point: number,
  stopsLevel: number,
  freezeLevel: number,
  digits: number,
): { sl: number; tp: number } {
  const minDist = (Math.max(stopsLevel, freezeLevel) + 2) * point
  if (ref <= 0 || minDist <= 0) return { sl, tp }
  const round = (v: number) => Number(v.toFixed(digits))
  let outSl = sl
  let outTp = tp
  if (isBuy) {
    if (outSl > 0 && ref - outSl < minDist) outSl = round(ref - minDist)
    if (outTp > 0 && outTp - ref < minDist) outTp = round(ref + minDist)
  } else {
    if (outSl > 0 && outSl - ref < minDist) outSl = round(ref + minDist)
    if (outTp > 0 && ref - outTp < minDist) outTp = round(ref - minDist)
  }
  return { sl: outSl, tp: outTp }
}

export async function runEdgeBasketLegModifies(args: {
  supabase: SupabaseLike
  api: BrokerTradingApi
  uuid: string
  symbol: string
  direction: "buy" | "sell"
  baseLot: number
  signalId: string
  userId: string
  brokerAccountId: string
  familyTrades: BasketOpenLeg[]
  perLegTargets: PerLegStopTarget[]
  signalTps?: number[]
  tpLots?: ManualTpLotLike[] | null
  nImmCwe: number
  overrideTp: number | null
  openedTickets: Set<number>
  stopsLevel: number
  freezeLevel: number
  point: number
  digits: number
}): Promise<{ modified: number; openLegs: number; failed: number }> {
  const {
    supabase, api, uuid, symbol, direction, baseLot, signalId, userId, brokerAccountId,
    familyTrades, perLegTargets: rawTargets, signalTps, tpLots, nImmCwe, overrideTp, openedTickets,
    stopsLevel, freezeLevel, point, digits,
  } = args
  const parsedTps = (signalTps ?? []).filter((t) => typeof t === "number" && Number.isFinite(t) && t > 0)
  const perLegTargets = expandPerLegTargetsToCount({
    targets: rawTargets as PerLegStopTargetLike[],
    openLegCount: familyTrades.length,
    finalTps: parsedTps.length
      ? parsedTps
      : rawTargets.map((t) => t.takeprofit).filter((tp) => tp > 0),
    tpLots,
  }) as PerLegStopTarget[]
  let modified = 0
  let failed = 0
  const isBuy = direction === "buy"

  for (let i = 0; i < familyTrades.length; i++) {
    const tr = familyTrades[i]!
    const target = perLegTargets[i]
    if (!target) continue
    const ticket = Number(tr.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    if (!openedTickets.has(ticket)) {
      failed += 1
      continue
    }

    let ref = Number(tr.entry_price) || 0
    if (ref <= 0) {
      try {
        const q = await api.quote(uuid, symbol)
        ref = isBuy ? q.ask : q.bid
      } catch {
        failed += 1
        continue
      }
    }

    const cweIdx = i
    let sl = target.stoploss
    let tp = cweIdx < nImmCwe ? 0 : target.takeprofit
    const clamped = clampStops(ref, sl, tp, isBuy, point, stopsLevel, freezeLevel, digits)
    sl = clamped.sl
    tp = clamped.tp

    try {
      const modRes = await api.orderModify(uuid, { ticket, stoploss: sl, takeprofit: tp })
      const newSl = modRes.stopLoss ?? sl
      const newTp = modRes.takeProfit ?? tp
      const cweClose = cweIdx < nImmCwe ? overrideTp : null
      await supabase.from("trades").update({
        sl: typeof newSl === "number" && newSl > 0 ? newSl : null,
        tp: typeof newTp === "number" && newTp > 0 ? newTp : null,
        cwe_close_price: typeof cweClose === "number" && cweClose > 0 ? cweClose : null,
      }).eq("id", tr.id)
      modified += 1
      await supabase.from("trade_execution_logs").insert({
        user_id: userId,
        signal_id: signalId,
        broker_account_id: brokerAccountId,
        action: "basket_leg_modify",
        status: "success",
        request_payload: { trade_id: tr.id, ticket, leg_index: i + 1, source: "edge_sweep" },
      })
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      await supabase.from("trade_execution_logs").insert({
        user_id: userId,
        signal_id: signalId,
        broker_account_id: brokerAccountId,
        action: "basket_leg_modify",
        status: "failed",
        error_message: msg,
        request_payload: { trade_id: tr.id, ticket, leg_index: i + 1, source: "edge_sweep" },
      })
    }
  }

  return { modified, openLegs: familyTrades.length, failed }
}

export function reconcileBackoffMs(attempts: number): number {
  const base = 15_000
  return Math.min(base * Math.pow(2, Math.min(attempts, 4)), 300_000)
}
