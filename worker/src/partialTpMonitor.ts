import os from 'node:os'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
  MetatraderApiClient,
} from './metatraderapi'

/**
 * Worker-side monitor that fires partial /OrderClose calls for single-mode
 * trades the moment the live /Quote crosses each configured early TP.
 *
 * Backstory — why a worker monitor instead of broker-side TPs:
 *   A single trade can only carry ONE broker takeprofit. Sending the
 *   percent-row rungs (TP1/TP2/...) to the broker isn't possible without
 *   splitting the position into separate orders (which is exactly what
 *   trade_style=='multi' already does). The user wants single-mode trades
 *   to ride to the deepest TP at the broker while the EARLIER TPs partial-
 *   close a slice of the position — so the early-TP cuts have to be
 *   enforced by us watching /Quote and calling /OrderClose with `lots = X`.
 *
 * Trigger semantics:
 *   buy  → fire when bid  >= trigger_price   (price rose to early TP)
 *   sell → fire when ask  <= trigger_price   (price fell to early TP)
 *
 * Lifecycle (same shape as range_pending_legs):
 *   pending  -> claimed  -> fired      (happy path)
 *   pending  -> claimed  -> failed     (OrderClose error; left to inspect)
 *   pending  -> cancelled              (parent trade closed by user / SL)
 *
 * Concurrency: a CAS update (status='pending' → 'claimed') gates the close
 * so two workers (or a worker + future edge cron) can never fire the same
 * partial twice.
 */

interface PartialRow {
  id: string
  trade_id: string
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  is_buy: boolean
  tp_idx: number
  trigger_price: number
  close_lots: number
  status: string
}

interface ParentTradeRow {
  id: string
  metaapi_order_id: string | null
  status: string
}

const TICK_INTERVAL_MS = 1_500
const STALE_CLAIM_AFTER_MS = 30_000

/**
 * Pure trigger check. Same direction-aware comparison as virtualPendingMonitor's
 * `isTriggered`, just with the buy/sell sides inverted because here we're
 * watching for a profitable level (early TP) rather than an averaging-down
 * level (range pending).
 *
 *   buy  → close when bid  >= triggerPrice
 *   sell → close when ask  <= triggerPrice
 *
 * Returns false on NaN / non-positive inputs so a flaky /Quote can never
 * cause a spurious partial close.
 */
export function isPartialTpTriggered(isBuy: boolean, triggerPrice: number, bid: number, ask: number): boolean {
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false
  return isBuy ? bid >= triggerPrice : ask <= triggerPrice
}

export class PartialTpMonitor {
  private timer: NodeJS.Timeout | null = null
  private api: MetatraderApiClient | null
  private hostId: string
  private ticking = false
  private firstTickLogged = false
  /** Heartbeat counter so we log one summary line every ~30s when there's
   *  work waiting but no triggers crossing. */
  private quietTicks = 0

  constructor(private readonly supabase: SupabaseClient) {
    this.api = getMetatraderApi()
    this.hostId = `worker:${os.hostname()}:${process.pid}`
  }

  start() {
    if (this.timer) return
    if (!this.api) {
      console.warn('[partialTpMonitor] METATRADERAPI_KEY missing — partial TP monitor disabled')
      return
    }
    this.timer = setInterval(() => {
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch(err => {
          console.error('[partialTpMonitor] tick error:', err instanceof Error ? err.message : String(err))
        })
        .finally(() => { this.ticking = false })
    }, TICK_INTERVAL_MS)
    console.log(`[partialTpMonitor] started (interval=${TICK_INTERVAL_MS}ms)`)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (!this.api) return

    // Re-claim stuck rows so a crashed worker can't strand a partial. Same
    // 30s threshold as virtualPendingMonitor.
    const staleCutoff = new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    await this.supabase
      .from('partial_tp_legs')
      .update({ status: 'pending', claimed_at: null, claimed_by: null })
      .eq('status', 'claimed')
      .lt('claimed_at', staleCutoff)

    const { data, error } = await this.supabase
      .from('partial_tp_legs')
      .select('id,trade_id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,is_buy,tp_idx,trigger_price,close_lots,status')
      .eq('status', 'pending')
      .limit(500)
    if (error) {
      console.error('[partialTpMonitor] select failed:', error.message)
      return
    }
    const rows = (data ?? []) as PartialRow[]
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[partialTpMonitor] first tick ok pending_rows=${rows.length}`)
    }
    if (!rows.length) {
      this.quietTicks = 0
      return
    }

    // Group by (metaapi_account_id, symbol) → at most ONE /Quote per group
    // per tick. Same shape as the other monitors for consistency.
    const groups = new Map<string, PartialRow[]>()
    for (const r of rows) {
      const key = `${r.metaapi_account_id}|${r.symbol}`
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }

    let triggeredTotal = 0
    let firedOkTotal = 0
    let firedErrTotal = 0
    const distances: Array<{ symbol: string; bid: number; ask: number; gap: number; legs: number }> = []

    await Promise.all(Array.from(groups.entries()).map(async ([key, partials]) => {
      const [uuid, symbol] = key.split('|')
      if (!uuid || !symbol) return
      let q
      try {
        q = await this.api!.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[partialTpMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        return
      }
      let nearestGap = Number.POSITIVE_INFINITY
      for (const partial of partials) {
        const ref = partial.is_buy ? q.bid : q.ask
        // For buys: positive gap = bid still BELOW trigger (waiting for rise).
        // For sells: positive gap = ask still ABOVE trigger (waiting for fall).
        const gap = partial.is_buy ? partial.trigger_price - ref : ref - partial.trigger_price
        if (Number.isFinite(gap) && gap < nearestGap) nearestGap = gap
        if (!isPartialTpTriggered(partial.is_buy, partial.trigger_price, q.bid, q.ask)) continue
        triggeredTotal += 1
        const ok = await this.firePartial(partial, q.bid, q.ask)
        if (ok) firedOkTotal += 1
        else firedErrTotal += 1
      }
      distances.push({ symbol, bid: q.bid, ask: q.ask, gap: nearestGap, legs: partials.length })
    }))

    if (triggeredTotal > 0) {
      console.log(
        `[partialTpMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} fired=${firedOkTotal}_ok ${firedErrTotal}_err`,
      )
      this.quietTicks = 0
    } else {
      this.quietTicks += 1
      if (this.quietTicks % 20 === 1) {
        const summary = distances
          .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gap) ? d.gap.toFixed(5) : 'n/a'} (${d.legs} legs)`)
          .join('; ')
        console.log(
          `[partialTpMonitor] heartbeat rows=${rows.length} groups=${groups.size} no triggers crossed yet — ${summary}`,
        )
      }
    }
  }

  /**
   * Close one partial slice. Returns true on success (or when the broker
   * reports the trade is already gone — same outcome). Failures roll the
   * row back to 'pending' so the next tick can retry.
   *
   * Order of operations (CAS-first so duplicate workers can't both fire):
   *   1. CAS UPDATE status: 'pending' → 'claimed'. Lose ⇒ bail.
   *   2. Look up the parent trade's ticket. If the parent is closed
   *      already (SL hit, manual close, etc.), skip the partial and mark
   *      it 'cancelled'.
   *   3. /OrderClose with `lots = close_lots`.
   *   4. UPDATE status: 'claimed' → 'fired' (or 'failed' on error).
   */
  private async firePartial(partial: PartialRow, bid: number, ask: number): Promise<boolean> {
    if (!this.api) return false

    // CAS claim.
    const { data: claimed, error: claimErr } = await this.supabase
      .from('partial_tp_legs')
      .update({ status: 'claimed', claimed_at: new Date().toISOString(), claimed_by: this.hostId })
      .eq('id', partial.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (claimErr) {
      console.warn(`[partialTpMonitor] CAS claim error partial=${partial.id}: ${claimErr.message}`)
      return false
    }
    if (!claimed) return false  // another worker won the race

    // Parent trade lookup — if it's already closed we cancel this partial
    // (no position to slice) so the row doesn't keep retrying forever.
    const { data: parent } = await this.supabase
      .from('trades')
      .select('id,metaapi_order_id,status')
      .eq('id', partial.trade_id)
      .maybeSingle()
    const parentRow = (parent ?? null) as ParentTradeRow | null
    if (!parentRow || parentRow.status !== 'open') {
      await this.supabase
        .from('partial_tp_legs')
        .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: 'parent trade not open' })
        .eq('id', partial.id)
      return false
    }
    const ticketNum = Number(parentRow.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
      await this.supabase
        .from('partial_tp_legs')
        .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: 'parent ticket missing' })
        .eq('id', partial.id)
      return false
    }

    const t0 = Date.now()
    const refPrice = partial.is_buy ? bid : ask
    try {
      const result = await this.api.orderClose(partial.metaapi_account_id, {
        ticket: ticketNum,
        lots: partial.close_lots,
        // price=0 lets the broker fill at market (same as a manual partial
        // close from the terminal). refPrice is reported in logs only.
      })
      const latencyMs = Date.now() - t0
      console.log(
        `[partialTpMonitor] partial fired signal=${partial.signal_id} symbol=${partial.symbol} ticket=${ticketNum}`
        + ` TP${partial.tp_idx}@${partial.trigger_price} ref=${refPrice} close=${partial.close_lots} latency=${latencyMs}ms`,
      )
      await this.supabase
        .from('partial_tp_legs')
        .update({ status: 'fired', fired_at: new Date().toISOString() })
        .eq('id', partial.id)
      await this.supabase.from('trade_execution_logs').insert({
        user_id: partial.user_id,
        signal_id: partial.signal_id,
        broker_account_id: partial.broker_account_id,
        action: 'partial_tp_fired',
        status: 'success',
        request_payload: {
          partial_id: partial.id,
          trade_id: partial.trade_id,
          tp_idx: partial.tp_idx,
          trigger_price: partial.trigger_price,
          close_lots: partial.close_lots,
          ref_price: refPrice,
        } as unknown as Record<string, unknown>,
        response_payload: { ticket: result.ticket, latency_ms: latencyMs, claimed_by: this.hostId },
      })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // "trade not found" / "position already closed" — the parent trade
      // closed under us (SL, broker TP, manual). Cancel the partial; the
      // remaining slice rode to broker TP already, nothing left to do.
      const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
      if (benign) {
        console.log(
          `[partialTpMonitor] parent gone signal=${partial.signal_id} ticket=${ticketNum}: ${msg}`,
        )
        await this.supabase
          .from('partial_tp_legs')
          .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: msg })
          .eq('id', partial.id)
        return true
      }
      console.error(
        `[partialTpMonitor] fire failed partial=${partial.id} ticket=${ticketNum}: ${msg}`,
      )
      // Roll back to 'pending' so the next tick retries.
      await this.supabase
        .from('partial_tp_legs')
        .update({ status: 'pending', claimed_at: null, claimed_by: null, error_message: msg })
        .eq('id', partial.id)
      await this.supabase.from('trade_execution_logs').insert({
        user_id: partial.user_id,
        signal_id: partial.signal_id,
        broker_account_id: partial.broker_account_id,
        action: 'partial_tp_fired',
        status: 'failed',
        request_payload: {
          partial_id: partial.id,
          trade_id: partial.trade_id,
          tp_idx: partial.tp_idx,
          trigger_price: partial.trigger_price,
          close_lots: partial.close_lots,
          ref_price: refPrice,
        } as unknown as Record<string, unknown>,
        error_message: msg,
      })
      return false
    }
  }
}
