import os from 'node:os'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
  MetatraderApiClient,
  OrderSendArgs,
  SymbolParams,
} from './metatraderapi'

/**
 * Worker-side monitor that turns persisted "virtual range pendings" into
 * real market orders the moment the live /Quote crosses their trigger price.
 *
 * The matching `range-pending-sweep` edge function (60s cron) runs the same
 * check as a backup so a worker outage doesn't strand pending averaging-down
 * legs. Both racers use a CAS update (status='pending' to 'claimed') so only
 * one of them ever fires a given row.
 *
 * Design choices:
 *   • Poll cadence: 1.5s. Fast enough to react to most fills without hammering
 *     /Quote (we collapse one /Quote per `(account, symbol)` group per tick).
 *   • Trigger semantics:
 *       buy ladder  → fires when bid <= trigger_price   (price dropped to leg)
 *       sell ladder → fires when ask >= trigger_price   (price rose to leg)
 *   • Claim staleness: rows stuck in `claimed` for >30s get re-claimed —
 *     covers a worker that crashed mid-OrderSend.
 *   • Side-effect free until a trigger hits: a tick that finds nothing to fire
 *     never touches Postgres beyond the initial SELECT.
 */

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
  anchor_price: number
  trigger_price: number
  stoploss: number | null
  takeprofit: number | null
  slippage: number
  comment: string | null
  expert_id: number | null
  expires_at: string | null
  status: string
}

interface SymbolCacheEntry {
  digits: number
  point: number
  minLot: number
  lotStep: number
  stopsLevel: number
  freezeLevel: number
  loadedAt: number
}

const SYMBOL_TTL_MS = 10 * 60_000
const TICK_INTERVAL_MS = 1_500
const STALE_CLAIM_AFTER_MS = 30_000

/**
 * Pure trigger-check used by both the worker monitor and the edge sweep:
 *   buy ladder  → trigger fires when bid <= trigger_price (price dropped)
 *   sell ladder → trigger fires when ask >= trigger_price (price rose)
 */
export function isTriggered(isBuy: boolean, triggerPrice: number, bid: number, ask: number): boolean {
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false
  return isBuy ? bid <= triggerPrice : ask >= triggerPrice
}

export class VirtualPendingMonitor {
  private timer: NodeJS.Timeout | null = null
  private api: MetatraderApiClient | null
  private symbolCache = new Map<string, SymbolCacheEntry>()
  private hostId: string
  private ticking = false

  constructor(private readonly supabase: SupabaseClient) {
    this.api = getMetatraderApi()
    this.hostId = `worker:${os.hostname()}:${process.pid}`
  }

  start() {
    if (this.timer) return
    if (!this.api) {
      console.warn('[virtualPendingMonitor] METATRADERAPI_KEY missing — virtual pending monitor disabled')
      return
    }
    this.timer = setInterval(() => {
      // Skip if a previous tick is still running — avoids piling up overlapping
      // /Quote calls when the API is slow.
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch(err => console.error('[virtualPendingMonitor] tick failed:', err))
        .finally(() => { this.ticking = false })
    }, TICK_INTERVAL_MS)
    this.timer.unref?.()
    console.log(`[virtualPendingMonitor] started host=${this.hostId} interval=${TICK_INTERVAL_MS}ms`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (!this.api) return

    // Re-open rows whose claim is stale. Anything older than STALE_CLAIM_AFTER_MS
    // is considered abandoned (the claiming worker probably crashed); reset it
    // so another monitor can pick it up.
    const staleCut = new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    await this.supabase
      .from('range_pending_legs')
      .update({ status: 'pending', claimed_at: null, claimed_by: null })
      .eq('status', 'claimed')
      .lt('claimed_at', staleCut)

    // Expire any rows whose pending_expiry_hours have lapsed BEFORE we try to
    // fire them — keeps the queue tight.
    const nowIso = new Date().toISOString()
    const { data: expired } = await this.supabase
      .from('range_pending_legs')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .not('expires_at', 'is', null)
      .lt('expires_at', nowIso)
      .select('id,signal_id,user_id,broker_account_id,symbol,step_idx')
    if (expired && expired.length) {
      for (const r of expired as Array<{ id: string; signal_id: string; user_id: string; broker_account_id: string; symbol: string; step_idx: number }>) {
        try {
          await this.supabase.from('trade_execution_logs').insert({
            user_id: r.user_id,
            signal_id: r.signal_id,
            broker_account_id: r.broker_account_id,
            action: 'virtual_pending_expired',
            status: 'info',
            request_payload: { id: r.id, symbol: r.symbol, step_idx: r.step_idx } as unknown as Record<string, unknown>,
          })
        } catch { /* logging is best-effort */ }
      }
    }

    // Pull the live pending queue.
    const { data, error } = await this.supabase
      .from('range_pending_legs')
      .select('*')
      .eq('status', 'pending')
      .limit(500)
    if (error) {
      console.error('[virtualPendingMonitor] select failed:', error.message)
      return
    }
    const rows = (data ?? []) as PendingRow[]
    if (!rows.length) return

    // Group by (account, symbol) so we issue at most ONE /Quote per group.
    const groups = new Map<string, PendingRow[]>()
    for (const r of rows) {
      const key = `${r.metaapi_account_id}|${r.symbol}`
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }

    let triggeredTotal = 0
    let firedOkTotal = 0
    let firedErrTotal = 0

    await Promise.all(Array.from(groups.entries()).map(async ([key, legs]) => {
      const [uuid, symbol] = key.split('|')
      if (!uuid || !symbol) return
      let q
      try {
        q = await this.api!.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[virtualPendingMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        return
      }
      for (const leg of legs) {
        if (!isTriggered(leg.is_buy, leg.trigger_price, q.bid, q.ask)) continue
        triggeredTotal += 1
        const ok = await this.fireLeg(leg, q.bid, q.ask)
        if (ok) firedOkTotal += 1
        else firedErrTotal += 1
      }
    }))

    if (triggeredTotal > 0) {
      console.log(
        `[virtualPendingMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} fired=${firedOkTotal}_ok ${firedErrTotal}_err`,
      )
    }
  }

  private async fireLeg(leg: PendingRow, bid: number, ask: number): Promise<boolean> {
    if (!this.api) return false
    // CAS claim. If another monitor (worker peer or edge fn) beat us, .maybeSingle()
    // returns no row and we walk away.
    const { data: claimed, error: claimErr } = await this.supabase
      .from('range_pending_legs')
      .update({ status: 'claimed', claimed_at: new Date().toISOString(), claimed_by: this.hostId })
      .eq('id', leg.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (claimErr) {
      console.warn(`[virtualPendingMonitor] CAS claim error leg=${leg.id}: ${claimErr.message}`)
      return false
    }
    if (!claimed) return false

    // Build a MARKET order. We DO NOT send `price` for Buy/Sell — the broker
    // fills at the current bid/ask. Stops were precomputed at planning time
    // against the live anchor; SL/TP from the original ladder stand.
    const args: OrderSendArgs = {
      symbol: leg.symbol,
      operation: leg.is_buy ? 'Buy' : 'Sell',
      volume: leg.volume,
      slippage: leg.slippage ?? 20,
      stoploss: leg.stoploss ?? 0,
      takeprofit: leg.takeprofit ?? 0,
      comment: leg.comment ?? `TSCopier:rg${leg.step_idx}`,
      expertID: leg.expert_id ?? 909090,
    }

    // Last-second SL/TP clamp using the live quote as the reference. Pulls
    // SymbolParams once per (account, symbol) every 10 minutes.
    const params = await this.getSymbolParams(leg.metaapi_account_id, leg.symbol)
    const refPrice = leg.is_buy ? ask : bid
    if (params) {
      const clamped = this.clampOrderStops(args, refPrice, params)
      if (clamped.adjustments.length) {
        console.warn(
          `[virtualPendingMonitor] stops clamped leg=${leg.id} symbol=${leg.symbol} op=${args.operation}: ${clamped.adjustments.join(', ')}`,
        )
      }
      Object.assign(args, clamped.args)
    }

    const t0 = Date.now()
    try {
      const result = await this.api.orderSend(leg.metaapi_account_id, args)
      const latencyMs = Date.now() - t0
      console.log(
        `[virtualPendingMonitor] virtual leg fired signal=${leg.signal_id} stepIdx=${leg.step_idx} trigger=${leg.trigger_price} ref=${refPrice} ticket=${result.ticket} latency=${latencyMs}ms`,
      )
      await this.supabase
        .from('range_pending_legs')
        .update({
          status: 'fired',
          fired_at: new Date().toISOString(),
          ticket: result.ticket != null ? String(result.ticket) : null,
        })
        .eq('id', leg.id)
      await this.supabase.from('trades').insert({
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
        symbol: leg.symbol,
        direction: leg.is_buy ? 'buy' : 'sell',
        entry_price: result.openPrice ?? refPrice,
        sl: result.stopLoss ?? args.stoploss ?? null,
        tp: result.takeProfit ?? args.takeprofit ?? null,
        lot_size: result.lots ?? args.volume,
        status: 'open',
        opened_at: new Date().toISOString(),
      })
      await this.supabase.from('trade_execution_logs').insert({
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        action: 'virtual_pending_fired',
        status: 'success',
        request_payload: {
          leg_id: leg.id,
          step_idx: leg.step_idx,
          trigger_price: leg.trigger_price,
          ref_price: refPrice,
        } as unknown as Record<string, unknown>,
        response_payload: { ticket: result.ticket, latency_ms: latencyMs, claimed_by: this.hostId },
      })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `[virtualPendingMonitor] fire failed leg=${leg.id} signal=${leg.signal_id} stepIdx=${leg.step_idx}: ${msg}`,
      )
      await this.supabase
        .from('range_pending_legs')
        .update({ status: 'failed', error_message: msg, fired_at: new Date().toISOString() })
        .eq('id', leg.id)
      await this.supabase.from('trade_execution_logs').insert({
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        action: 'virtual_pending_failed',
        status: 'failed',
        request_payload: { leg_id: leg.id, step_idx: leg.step_idx, claimed_by: this.hostId } as unknown as Record<string, unknown>,
        error_message: msg,
      })
      return false
    }
  }

  private async getSymbolParams(uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    if (!this.api) return null
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && (Date.now() - cached.loadedAt) < SYMBOL_TTL_MS) return cached
    try {
      const p: SymbolParams = await this.api.symbolParams(uuid, symbol)
      const entry: SymbolCacheEntry = {
        digits: Number(p.symbol?.digits ?? 5),
        point: Number(p.symbol?.point ?? 0.00001),
        minLot: Number(p.groupParams?.minLot ?? 0.01),
        lotStep: Number(p.groupParams?.lotStep ?? 0.01),
        stopsLevel: Math.max(0, Number(p.symbol?.stopsLevel ?? 0) || 0),
        freezeLevel: Math.max(0, Number(p.symbol?.freezeLevel ?? 0) || 0),
        loadedAt: Date.now(),
      }
      this.symbolCache.set(key, entry)
      return entry
    } catch {
      return null
    }
  }

  /**
   * Mirror of tradeExecutor.clampOrderStops — kept inline to avoid coupling the
   * monitor to the executor module. Push SL/TP outside the larger of
   * stops_level / freeze_level so MT5 can't reject the market send.
   */
  private clampOrderStops(args: OrderSendArgs, refPrice: number, params: SymbolCacheEntry): { args: OrderSendArgs; adjustments: string[] } {
    const adjustments: string[] = []
    const point = Number(params.point) || 0
    const minLevel = Math.max(params.stopsLevel, params.freezeLevel)
    const minDist = (minLevel + 2) * point
    if (point <= 0 || minDist <= 0 || refPrice <= 0) return { args, adjustments }

    const digits = Math.max(0, Math.min(8, Math.floor(params.digits)))
    const round = (v: number): number => Number(v.toFixed(digits))
    const isBuy = String(args.operation) === 'Buy'

    let sl = Number(args.stoploss) || 0
    let tp = Number(args.takeprofit) || 0
    const original = { sl, tp }

    if (isBuy) {
      if (sl > 0 && refPrice - sl < minDist) sl = round(refPrice - minDist)
      if (tp > 0 && tp - refPrice < minDist) tp = round(refPrice + minDist)
    } else {
      if (sl > 0 && sl - refPrice < minDist) sl = round(refPrice + minDist)
      if (tp > 0 && refPrice - tp < minDist) tp = round(refPrice - minDist)
    }

    if (sl !== original.sl) adjustments.push(`sl ${original.sl} → ${sl}`)
    if (tp !== original.tp) adjustments.push(`tp ${original.tp} → ${tp}`)
    if (adjustments.length === 0) return { args, adjustments }
    return { args: { ...args, stoploss: sl, takeprofit: tp }, adjustments }
  }
}
