import os from 'node:os'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasMetatraderApiConfigured,
  normalizeSymbolParams,
  OrderSendArgs,
  SymbolParams,
} from './metatraderapi'
import { apiForMetaapiAccount, loadPlatformByMetaapiId, type PlatformByMetaapiId } from './mtApiByAccount'
import { tryApplyBasketFollowUpToNewFill } from './basketModFollowUp'
import { markRangeLegFired, markRangeLegsExpired } from './rangePendingLadderSync'
import {
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  applyShardToQuery,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { reconcileStaleClaimedLegs, shouldBlockVirtualLegFire } from './rangePendingFireGuard'
import { isMtBridgeGlitchMessage } from './brokerConnectError'
import {
  deleteRangePendingLegsForBasket,
  reconcileBasketFlatFromBroker,
  reconcilePendingLegBasketsFromBroker,
} from './rangePendingBasketCleanup'

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
 *
 *   • Orphan pendings: if every `trades` row for the same (signal, broker,
 *     symbol) is already closed, we cancel `pending` legs (see early stale
 *     check before claim, and DB trigger `cancel_range_pending_legs_when_basket_empty`
 *     on `trades` close) so a flat basket cannot spawn new market entries when
 *     price revisits old ladder triggers.
 *
 *   • Ladder discipline: at most one virtual leg fires per (signal, broker,
 *     symbol) per tick — the shallowest triggered rung with no shallower
 *     `pending`/`claimed` row — so one volatile quote cannot machine-gun every
 *     deeper rung in the same millisecond. Strict signal-entry deferrals use
 *     broker limit orders (`signal_entry_pending_orders`), not `step_idx = 0`
 *     rows in this table.
 *
 *   • Terminal rows (`expired` TTL, successful `fired`) are **deleted** from
 *     `range_pending_legs` with status `fired` (row retained for ladder history)
 *     tombstones. Failed / cancelled legs remain for diagnostics.
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
  /**
   * Close-Worse-Entries threshold inherited from the planner via the
   * executor's INSERT. When non-null the leg is part of the worse-entries
   * basket: the broker order goes out with NO takeprofit (only the SL
   * rides) and the resulting `trades` row carries this value so
   * `cweCloseMonitor` will close the position when the live quote crosses.
   */
  cwe_close_price: number | null
}

interface SymbolCacheEntry {
  digits: number
  point: number
  minLot: number
  lotStep: number
  /**
   * Units in 1.00 standard lot. The monitor doesn't currently use this for
   * order math, but the field keeps the cache shape aligned with the
   * tradeExecutor cache so future risk/sizing code can be added in one
   * place.
   */
  contractSize: number | null
  stopsLevel: number
  freezeLevel: number
  loadedAt: number
}

const SYMBOL_TTL_MS = 10 * 60_000
const ACTIVE_MS = monitorActiveIntervalMs('VIRTUAL_PENDING_TICK_MS', 1_500)
const IDLE_MS = monitorIdleIntervalMs('VIRTUAL_PENDING_IDLE_MS', 60_000)
const STALE_CLAIM_AFTER_MS = 30_000

async function virtualPendingHasWork(
  supabase: SupabaseClient,
  staleCut: string,
): Promise<boolean> {
  const pending = await hasWorkOnShard(supabase, 'range_pending_legs', q =>
    q
      .eq('status', 'pending')
      .not('comment', 'ilike', '%:strictEntry%')
      .not('comment', 'ilike', '%:strictEntryAgg%'),
  )
  if (pending) return true
  return hasWorkOnShard(supabase, 'range_pending_legs', q =>
    q.eq('status', 'claimed').lt('claimed_at', staleCut),
  )
}

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

/**
 * True if some shallower virtual rung for the same basket is still `pending`
 * or `claimed` (see `activeStepsByBasket` from `fetchShallowActiveSteps`).
 */
export function isBlockedByShallowerStep(
  leg: { signal_id: string; broker_account_id: string; step_idx: number },
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

export class VirtualPendingMonitor {
  private loop: MonitorLoopHandle | null = null
  private platformByUuid: PlatformByMetaapiId = new Map()
  private symbolCache = new Map<string, SymbolCacheEntry>()
  private hostId: string
  private ticking = false
  /** Heartbeat counter: when there ARE pending rows but none triggered, we
   *  still log one line every N ticks so it's obvious the monitor is alive
   *  and how far the live quote sits from the nearest trigger. */
  private quietTicks = 0
  private firstTickLogged = false

  constructor(private readonly supabase: SupabaseClient) {
    this.hostId = `worker:${os.hostname()}:${process.pid}`
  }

  start() {
    if (this.loop) return
    if (!hasMetatraderApiConfigured()) {
      console.warn('[virtualPendingMonitor] MT4API_BASIC_USER/PASSWORD missing — virtual pending monitor disabled')
      return
    }
    const staleCut = () => new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    this.loop = startMonitorLoop({
      name: 'virtualPendingMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => virtualPendingHasWork(sb, staleCut()),
      tick: () => this.runTick(),
    })
    console.log(`[virtualPendingMonitor] started host=${this.hostId} active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } finally {
      this.ticking = false
    }
  }

  private async tick(): Promise<void> {
    if (!hasMetatraderApiConfigured()) return

    // Re-open rows whose claim is stale. Anything older than STALE_CLAIM_AFTER_MS
    // is considered abandoned (the claiming worker probably crashed); reset it
    // so another monitor can pick it up.
    const staleCut = new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    const staleStats = await reconcileStaleClaimedLegs(this.supabase, staleCut)
    if (staleStats.cancelled > 0 || staleStats.reset > 0) {
      console.log(
        `[virtualPendingMonitor] stale claims reconciled cancelled=${staleStats.cancelled} reset=${staleStats.reset}`,
      )
    }

    // Expire any rows whose pending_expiry_hours have lapsed BEFORE we try to
    // fire them — keeps the queue tight.
    const nowIso = new Date().toISOString()
    const { data: expired } = await this.supabase
      .from('range_pending_legs')
      .update({ status: 'expired', error_message: 'pending_expiry' })
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
    const pendingQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('range_pending_legs')
        .select('*')
        .eq('status', 'pending')
        .not('comment', 'ilike', '%:strictEntry%')
        .not('comment', 'ilike', '%:strictEntryAgg%')
        .limit(500),
    )
    if (!pendingQ) return
    const { data, error } = await pendingQ
    if (error) {
      console.error('[virtualPendingMonitor] select failed:', error.message)
      return
    }
    const rows = (data ?? []) as PendingRow[]
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[virtualPendingMonitor] first tick ok pending_rows=${rows.length}`)
    }
    if (!rows.length) {
      // Reset the quiet-tick counter — next time rows appear, the heartbeat
      // restarts from zero so the first non-empty tick always logs.
      this.quietTicks = 0
      return
    }

    this.platformByUuid = await loadPlatformByMetaapiId(
      this.supabase,
      rows.map(r => r.metaapi_account_id),
    )

    // SL/TP/manual broker closes leave DB trades "open" — reconcile before triggers.
    await reconcilePendingLegBasketsFromBroker(
      this.supabase,
      rows,
      uuid => apiForMetaapiAccount(this.platformByUuid, uuid),
    )

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
    /** Per-group: cheapest distance between live quote and any leg's trigger.
     *  Lets the heartbeat log show "you're $0.40 from your nearest trigger". */
    const distances: Array<{ symbol: string; bid: number; ask: number; gapPriceUnits: number; legs: number }> = []

    await Promise.all(Array.from(groups.entries()).map(async ([key, legs]) => {
      const [uuid, symbol] = key.split('|')
      if (!uuid || !symbol) return
      const api = apiForMetaapiAccount(this.platformByUuid, uuid)
      if (!api) return
      let q
      try {
        q = await api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[virtualPendingMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        return
      }
      // How far is the nearest trigger? Useful diagnostic when nothing fires.
      let nearestGap = Number.POSITIVE_INFINITY
      const triggeredInGroup: PendingRow[] = []
      for (const leg of legs) {
        const ref = leg.is_buy ? q.bid : q.ask
        const gap = leg.is_buy ? ref - leg.trigger_price : leg.trigger_price - ref
        if (Number.isFinite(gap) && gap < nearestGap) nearestGap = gap
        if (isTriggered(leg.is_buy, leg.trigger_price, q.bid, q.ask)) triggeredInGroup.push(leg)
      }

      const cancelledStaleIds = new Set<string>()
      const purgedBaskets = new Set<string>()
      for (const leg of triggeredInGroup) {
        const bk = `${leg.signal_id}|${leg.broker_account_id}`
        if (purgedBaskets.has(bk)) {
          cancelledStaleIds.add(leg.id)
          continue
        }
        const staleEarly = await this.getStaleLegReason(leg, api, uuid)
        if (!staleEarly) continue
        purgedBaskets.add(bk)
        const deleted = await deleteRangePendingLegsForBasket(
          this.supabase,
          { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
          staleEarly,
        )
        if (deleted > 0) {
          for (const l of legs) {
            if (l.signal_id === leg.signal_id && l.broker_account_id === leg.broker_account_id) {
              cancelledStaleIds.add(l.id)
            }
          }
          try {
            await this.supabase.from('trade_execution_logs').insert({
              user_id: leg.user_id,
              signal_id: leg.signal_id,
              broker_account_id: leg.broker_account_id,
              action: 'virtual_pending_cancelled',
              status: 'info',
              request_payload: {
                reason: staleEarly,
                phase: 'pre_claim_stale',
                rows: deleted,
                basket: bk,
              } as unknown as Record<string, unknown>,
            })
          } catch {
            /* logging is best-effort */
          }
        }
      }

      const signalIds = [...new Set(legs.map(l => l.signal_id))]
      const activeStepsByBasket = await this.fetchShallowActiveSteps(uuid, symbol, signalIds)

      const byBasket = new Map<string, PendingRow[]>()
      for (const leg of triggeredInGroup) {
        if (cancelledStaleIds.has(leg.id)) continue
        if (!isTriggered(leg.is_buy, leg.trigger_price, q.bid, q.ask)) continue
        if (isBlockedByShallowerStep(leg, activeStepsByBasket)) continue
        const bk = `${leg.signal_id}|${leg.broker_account_id}`
        const arr = byBasket.get(bk) ?? []
        arr.push(leg)
        byBasket.set(bk, arr)
      }

      for (const [, arr] of byBasket) {
        arr.sort((a, b) => a.step_idx - b.step_idx || a.id.localeCompare(b.id))
        const winner = arr[0]
        if (!winner) continue
        triggeredTotal += 1
        const ok = await this.fireLeg(winner, q.bid, q.ask)
        if (ok) firedOkTotal += 1
        else firedErrTotal += 1
      }

      distances.push({ symbol, bid: q.bid, ask: q.ask, gapPriceUnits: nearestGap, legs: legs.length })
    }))

    if (triggeredTotal > 0) {
      console.log(
        `[virtualPendingMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} fired=${firedOkTotal}_ok ${firedErrTotal}_err`,
      )
      this.quietTicks = 0
    } else {
      // Heartbeat: log every ~30s (20 ticks × 1.5s) when there's work waiting
      // but no triggers crossing — makes "monitor is alive, just not hitting"
      // visible vs. "monitor is dead".
      this.quietTicks += 1
      if (this.quietTicks % 20 === 1) {
        const summary = distances
          .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gapPriceUnits) ? d.gapPriceUnits.toFixed(5) : 'n/a'} (${d.legs} legs)`)
          .join('; ')
        console.log(
          `[virtualPendingMonitor] heartbeat rows=${rows.length} groups=${groups.size} no triggers crossed yet — ${summary}`,
        )
      }
    }
  }

  private async markLegFiredWithRetry(
    legId: string,
    ticket: number | string | null,
  ): Promise<void> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await markRangeLegFired(this.supabase, legId, ticket)
        return
      } catch (err) {
        lastErr = err
        await new Promise(r => setTimeout(r, 80 * (attempt + 1)))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async fireLeg(leg: PendingRow, bid: number, ask: number): Promise<boolean> {
    const api = apiForMetaapiAccount(this.platformByUuid, leg.metaapi_account_id)
    if (!api) return false

    const block = await shouldBlockVirtualLegFire(this.supabase, leg)
    if (block.block) {
      if (block.reason) {
        console.log(
          `[virtualPendingMonitor] skip fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: ${block.reason}`,
        )
      }
      return false
    }

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
    const staleReason = await this.getStaleLegReason(leg, api, leg.metaapi_account_id)
    if (staleReason) {
      await deleteRangePendingLegsForBasket(
        this.supabase,
        { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
        staleReason,
      )
      return true
    }

    // Build a MARKET order. We DO NOT send `price` for Buy/Sell — the broker
    // fills at the current bid/ask. Stops were precomputed at planning time
    // against the live anchor; SL/TP from the original ladder stand.
    //
    // CWE-tagged legs (cwe_close_price != null) intentionally ship with
    // takeprofit = 0 — the close threshold is enforced post-fill by
    // cweCloseMonitor, not by the broker. Honouring the persisted
    // `takeprofit` here would re-introduce the "Invalid stops" rejections
    // that motivated this redesign (a TP on a buy that's already in profit
    // is on the wrong side of the market and the broker refuses).
    const args: OrderSendArgs = {
      symbol: leg.symbol,
      operation: leg.is_buy ? 'Buy' : 'Sell',
      volume: leg.volume,
      slippage: leg.slippage ?? 20,
      stoploss: leg.stoploss ?? 0,
      takeprofit: leg.cwe_close_price != null ? 0 : (leg.takeprofit ?? 0),
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
      // Sanity check the clamped result. The clamp only nudges to `ref ± minDist`,
      // which can still be invalid when the BROKER's effective stops_level is
      // larger than `/SymbolParams` reports (some MT5 builds quietly omit it).
      // If the resulting TP/SL is still on the wrong side of the live ref,
      // drop the offending side rather than send a doomed order — opening
      // without a TP is strictly better than not opening at all for an
      // averaging-down ladder.
      const cleanup = this.sanitizeStops(args, refPrice)
      if (cleanup.notes.length) {
        console.warn(
          `[virtualPendingMonitor] stops sanitized leg=${leg.id} symbol=${leg.symbol} op=${args.operation}: ${cleanup.notes.join(', ')}`,
        )
      }
      Object.assign(args, cleanup.args)
    }

    const t0 = Date.now()
    try {
      const result = await this.sendWithStopsFallback(leg, args)
      // Mark fired immediately after OrderSend so a slow trades insert / log write
      // cannot leave the row `claimed` and get reset to `pending` (30s stale reclaim).
      await this.markLegFiredWithRetry(leg.id, result.ticket ?? null)
      const latencyMs = Date.now() - t0
      console.log(
        `[virtualPendingMonitor] virtual leg fired signal=${leg.signal_id} stepIdx=${leg.step_idx} trigger=${leg.trigger_price} ref=${refPrice} ticket=${result.ticket} latency=${latencyMs}ms`,
      )
      const entryPx = result.openPrice ?? refPrice ?? null
      const { data: insTrade, error: insErr } = await this.supabase.from('trades').insert({
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
        symbol: leg.symbol,
        direction: leg.is_buy ? 'buy' : 'sell',
        entry_price: entryPx,
        sl: result.stopLoss ?? args.stoploss ?? null,
        tp: result.takeProfit ?? args.takeprofit ?? null,
        lot_size: result.lots ?? args.volume,
        status: 'open',
        opened_at: new Date().toISOString(),
        // Carry the CWE threshold forward so cweCloseMonitor watches the
        // newly-filled leg alongside its sibling immediates. Null for
        // non-CWE pendings.
        cwe_close_price: leg.cwe_close_price,
      }).select('id').maybeSingle()
      if (insErr) {
        console.warn(`[virtualPendingMonitor] trades insert failed leg=${leg.id}: ${insErr.message}`)
      }

      const ticketNum = result.ticket != null ? Number(result.ticket) : NaN
      const tradeRowId = (insTrade as { id?: string } | null)?.id ?? null
      if (
        tradeRowId
        && Number.isFinite(ticketNum)
        && ticketNum > 0
        && hasMetatraderApiConfigured()
      ) {
        try {
          await tryApplyBasketFollowUpToNewFill(this.supabase, api, {
            userId: leg.user_id,
            basketSignalId: leg.signal_id,
            brokerAccountId: leg.broker_account_id,
            metaUuid: leg.metaapi_account_id,
            symbol: leg.symbol,
            ticket: ticketNum,
            tradeRowId,
            entryPrice: entryPx,
            existingSl: result.stopLoss ?? args.stoploss ?? null,
            existingTp: result.takeProfit ?? args.takeprofit ?? null,
          })
        } catch (hookErr) {
          console.warn(
            `[virtualPendingMonitor] SL/TP follow-up for range leg=${leg.id} signal=${leg.signal_id}:`,
            hookErr,
          )
        }
      }
      try {
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
      } catch {
        /* logging is best-effort; leg is already `fired` */
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `[virtualPendingMonitor] fire failed leg=${leg.id} signal=${leg.signal_id} stepIdx=${leg.step_idx}: ${msg}`,
      )
      if (isMtBridgeGlitchMessage(msg)) {
        await this.supabase
          .from('range_pending_legs')
          .update({
            status: 'pending',
            claimed_at: null,
            claimed_by: null,
            error_message: null,
          })
          .eq('id', leg.id)
        console.warn(
          `[virtualPendingMonitor] bridge glitch leg=${leg.id} — released back to pending for retry`,
        )
        return false
      }
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

  /**
   * All `step_idx` values that still have a `pending` or `claimed` row for this
   * basket (same metaapi account + symbol). Used so deeper rungs never fire
   * before shallower ones on the same quote tick.
   */
  private async fetchShallowActiveSteps(
    metaapiAccountId: string,
    symbol: string,
    signalIds: string[],
  ): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>()
    if (!signalIds.length) return out
    const { data, error } = await this.supabase
      .from('range_pending_legs')
      .select('signal_id, broker_account_id, step_idx')
      .eq('metaapi_account_id', metaapiAccountId)
      .eq('symbol', symbol)
      .in('signal_id', signalIds)
      .in('status', ['pending', 'claimed'])
      .not('comment', 'ilike', '%:strictEntry%')
      .not('comment', 'ilike', '%:strictEntryAgg%')
    if (error) {
      console.warn(`[virtualPendingMonitor] fetchShallowActiveSteps failed: ${error.message}`)
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

  private async getStaleLegReason(
    leg: PendingRow,
    api: ReturnType<typeof apiForMetaapiAccount> | null,
    metaapiAccountId: string,
  ): Promise<string | null> {
    return reconcileBasketFlatFromBroker(
      this.supabase,
      api ?? null,
      metaapiAccountId,
      { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
    )
  }

  private async cancelClaimedLeg(leg: PendingRow, reason: string): Promise<void> {
    await deleteRangePendingLegsForBasket(
      this.supabase,
      { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
      reason,
    )
    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        action: 'virtual_pending_cancelled',
        status: 'info',
        request_payload: {
          leg_id: leg.id,
          step_idx: leg.step_idx,
          symbol: leg.symbol,
          reason,
          claimed_by: this.hostId,
        } as unknown as Record<string, unknown>,
      })
    } catch {
      // Logging failure is non-fatal.
    }
  }

  private async getSymbolParams(uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    const api = apiForMetaapiAccount(this.platformByUuid, uuid)
    if (!api) return null
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && (Date.now() - cached.loadedAt) < SYMBOL_TTL_MS) return cached
    try {
      const p: SymbolParams = await api.symbolParams(uuid, symbol)
      const n = normalizeSymbolParams(p)
      const entry: SymbolCacheEntry = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        minLot: n.minLot ?? 0.01,
        lotStep: n.lotStep ?? 0.01,
        contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
        stopsLevel: Math.max(0, n.stopsLevel ?? 0),
        freezeLevel: Math.max(0, n.freezeLevel ?? 0),
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

  /**
   * Final safety pass after `clampOrderStops`. If the clamped TP/SL is still on
   * the wrong side of the live reference price for the order's direction (which
   * happens when the broker's real stops_level is larger than `/SymbolParams`
   * reports, or when the signal TP was reached before our leg fired), drop the
   * bad side instead of sending a guaranteed-rejected order.
   */
  private sanitizeStops(args: OrderSendArgs, refPrice: number): { args: OrderSendArgs; notes: string[] } {
    if (!Number.isFinite(refPrice) || refPrice <= 0) return { args, notes: [] }
    const notes: string[] = []
    const isBuy = String(args.operation) === 'Buy'
    let sl = Number(args.stoploss) || 0
    let tp = Number(args.takeprofit) || 0
    if (isBuy) {
      // Buy: TP must sit ABOVE ref, SL must sit BELOW ref.
      if (tp > 0 && tp <= refPrice) {
        notes.push(`tp ${tp} <= ref ${refPrice} (wrong side for Buy) → dropping TP`)
        tp = 0
      }
      if (sl > 0 && sl >= refPrice) {
        notes.push(`sl ${sl} >= ref ${refPrice} (wrong side for Buy) → dropping SL`)
        sl = 0
      }
    } else {
      // Sell: TP must sit BELOW ref, SL must sit ABOVE ref.
      if (tp > 0 && tp >= refPrice) {
        notes.push(`tp ${tp} >= ref ${refPrice} (wrong side for Sell) → dropping TP`)
        tp = 0
      }
      if (sl > 0 && sl <= refPrice) {
        notes.push(`sl ${sl} <= ref ${refPrice} (wrong side for Sell) → dropping SL`)
        sl = 0
      }
    }
    if (notes.length === 0) return { args, notes }
    return { args: { ...args, stoploss: sl, takeprofit: tp }, notes }
  }

  /**
   * Send a market order; if the broker rejects with "Invalid stops" despite our
   * clamp/sanitize passes, retry once with SL=0 and TP=0 so the leg actually
   * opens. The user has explicitly opted into averaging-down by enabling range
   * trading — opening the leg without stops is strictly preferable to silently
   * dropping it. Subsequent SL/TP management can be done by the signal-modify
   * flow once the position is on the books.
   */
  private async sendWithStopsFallback(
    leg: PendingRow,
    args: OrderSendArgs,
  ): Promise<{ ticket?: number; openPrice?: number; lots?: number; stopLoss?: number; takeProfit?: number }> {
    const api = apiForMetaapiAccount(this.platformByUuid, leg.metaapi_account_id)
    if (!api) throw new Error('api unavailable')
    try {
      return await api.orderSend(leg.metaapi_account_id, args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isInvalidStops = /invalid\s+stops/i.test(msg)
      const hasStops = (Number(args.stoploss) || 0) > 0 || (Number(args.takeprofit) || 0) > 0
      if (isInvalidStops && hasStops) {
        console.warn(
          `[virtualPendingMonitor] retry without stops leg=${leg.id} signal=${leg.signal_id} stepIdx=${leg.step_idx} reason="${msg}" (sl=${args.stoploss} tp=${args.takeprofit})`,
        )
        const fallback: OrderSendArgs = { ...args, stoploss: 0, takeprofit: 0 }
        return await api.orderSend(leg.metaapi_account_id, fallback)
      }
      throw err
    }
  }
}
